import type { WriteReceiptDraft } from "@harness-anything/kernel";
import { readTaskDispatches } from "./dispatch-read.ts";
import { reviewExecutionSelection } from "./repo-cell-execution-selection.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

// dec_CF96A3C910B31D2D7498F32DDD/CH3: the owner chooses the provider context; the
// existing spawner still owns admission, the new execution lease and process launch.
export function prepareReturnedWorker(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  taskId: string,
): ReturnType<typeof prepareWorkerContinuation> | null {
  const mode = action.workerMode;
  if (mode === "none") {
    if (action.followUp !== undefined)
      throw cell.cellCodedError(
        "invalid_command",
        "Return with --worker-mode none dispatches no worker, so it takes no --message; put the owner's note in --note.",
      );
    return null;
  }
  if (mode !== "resume" && mode !== "fresh")
    throw cell.cellCodedError(
      "invalid_command",
      "Return requires --worker-mode resume|fresh with --message <text>, or --worker-mode none.",
    );
  return prepareWorkerContinuation(cell, action, taskId, mode);
}

function prepareWorkerContinuation(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  taskId: string,
  mode: "resume" | "fresh",
) {
  const message = cell.requiredCellText(action.followUp, "message"),
    snapshot = cell.projection.read(taskId).snapshot,
    selection = reviewExecutionSelection(action, snapshot, taskId),
    execution = snapshot.executions.find((value) => value.executionId === selection.executionId)!,
    workers = new Set(
      cell.projection
        .readLeaseIntervals(taskId)
        .filter((interval) => interval.executionId === execution.executionId)
        .map((interval) => interval.holder.actor.executor?.id),
    ),
    previous = readTaskDispatches({ projection: cell.projection, taskId }).dispatches.findLast(
      (row) => row.executionId === execution.executionId && workers.has(`runtime-session:${row.runtimeSessionId}`),
    );
  if (mode === "resume" && !previous?.resume)
    throw cell.cellCodedError(
      "runtime_dispatch_not_resumable",
      `Task ${taskId} has no resumable worker dispatch; choose --worker-mode fresh.`,
    );
  const submission = execution.submission!,
    agentId = previous?.agentId ?? cell.settings.readRepository().roles?.defaultWorker;
  return {
    mode,
    payload: {
      taskId,
      ...(agentId ? { agentId } : {}),
      ...(mode === "resume" ? { dispatchId: previous!.dispatchId } : {}),
      ...(typeof action.runtimeInstanceId === "string" ? { runtimeInstanceId: action.runtimeInstanceId } : {}),
      ...(typeof action.model === "string" ? { model: action.model } : {}),
      prompt: [
        `Continue task ${taskId}. Read its task package before implementing the owner feedback.`,
        ...(mode === "fresh"
          ? [
              "# Previous submitted conclusion",
              submission.completionClaim,
              "## Verification",
              ...submission.verificationNotes,
              "## Known gaps",
              ...submission.knownGaps,
              "## Residual risks",
              ...submission.residualRisks,
            ]
          : []),
        "# Owner feedback",
        message,
      ].join("\n"),
      dispatchKey: `task-return:${taskId}:${execution.executionId}:${mode}`,
    },
  };
}

export async function dispatchReturnedWorker(
  cell: RepoCellOperationalContext,
  continuation: ReturnType<typeof prepareWorkerContinuation>,
  binding: RepoCellBinding,
  receipt: WriteReceiptDraft,
): Promise<WriteReceiptDraft> {
  const { payload, mode } = continuation;
  try {
    const authorizationDecision = await evaluateRepoCellAction({
      action: { kind: "runtime-spawn", ...payload },
      repoId: cell.input.repoId,
      binding,
      actionId: payload.dispatchKey,
      revision: cell.store.readHead()?.revision ?? 0,
      now: cell.now(),
      readTask: (id) => cell.projection.read(id).snapshot.task,
    });
    if (authorizationDecision.outcome !== "allowed")
      throw cell.cellCodedError("authorization_denied", authorizationDecision.nextActions.join(" "));
    const worktree = await cell.runtimeSpawner.prepareWorktree(payload),
      spawned = await cell.runtimeSpawner.spawn(payload, { ...binding, authorizationDecision }, worktree);
    return { ...receipt, continuation: { mode, ...spawned } } as WriteReceiptDraft;
  } catch (error) {
    // The return is already durable. Preserve the actual launch error and its code,
    // together with the return receipt, so callers never mistake it for a launched worker.
    const failure = cell.failed(receipt.opId, error);
    return { ...receipt, continuation: { mode, ...failure }, steps: [failure] } as WriteReceiptDraft;
  }
}
