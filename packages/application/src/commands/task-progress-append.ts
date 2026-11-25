import {
  canStartExecution,
  compileTaskProgress,
  isTaskProgressEvent,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionIdFromActor,
  sha256Text,
  stableStringify,
  taskProgressWritePlan,
  type CanonicalEventAppendReceipt,
  type DocEventChange,
  type EventPublicationKillpoint,
  type TaskProgressEventV1,
  type TaskProgressEvidence,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type { CommandAction, CommandBinding, CommandOperationPort, PublicPublication } from "./command-ports.ts";

/** Write-side port for one progress append. Every read is a projection or canonical-store read, so
 *  a local RepoCell and a cloud writer shard drive the same validation and event compilation. */
export interface TaskProgressCommandCell extends CommandOperationPort {
  readonly input: { readonly repoId: string; readonly killpoint?: (point: EventPublicationKillpoint) => void };
  readonly progressReceipt: (event: TaskProgressEventV1, publication: PublicPublication) => WriteReceiptDraft;
  readonly publicPublication: (value: Pick<CanonicalEventAppendReceipt, "commitSha" | "cut">) => PublicPublication;
}

/** Task documents an edge carries with the progress command, adjudicated in the same append. */
export interface CarriedTaskDocuments {
  readonly changes: readonly DocEventChange[];
  readonly blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[];
}

export function appendProgress(
  cell: TaskProgressCommandCell,
  action: CommandAction,
  binding: CommandBinding,
  carried: CarriedTaskDocuments | null = null,
): WriteReceiptDraft {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    task = cell.projection.read(taskId),
    expectedRevision = task.snapshot.revision,
    opId = cell.operationId(action, binding, cell.input.repoId, expectedRevision),
    existing = cell.store.readEvent(opId);
  if (existing) {
    if (!isTaskProgressEvent(existing))
      throw cell.cellCodedError("op_conflict", `opId ${opId} belongs to another event`);
    if (stableStringify(existing.payload.carriedDocumentClaims ?? null) !== stableStringify(carried?.changes ?? null))
      throw cell.cellCodedError("op_conflict", `opId ${opId} already carries different task documents`);
    return cell.progressReceipt(existing, cell.publicPublication(cell.store.publication(existing)));
  }
  if (task.watermark < task.sourceRevision || !task.snapshot.task || !task.packagePath)
    throw cell.cellCodedError("content_not_ready", `Task ${taskId} is not ready for progress append.`);
  const at = cell.now(),
    lease = cell.projection.currentLease(taskId, at),
    executionId =
      typeof action.executionId === "string"
        ? action.executionId
        : (lease?.executionId ??
          task.snapshot.executions.findLast((value) => value.iteration === task.snapshot.task?.iteration)
            ?.executionId ??
          ""),
    recoveryExecutionId =
      lease?.executionId ??
      task.snapshot.executions.find(
        (value) => value.iteration === task.snapshot.task?.iteration && value.state === "active",
      )?.executionId ??
      "progress-recovery",
    recoverySnapshot = lease?.phase === "orphaned" ? { ...task.snapshot, lease: null } : task.snapshot,
    runtimeSessionId = runtimeSessionIdFromActor(binding.actor),
    runtimeSession = runtimeSessionId === null ? null : cell.projection.readRuntimeSession(runtimeSessionId),
    runtimeBinding = resolveTaskBoundRuntimeBinding(runtimeSession, taskId, executionId),
    progressPath = `${task.packagePath}/progress.md`,
    document = cell.projection.readDocument(progressPath);
  if (document.watermark < document.sourceRevision)
    throw cell.cellCodedError("content_not_ready", `Progress projection for ${taskId} is not ready.`);
  const compiled = compileTaskProgress({
    taskId,
    executionId,
    packagePath: task.packagePath,
    text: cell.requiredCellText(action.text, "text"),
    evidence: parseProgressEvidence(cell, action.evidence),
    ...(typeof action.baseDocumentSha256 === "string" || action.baseDocumentSha256 === null
      ? { expectedBaseSha256: action.baseDocumentSha256 }
      : {}),
    currentDocument:
      document.document && document.document.path === progressPath
        ? {
            path: progressPath,
            blobSha256: document.document.blobSha256,
            body: document.document.body,
          }
        : null,
    activeLease: lease,
    startRecoveryAvailable: canStartExecution(recoverySnapshot, recoveryExecutionId),
    ...(runtimeBinding ? { runtimeBinding } : {}),
    asOwner: action.asOwner === true,
    taskCreatedBy: task.snapshot.task.createdBy,
    taskClass: task.snapshot.task.taskClass,
    actor: binding.actor,
    source: binding.source,
    eventId: `event-${sha256Text(opId)}`,
    opId,
    workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
    occurredAt: at,
  });
  const event =
      carried === null
        ? compiled.event
        : ({
            ...compiled.event,
            payload: {
              ...compiled.event.payload,
              carriedDocumentClaims: carried.changes,
            },
          } as TaskProgressEventV1),
    plan = carried === null ? compiled.plan : taskProgressWritePlan(event),
    blobs = carried === null ? compiled.blobs : [...compiled.blobs, ...carried.blobs];
  const appended = cell.store.append({ event, plan, blobs });
  cell.input.killpoint?.("after_store_commit");
  cell.projection.apply(event, plan);
  const receipt = cell.progressReceipt(event, cell.publicPublication(appended));
  cell.input.killpoint?.("before_response_write");
  cell.input.killpoint?.("after_response_write");
  return receipt;
}

function parseProgressEvidence(
  cell: Pick<CommandOperationPort, "cellCodedError" | "requiredCellText">,
  value: unknown,
): readonly TaskProgressEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw cell.cellCodedError("invalid_progress", "evidence must be an ordered list");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object")
      throw cell.cellCodedError("invalid_progress", "evidence entries require type, path, and summary");
    const item = entry as Record<string, unknown>;
    return {
      type: cell.requiredCellText(item.type, "evidence.type"),
      path: cell.requiredCellText(item.path, "evidence.path"),
      summary: cell.requiredCellText(item.summary, "evidence.summary"),
    };
  });
}
