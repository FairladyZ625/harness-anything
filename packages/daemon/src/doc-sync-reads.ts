import { existsSync } from "node:fs";
import path from "node:path";
import type { TaskProjection } from "../../kernel/src/index.ts";
import {
  canonicalEventCut,
  documentPath,
  resolveDocRoute,
  resolveHarnessLayout,
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

export function readProjectedDocument(projection: TaskProjection, payload: Readonly<Record<string, unknown>>) {
  const taskId = requiredDocSyncText(payload.taskId, "taskId"),
    requested = requiredDocSyncText(payload.path, "path"),
    task = projection.read(taskId);
  if (!task.packagePath) throw docSyncError("task_not_found", `Task ${taskId} has no projected package path.`);
  const read = projection.readDocument(documentPath(`${task.packagePath}/${requested}`));
  return {
    ok: true as const,
    status: read.status,
    taskId,
    path: requested,
    body: read.document?.body ?? "",
    blobSha256: read.document?.blobSha256 ?? null,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
}

/** GUI read repo.tasks.documents.list: projected documents under one task package,
 * with paths relative to the package root. */
export function listProjectedTaskDocuments(
  projection: TaskProjection,
  payload: Readonly<Record<string, unknown>>,
): import("./protocol/daemon-protocol.contract.ts").DaemonTaskDocumentListResult {
  const taskId = requiredDocSyncText(payload.taskId, "taskId"),
    task = projection.read(taskId);
  if (!task.packagePath) throw docSyncError("task_not_found", `Task ${taskId} has no projected package path.`);
  const prefix = `${task.packagePath}/`,
    basis = projection.readReplicaBasis(null),
    documents = basis.documents
      .filter((row) => row.path.startsWith(prefix))
      .map((row) => ({
        path: row.path.slice(prefix.length),
        blobSha256: row.blobSha256,
        size: row.size,
        mediaType: row.mediaType,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  return {
    ok: true,
    status: task.status,
    taskId,
    documents,
    watermark: basis.watermark,
    sourceRevision: basis.sourceRevision,
  };
}
