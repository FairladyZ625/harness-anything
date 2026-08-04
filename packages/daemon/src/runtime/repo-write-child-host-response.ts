import type { RepoWriteChildResponseWriter } from "./repo-write-child-response-writer.ts";
import type { RepoWriteHostedOperationSnapshot } from "./repo-write-child-lookup.ts";

export interface RepoWriteChildOperationResponseState {
  readonly requestId: string;
  readonly opId?: string;
  readonly state: RepoWriteHostedOperationSnapshot;
}

export async function sendRepoWriteDuplicateSubmit(
  responses: RepoWriteChildResponseWriter,
  operation: RepoWriteChildOperationResponseState
): Promise<void> {
  if (operation.opId && ["proceeding", "terminal", "unknown"].includes(operation.state.phase)) {
    await responses.unknown(
      operation.requestId,
      operation.opId,
      "DUPLICATE_REQUEST",
      "request already crossed the proceed boundary"
    );
    return;
  }
  await responses.notStarted(
    operation.requestId,
    "DUPLICATE_REQUEST",
    "requestId is already admitted",
    operation.opId
  );
}

export async function sendRepoWriteRejectedProceed(
  responses: RepoWriteChildResponseWriter,
  operation: RepoWriteChildOperationResponseState | undefined,
  requestId: string,
  code: string,
  diagnostic: string
): Promise<void> {
  if (operation?.opId && ["proceeding", "terminal", "unknown"].includes(operation.state.phase)) {
    await responses.unknown(requestId, operation.opId, code, diagnostic);
    return;
  }
  await responses.notStarted(requestId, code, diagnostic, operation?.opId);
}

export async function sendRepoWriteRepeatedProceed(
  responses: RepoWriteChildResponseWriter,
  operation: RepoWriteChildOperationResponseState
): Promise<void> {
  if (operation.state.phase === "terminal") {
    await responses.terminal(
      operation.requestId,
      operation.opId!,
      operation.state.outcome,
      operation.state.receipt
    );
    return;
  }
  if (operation.state.phase === "proceeding" || operation.state.phase === "unknown") {
    await responses.unknown(
      operation.requestId,
      operation.opId!,
      "DUPLICATE_PROCEED",
      "operation already crossed the proceed boundary"
    );
    return;
  }
  await responses.notStarted(
    operation.requestId,
    operation.state.phase === "preparing" ? "NOT_PREPARED" : "OPERATION_NOT_PROCEEDABLE",
    "operation is not in prepared state",
    operation.opId
  );
}
