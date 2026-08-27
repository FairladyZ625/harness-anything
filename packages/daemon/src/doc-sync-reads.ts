import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { TaskProjection } from "../../kernel/src/index.ts";
import {
  canonicalEventCut,
  documentPath,
  resolveDocRoute,
  resolveHarnessLayout,
  sha256Bytes,
  stableStringify,
  type DocEventV1,
  type DocSyncReceiptDetail,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import { scannerRead } from "./doc-sync-adjudication.ts";
import type { DocSettlementReceipt, Input } from "./doc-sync-command-actions.ts";
import { directPaths, holder, observe, readDetail } from "./doc-sync-details.ts";
import {
  docSyncError,
  hasExactDocSyncActionFields,
  localProseSource,
  proof,
  rejectDocSyncAction,
  requiredDocSyncText,
} from "./doc-sync-files.ts";
import { scanReceipt, scopeTouches } from "./doc-sync-settlement.ts";

export function readAction(input: Input): WriteReceipt {
  if (input.action.kind !== "doc-show") {
    const scan = scannerRead(input);
    return scanReceipt(input, scan);
  }
  const rawPaths = input.action.kind === "doc-show" ? [input.action.path] : input.action.paths;
  if (
    !hasExactDocSyncActionFields(
      input.action,
      input.action.kind === "doc-show" ? ["kind", "path"] : ["kind", "paths"],
    ) ||
    !Array.isArray(rawPaths) ||
    !rawPaths.length ||
    rawPaths.some((item) => typeof item !== "string")
  )
    throw docSyncError("invalid_command", `${input.action.kind} requires valid doc-sync paths`);
  let paths;
  try {
    paths = rawPaths.map((item) => documentPath(String(item)));
  } catch {
    throw docSyncError("invalid_command", `${input.action.kind} requires valid doc-sync paths`);
  }
  if (!directPaths(input.rootDir, paths) || paths.some((candidate) => !resolveDocRoute(candidate).allowed))
    throw docSyncError("invalid_command", `${input.action.kind} requires valid doc-sync paths`);
  const current = input.store.currentCut(),
    lease =
      input.binding.assignmentScope?.scope.kind === "task"
        ? input.projection.currentLeaseForExecution(input.binding.assignmentScope.scope.executionId, input.now())
        : null;
  const scope = scopeTouches(input, paths);
  if (scope.length)
    return rejectDocSyncAction(
      `read:${input.action.kind}:${current.headDigest}`,
      "assignment_scope_mismatch",
      readDetail(input, paths, current, lease, scope),
      "read only paths in the authenticated assignment scope",
    );
  const reads = paths.map((candidate) => input.projection.readDocument(candidate)),
    revision = input.store.readHead()?.revision ?? 0,
    ready = reads.every((read) => read.status === "ready");
  const receiptDetail = readDetail(input, paths, current, lease, []),
    worktreeVisible = observe(
      input.rootDir,
      input.binding.source,
      reads.map((read) => read.document),
    );
  if (input.action.kind === "doc-show" && ready && reads[0]?.document === null)
    return rejectDocSyncAction(
      `read:doc-show:${current.headDigest}`,
      "document_not_found",
      receiptDetail,
      "sync the document before showing it",
    );
  const evidence =
    input.action.kind === "doc-show"
      ? (reads[0]?.document?.body ?? "document:not-found")
      : `document-cut:${current.headDigest}`;
  return ready
    ? {
        outcome: "applied",
        opId: `read:${input.action.kind}:${current.headDigest}`,
        revision,
        evidence,
        visibility: "center",
        proof: proof(revision, revision, true, worktreeVisible),
        detail: receiptDetail,
      }
    : {
        outcome: "pending",
        opId: `read:${input.action.kind}:${current.headDigest}`,
        revision,
        evidence,
        visibility: "center",
        proof: proof(revision, Math.min(...reads.map((read) => read.watermark)), false, worktreeVisible),
        detail: receiptDetail,
        nextAction: receiptDetail.nextAction,
      };
}

export function readDocReceipt(input: Omit<Input, "action">, event: DocEventV1): DocSettlementReceipt {
  const retirement = event.payload.retirementReason === undefined ? null : event.payload.changes[0]!,
    reads = event.payload.changes.map((change) => input.projection.readDocument(change.path)),
    canonicalVisible = reads.every((read, index) => {
      const candidate = event.payload.changes[index]!.candidate;
      return (
        read.status === "ready" &&
        (candidate === null ? read.document === null : read.document?.blobSha256 === candidate.sha256) &&
        read.watermark >= event.workspaceRevision
      );
    }),
    appliedCut = Math.min(...reads.map((read) => read.watermark)),
    current = input.store.currentCut(),
    lease =
      event.payload.executionId === null
        ? null
        : input.projection.currentLeaseForExecution(event.payload.executionId, input.now());
  const receiptDetail: DocSyncReceiptDetail = {
    kind: "doc_sync",
    code: canonicalVisible ? (retirement === null ? "applied" : "retired") : "projection_pending",
    baseLedgerSha: event.payload.baseLedgerSha,
    currentLedgerSha: current,
    paths: event.payload.changes.map((change, index) => ({
      path: change.path,
      baseBlobSha256: change.baseBlobSha256,
      currentBlobSha256: reads[index]?.document?.blobSha256 ?? null,
      candidateBlobSha256: change.candidate?.sha256 ?? null,
    })),
    holder: holder(lease),
    differences: [],
    unresolvedTouches: [],
    deletions:
      retirement === null
        ? []
        : [
            {
              path: retirement.path,
              baseBlobSha256: retirement.baseBlobSha256!,
              source: "intent",
            },
          ],
    nextAction: canonicalVisible ? "no action required" : `run ha receipt show ${event.opId} after projection catch-up`,
  };
  const retirementReceipt =
      retirement === null
        ? null
        : {
            schema: "doc-retirement-receipt/v1",
            path: retirement.path,
            baseBlobSha256: retirement.baseBlobSha256,
            reason: event.payload.retirementReason,
          },
    worktreeVisible =
      retirement === null
        ? observe(
            input.rootDir,
            input.binding.source,
            reads.map((read) => read.document),
          )
        : localProseSource(input.binding.source)
          ? !existsSync(path.join(resolveHarnessLayout(input.rootDir).authoredRoot, ...retirement.path.split("/")))
          : null;
  const common = {
    opId: event.opId,
    revision: event.workspaceRevision,
    evidence:
      retirementReceipt === null
        ? `event-object:${event.opId}`
        : `doc-retirement:${stableStringify(retirementReceipt)}`,
    visibility: "center" as const,
    proof: proof(event.workspaceRevision, appliedCut, canonicalVisible, worktreeVisible),
    detail: receiptDetail,
  };
  const settlement = canonicalVisible ? ("applied" as const) : ("pending" as const),
    materialized = input.store.publication(event),
    identity = {
      commitSha: materialized.commitSha?.sha ?? null,
      cut: canonicalEventCut(current.repoId, event),
      settlement,
      receiptId: event.opId,
    };
  return canonicalVisible
    ? { outcome: "applied", ...common, ...identity }
    : {
        outcome: "pending",
        ...common,
        ...identity,
        nextAction: receiptDetail.nextAction,
      };
}

export function readProjectedDocument(
  rootDir: string,
  projection: TaskProjection,
  payload: Readonly<Record<string, unknown>>,
) {
  const taskId = requiredDocSyncText(payload.taskId, "taskId"),
    requested = requiredDocSyncText(payload.path, "path"),
    task = projection.read(taskId);
  if (!task.packagePath) throw docSyncError("task_not_found", `Task ${taskId} has no projected package path.`);
  const read = projection.readDocument(documentPath(`${task.packagePath}/${requested}`)),
    packageRoot = taskPackageWorktreeRoot(rootDir, task.packagePath),
    worktree = readWorktreeDocument(packageRoot, requested);
  return {
    ok: true as const,
    status: read.status,
    taskId,
    path: requested,
    body: read.document?.body ?? "",
    blobSha256: read.document?.blobSha256 ?? null,
    // Live worktree view (task_e5defe69): the GUI file surface must show what is on disk
    // now, not only the committed projection — an edited-but-unsynced plan is real work
    // and must be visible and explicitly marked as not yet committed.
    worktreeBody: worktree?.body ?? null,
    worktreeBlobSha256: worktree?.blobSha256 ?? null,
    uncommitted: worktree !== null && worktree.blobSha256 !== (read.document?.blobSha256 ?? null),
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
}

/** GUI read repo.tasks.documents.list: projected documents under one task package,
 * with paths relative to the package root. Files that exist only in the worktree (created
 * but never doc-synced) are listed too, flagged uncommitted, so they are visible at all. */
export function listProjectedTaskDocuments(
  rootDir: string,
  projection: TaskProjection,
  payload: Readonly<Record<string, unknown>>,
): import("./protocol/daemon-protocol.contract.ts").DaemonTaskDocumentListResult {
  const taskId = requiredDocSyncText(payload.taskId, "taskId"),
    task = projection.read(taskId);
  if (!task.packagePath) throw docSyncError("task_not_found", `Task ${taskId} has no projected package path.`);
  const prefix = `${task.packagePath}/`,
    basis = projection.readReplicaBasis(null),
    worktree = worktreeDocumentIndex(taskPackageWorktreeRoot(rootDir, task.packagePath)),
    worktreeByPath = new Map(worktree.map((row) => [row.path, row])),
    documents = [
      ...basis.documents
        .filter((row) => row.path.startsWith(prefix))
        .map((row) => {
          const relative = row.path.slice(prefix.length),
            live = worktreeByPath.get(relative);
          return {
            path: relative,
            blobSha256: row.blobSha256,
            size: row.size,
            mediaType: row.mediaType,
            uncommitted: live !== undefined && live.blobSha256 !== row.blobSha256,
          };
        }),
      ...worktree.filter((row) => !basis.documents.some((projected) => projected.path === `${prefix}${row.path}`)),
    ].sort((left, right) => left.path.localeCompare(right.path));
  return {
    ok: true,
    status: task.status,
    taskId,
    documents,
    watermark: basis.watermark,
    sourceRevision: basis.sourceRevision,
  };
}

const worktreeDocumentMaxBytes = 2 * 1024 * 1024,
  worktreeDocumentMaxEntries = 2000,
  worktreeDocumentExtensions = new Set([".md", ".json", ".yaml", ".yml", ".txt", ".html", ".htm"]);

type WorktreeDocumentRow = {
  readonly path: string;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly uncommitted: true;
};

/** Task packages live under the authored harness root (harness/tasks/<package>), which is
 * where doc-sync writes and where the live working copy the GUI must show resides. */
function taskPackageWorktreeRoot(rootDir: string, packagePath: string): string | null {
  const authoredRoot = path.resolve(resolveHarnessLayout(rootDir).authoredRoot),
    packageRoot = path.resolve(authoredRoot, packagePath);
  return packageRoot.startsWith(`${authoredRoot}${path.sep}`) ? packageRoot : null;
}

function resolveWorktreeDocumentPath(packageRoot: string | null, relative: string): string | null {
  if (packageRoot === null || statLinkSync(packageRoot)?.isSymbolicLink()) return null;
  const target = path.resolve(packageRoot, relative);
  if (target !== packageRoot && !target.startsWith(`${packageRoot}${path.sep}`)) return null;
  let cursor = packageRoot;
  for (const segment of path.relative(packageRoot, target).split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (statLinkSync(cursor)?.isSymbolicLink()) return null;
  }
  return target;
}

function worktreeDocumentMediaType(relative: string): string {
  const extension = path.extname(relative).toLowerCase();
  return extension === ".json"
    ? "application/json"
    : extension === ".html" || extension === ".htm"
      ? "text/html"
      : extension === ".yaml" || extension === ".yml"
        ? "application/yaml"
        : extension === ".md"
          ? "text/markdown"
          : "text/plain";
}

/** One live file from the task package's working copy, or null when it is absent. */
function readWorktreeDocument(
  packageRoot: string | null,
  relative: string,
): { readonly body: string; readonly blobSha256: string } | null {
  const target = resolveWorktreeDocumentPath(packageRoot, relative);
  if (target === null) return null;
  const stat = statFileSync(target);
  if (stat === null || !stat.isFile() || stat.size > worktreeDocumentMaxBytes) return null;
  const bytes = readFileSync(target);
  return { body: bytes.toString("utf8"), blobSha256: sha256Bytes(bytes) };
}

/** Document-shaped files currently on disk under the task package. The worktree is the
 * truth for "what exists now"; the projection is the truth for "what is committed". */
function worktreeDocumentIndex(packageRoot: string | null): readonly WorktreeDocumentRow[] {
  if (packageRoot === null) return [];
  const root = packageRoot,
    rows: WorktreeDocumentRow[] = [];
  if (!existsSync(root) || statLinkSync(root)?.isSymbolicLink() || !statFileSync(root)?.isDirectory()) return rows;
  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0 && rows.length < worktreeDocumentMaxEntries && visited < worktreeDocumentMaxEntries * 4) {
    const directory = queue.shift()!;
    let entries: readonly import("node:fs").Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (entry.name.startsWith(".")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(target);
        continue;
      }
      if (!entry.isFile() || !worktreeDocumentExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = statFileSync(target);
      if (stat === null || stat.size > worktreeDocumentMaxBytes) continue;
      const bytes = readFileSync(target);
      rows.push({
        path: path.relative(root, target).split(path.sep).join("/"),
        blobSha256: sha256Bytes(bytes),
        size: stat.size,
        mediaType: worktreeDocumentMediaType(entry.name),
        uncommitted: true,
      });
    }
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

function statFileSync(target: string): import("node:fs").Stats | null {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

function statLinkSync(target: string): import("node:fs").Stats | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}
