import {
  buildDeliveryCertificate,
  consentedApprovedReviewForExecution,
  isAuditHashAlgorithm,
  isNativeExecution,
  isTaskEvent,
  type CanonicalEventStore,
  type ExecutionV1,
  type ReceiptDiagnostic,
  type TaskCompletedEvent,
  type TaskProjectionQueries,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { QueryAction, QueryBinding } from "./query-ports.ts";

export interface TaskDeliveryCertificateCell {
  readonly input: { readonly repoId: string };
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjectionQueries;
  readonly operationId: (
    action: QueryAction,
    binding: QueryBinding,
    workspaceId: string,
    expectedRevision: number,
  ) => string;
  readonly readResult: (opId: string, value: object, revision: number, worktreeVisible: boolean | null) => WriteReceipt;
  readonly cellCodedError: (code: string, message: string, diagnostic?: ReceiptDiagnostic) => Error;
  readonly requiredCellText: (value: unknown, name: string) => string;
}

export function readTaskDeliveryCertificate(
  cell: TaskDeliveryCertificateCell,
  action: QueryAction,
  binding: QueryBinding,
): WriteReceipt {
  const taskId = cell.requiredCellText(action.taskId, "taskId");
  const rawAlgorithm = typeof action.algorithm === "string" && action.algorithm !== "" ? action.algorithm : "sha256";
  if (!isAuditHashAlgorithm(rawAlgorithm)) {
    throw cell.cellCodedError("audit_algorithm_unsupported", "Delivery certificate --algorithm must be sha256 or sm3.");
  }
  const current = cell.projection.read(taskId);
  const task = current.snapshot.task;
  if (task === null) {
    throw cell.cellCodedError("entity_not_found", `Task ${taskId} does not exist.`);
  }
  if (task.status !== "done") {
    throw cell.cellCodedError(
      "task_not_done",
      `Task ${taskId} has status ${task.status}; delivery-certificate/v1 can only be exported for done tasks.`,
    );
  }
  const completionEventType = "task_completed";
  const completedEvents = cell.store.queryEvents?.({
    type: completionEventType,
    entity: `task/${taskId}`,
    limit: storageReadPolicy.defaultValue.pageSizes.one,
  });
  const completedCandidate = completedEvents?.[0] ?? null;
  if (
    completedCandidate === null ||
    !isTaskEvent(completedCandidate) ||
    completedCandidate.type !== "task_completed" ||
    completedCandidate.taskId !== taskId
  ) {
    throw cell.cellCodedError(
      "task_completion_event_missing",
      `Task ${taskId} is done in projection, but no canonical task_completed event was found.`,
    );
  }
  const completionEvent: TaskCompletedEvent = completedCandidate;
  const execution = resolveCompletedExecution(current.snapshot.executions, completionEvent);
  if (execution === null) {
    throw cell.cellCodedError(
      "task_delivery_execution_missing",
      `Task ${taskId} has no native execution with a frozen submission for delivery-certificate/v1.`,
    );
  }
  const consented = consentedApprovedReviewForExecution(
    current.snapshot.reviews,
    current.snapshot.consents ?? [],
    execution,
    current.snapshot.reviewDispositions ?? [],
  );
  const certificate = buildDeliveryCertificate({
    algorithm: rawAlgorithm,
    repoId: cell.input.repoId,
    task,
    execution,
    reviews: current.snapshot.reviews,
    reviewConsent: consented?.consent ?? null,
    completionEvent,
  });
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, current.sourceRevision),
    {
      schema: "task-delivery-certificate/v1",
      certificate,
    },
    current.sourceRevision,
    null,
  );
}

function resolveCompletedExecution(
  executions: readonly import("@harness-anything/kernel").ProjectedExecution[],
  completionEvent: TaskCompletedEvent,
): ExecutionV1 | null {
  const fromEvent = completionEvent.payload.execution;
  if (fromEvent && fromEvent.schema === "execution/v1" && fromEvent.submission !== null) {
    return fromEvent;
  }
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const candidate = executions[index]!;
    if (isNativeExecution(candidate) && candidate.state === "accepted" && candidate.submission !== null) {
      return candidate;
    }
  }
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const candidate = executions[index]!;
    if (isNativeExecution(candidate) && candidate.submission !== null) {
      return candidate;
    }
  }
  return null;
}
