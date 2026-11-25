import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  classifyRawArtifactPath,
  consumeKnownError,
  leaseIsEffective,
  RAW_ARTIFACT_MEDIA_TYPE,
  resolveHarnessLayout,
  sha256Bytes,
  worktreeDocumentMediaType,
  type DocEventV1,
  type TaskProjection,
  type TaskProjectionQueries,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import {
  cutOfWorktree,
  listProjectedTaskDocuments as listApplicationProjectedTaskDocuments,
  readDocAction,
  readDocReceipt as readApplicationDocReceipt,
  readProjectedDocument as readApplicationProjectedDocument,
  TASK_DOCUMENT_INLINE_BYTES_MAX,
  type DocumentCut,
  type ObservedDocumentRow,
  type ProjectedDocumentReadContext as ApplicationProjectedDocumentReadContext,
  type WorktreeDocumentRow,
} from "@harness-anything/application/internal/queries/doc-sync-reads.ts";
import { scannerRead } from "./doc-sync-adjudication.ts";
import type { DocSettlementReceipt, Input } from "./doc-sync-command-actions.ts";
import { directPaths, observe } from "./doc-sync-details.ts";
import { scanReceipt } from "./doc-sync-settlement.ts";
import {
  presetSnapshotReader,
  readTaskWorktreeExecutionBinding,
  taskLeaseAcquiredRevision,
  taskWorktreeBinding,
} from "./task-worktree.ts";
import { taskWorktreeRoot } from "./task-worktree-candidates.ts";
import { worktreeAuthoredRelative } from "./worktree-setup.ts";
import { readAuthoredDocumentBytes } from "./authored-document-read-port.ts";

export {
  TASK_DOCUMENT_INLINE_BYTES_MAX,
  type CanonicalDocumentVersion,
  type ExecutionObservationBinding,
  type ProjectedDocumentSource,
  type ProjectedDocumentSyncState,
} from "@harness-anything/application/internal/queries/doc-sync-reads.ts";

export type ProjectedDocumentReadContext = Omit<ApplicationProjectedDocumentReadContext, "local">;

export function readAction(input: Input): WriteReceipt {
  return readDocAction(input, {
    scannerRead: () => scanReceipt(input, scannerRead(input)),
    directPaths: (paths) => directPaths(input.rootDir, paths),
    observe: (documents) => observe(input.rootDir, input.binding.source, documents),
  });
}

export function readDocReceipt(input: Omit<Input, "action">, event: DocEventV1): DocSettlementReceipt {
  const authoredRoot = resolveHarnessLayout(input.rootDir).authoredRoot;
  return readApplicationDocReceipt(input, event, {
    observe: (documents) => observe(input.rootDir, input.binding.source, documents),
    worktreePathMissing: (logicalPath) => !existsSync(path.join(authoredRoot, ...logicalPath.split("/"))),
  });
}

export function readProjectedDocument(
  context: ProjectedDocumentReadContext,
  payload: Readonly<Record<string, unknown>>,
) {
  return readApplicationProjectedDocument(
    {
      ...context,
      local: {
        readAuthoredCopy: (packagePath, requested, binary) =>
          readWorktreeDocument(taskPackageWorktreeRoot(context.rootDir, packagePath), requested, binary),
        observeExecution: (ctx, task, packagePath, requested, binary, executionId) =>
          observeExecution(ctx, task, packagePath, requested, binary, executionId),
        leaseAcquiredRevision: taskLeaseAcquiredRevision,
      },
    },
    payload,
  );
}

export function listProjectedTaskDocuments(
  rootDir: string,
  projection: TaskProjection,
  payload: Readonly<Record<string, unknown>>,
): import("./protocol/daemon-protocol.contract.ts").DaemonTaskDocumentListResult {
  return listApplicationProjectedTaskDocuments(projection, payload, {
    listWorktreeDocuments: (packagePath) =>
      worktreeDocumentIndex(taskPackageWorktreeRoot(rootDir, packagePath), packagePath),
  });
}

/** A read-time observation of one execution's workspace. Bounded by the execution's effective local lease. */
function observeExecution(
  context: ApplicationProjectedDocumentReadContext,
  task: ReturnType<TaskProjectionQueries["read"]> & { readonly packagePath: string },
  packagePath: string,
  requested: string,
  binary: boolean,
  executionId: string,
): { readonly cut: DocumentCut; readonly acquiredRevision: number } | { readonly reason: string } {
  const execution = task.snapshot.executions.find((candidate) => candidate.executionId === executionId);
  if (execution === undefined) return { reason: "execution_not_found" };
  const lease = task.snapshot.lease;
  if (lease === null || !leaseIsEffective(lease) || lease.executionId !== executionId)
    return { reason: "execution_not_leased" };
  if (execution.state !== "active") return { reason: "execution_not_active" };
  if (lease.source !== "local") return { reason: "execution_owner_not_local" };
  const workspace = executionWorkspaceRoot(context, task, packagePath);
  if (workspace.root === null || workspace.worktreeRoot === null) return { reason: workspace.reason };
  const marker = readTaskWorktreeExecutionBinding(workspace.worktreeRoot, executionId);
  if (marker.invalid) return { reason: "execution_workspace_marker_invalid" };
  if (
    marker.binding === null ||
    marker.binding.taskId !== task.snapshot.task?.taskId ||
    marker.binding.executionId !== executionId
  )
    return { reason: "execution_workspace_unbound" };
  const row = readWorktreeDocument(workspace.root, requested, binary);
  if (row === null) return { reason: "document_not_observed" };
  return {
    cut: cutOfWorktree(row, requested, binary),
    acquiredRevision: marker.binding.acquiredRevision,
  };
}

function executionWorkspaceRoot(
  context: ApplicationProjectedDocumentReadContext,
  task: ReturnType<TaskProjectionQueries["read"]> & { readonly packagePath: string },
  packagePath: string,
): { readonly root: string | null; readonly worktreeRoot: string | null; readonly reason: string } {
  if (taskWorktreeBinding(task.snapshot.task, presetSnapshotReader(context.projection)) === null)
    return { root: null, worktreeRoot: null, reason: "execution_workspace_unavailable" };
  const taskRoot = taskWorktreeRoot(context, task.snapshot);
  if (taskRoot === null) return { root: null, worktreeRoot: null, reason: "execution_workspace_not_materialized" };
  const relative = worktreeAuthoredRelative(resolveHarnessLayout(context.rootDir));
  return {
    root: path.resolve(taskRoot, relative, ...packagePath.split("/")),
    worktreeRoot: taskRoot,
    reason: "",
  };
}

const worktreeDocumentMaxBytes = TASK_DOCUMENT_INLINE_BYTES_MAX,
  worktreeDocumentMaxEntries = 2000;

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

function readWorktreeDocument(
  packageRoot: string | null,
  relative: string,
  binary: boolean,
): ObservedDocumentRow | null {
  const target = resolveWorktreeDocumentPath(packageRoot, relative);
  if (target === null) return null;
  const stat = statFileSync(target);
  if (stat === null || !stat.isFile() || stat.size > worktreeDocumentMaxBytes) return null;
  const bytes = Buffer.from(readAuthoredDocumentBytes(packageRoot!, relative));
  return {
    body: binary ? null : bytes.toString("utf8"),
    bytes,
    blobSha256: sha256Bytes(bytes),
    size: bytes.byteLength,
    mediaType: binary ? RAW_ARTIFACT_MEDIA_TYPE : worktreeDocumentMediaType(relative),
  };
}

function worktreeDocumentIndex(packageRoot: string | null, packagePath: string): readonly WorktreeDocumentRow[] {
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
    } catch (error) {
      consumeKnownError(error);
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
      const relative = path.relative(root, target).split(path.sep).join("/"),
        mediaType =
          worktreeDocumentMediaType(entry.name) ?? classifyRawArtifactPath(`${packagePath}/${relative}`)?.mediaType,
        stat = mediaType === undefined || !entry.isFile() ? null : statFileSync(target);
      if (mediaType === undefined || mediaType === null || stat === null || stat.size > worktreeDocumentMaxBytes)
        continue;
      const bytes = Buffer.from(readAuthoredDocumentBytes(root, relative));
      rows.push({
        path: relative,
        blobSha256: sha256Bytes(bytes),
        size: stat.size,
        mediaType,
        uncommitted: true,
      });
    }
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

export function statFileSync(target: string): import("node:fs").Stats | null {
  try {
    return statSync(target);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

export function statLinkSync(target: string): import("node:fs").Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
