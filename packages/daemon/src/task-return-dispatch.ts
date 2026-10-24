import type { ExecutionV1, WriteReceiptDraft } from "@harness-anything/kernel";
import { readTaskDispatches } from "./dispatch-read.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import { reviewReportRelativePath } from "./reviewer-artifact-publication.ts";
import { runtimeErrorCode } from "./runtime-spawn-errors.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

/** The receipt extension a rework continuation contributes to the recorded review's receipt. */
type ReviewReworkStep = { readonly continuation: Readonly<Record<string, unknown>> } & (
  | { readonly next: readonly { readonly command: string; readonly reason: string }[] }
  | { readonly steps: readonly WriteReceiptDraft[] }
);

type ReworkContext = {
  readonly taskId: string;
  /** The execution the review closed as changes_requested. */
  readonly execution: ExecutionV1;
  /** The recorded review verdict record; only its identity and reason reach the worker prompt. */
  readonly review: { readonly reviewId: string; readonly reason: string };
  /** Ledger-relative path of the review report the reviewer registered. */
  readonly reportPath: string;
};

// dec_E369B8616F50A6208B293997E7/CH3: a changes_requested verdict below the repository rework
// budget reopens the implementation round in the same review write; this dispatch continues the
// worker that submitted the returned cut, carrying the review report. The existing spawner still
// owns admission, the new execution lease and process launch.
export async function dispatchReviewRework(
  cell: RepoCellOperationalContext,
  input: ReworkContext & {
    /** The review write's binding; the continuation runs as its principal. */
    readonly binding: RepoCellBinding;
    readonly opId: string;
  },
): Promise<ReviewReworkStep> {
  return dispatchContinuation(cell, input, principalBinding(input.binding));
}

/** The plain-principal view of a session binding: the loop acts on the principal's standing
 * authorization, never on the reviewer session's execution credential. */
function principalBinding(binding: RepoCellBinding): RepoCellBinding {
  return { ...binding, actor: { principal: binding.actor.principal, executor: null } };
}

/**
 * The post-write half of the automatic review loop: after `ha task review-execution` lands, a
 * changes_requested verdict that reopened the implementation round (kernel review transition)
 * gets its rework worker dispatched here, and a verdict that exhausted the repository rework
 * budget names the owner's disposition lanes instead. Any other verdict returns the receipt.
 */
export async function continueReviewRework(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  receipt: WriteReceiptDraft,
): Promise<WriteReceiptDraft> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    reviewId = cell.requiredCellText(action.reviewId, "reviewId"),
    read = cell.projection.read(taskId),
    review = read.snapshot.reviews.find((value) => value.reviewId === reviewId),
    execution = review ? read.snapshot.executions.find((value) => value.executionId === review.executionId) : undefined;
  if (!review || review.verdict !== "changes_requested" || !execution?.submission) return receipt;
  if (read.snapshot.task?.status === "active" && execution.state === "changes_requested") {
    const reportPath = read.packagePath ? reviewReportRelativePath(read.packagePath, reviewId) : null;
    if (reportPath === null) return receipt;
    const step = await dispatchReviewRework(cell, {
      taskId,
      execution,
      review,
      reportPath,
      binding,
      opId: receipt.opId ?? taskId,
    });
    return {
      ...receipt,
      ...step,
      ...("steps" in step
        ? {
            steps: [...((receipt as { readonly steps?: readonly WriteReceiptDraft[] }).steps ?? []), ...step.steps],
          }
        : {}),
    } as WriteReceiptDraft;
  }
  return {
    ...receipt,
    warnings: [
      ...((receipt as { readonly warnings?: readonly string[] }).warnings ?? []),
      `Review ${reviewId} requested changes and the repository rework budget is exhausted; the cut stays at the ` +
        `review gate for the owner: dispose the verdict with ha task review-consent ${taskId} --dispose ${reviewId} ` +
        "--rationale <why>, or supersede the task.",
    ],
  } as WriteReceiptDraft;
}

async function dispatchContinuation(
  cell: RepoCellOperationalContext,
  input: ReworkContext & { readonly binding: RepoCellBinding; readonly opId: string },
  binding: RepoCellBinding,
): Promise<ReviewReworkStep> {
  // One resume attempt, then one fresh fallback: a provider that cannot resume the prior session
  // is not a stop — the fresh session carries the same report (dec_E369B861 CH3 checkpoint).
  for (let attempt = 0; ; attempt += 1) {
    const previous = submittingWorkerDispatch(cell, input.taskId, input.execution.executionId),
      mode = attempt > 0 ? "fresh" : previous?.resume !== undefined ? "resume" : "fresh",
      continuation = prepareWorkerContinuation(cell, input, mode);
    try {
      const authorizationDecision = await evaluateRepoCellAction({
        action: { kind: "runtime-spawn", ...continuation.payload },
        repoId: cell.input.repoId,
        binding,
        actionId: continuation.payload.dispatchKey,
        revision: cell.store.readHead()?.revision ?? 0,
        now: cell.now(),
        readTask: (id) => cell.projection.read(id).snapshot.task,
      });
      if (authorizationDecision.outcome !== "allowed")
        throw cell.cellCodedError("authorization_denied", authorizationDecision.nextActions.join(" "));
      const worktree = await cell.runtimeSpawner.prepareWorktree(continuation.payload),
        spawned = await cell.runtimeSpawner.spawn(
          continuation.payload,
          { ...binding, authorizationDecision },
          worktree,
        );
      return {
        continuation: { mode: continuation.mode, ...spawned },
        next: [
          {
            command: `ha task show ${input.taskId}`,
            reason:
              "the worker was dispatched automatically; monitor its rework execution instead of starting another worker",
          },
        ],
      };
    } catch (error) {
      // The rework round is already durable. Preserve the actual launch error and its code, so
      // the receipt never masquerades as a launched worker; only a rejected resume retries fresh.
      if (attempt === 0 && continuation.mode === "resume" && runtimeErrorCode(error) === "runtime_resume_failed")
        continue;
      const failure = cell.failed(input.opId, error);
      return { continuation: { mode: continuation.mode, ...failure }, steps: [failure] };
    }
  }
}

/** The last dispatch of the execution's lease holders — the session that submitted the cut. */
function submittingWorkerDispatch(
  cell: RepoCellOperationalContext,
  taskId: string,
  executionId: string,
): ReturnType<typeof readTaskDispatches>["dispatches"][number] | undefined {
  const workers = new Set(
    cell.projection
      .readLeaseIntervals(taskId)
      .filter((interval) => interval.executionId === executionId)
      .map((interval) => interval.holder.actor.executor?.id),
  );
  return readTaskDispatches({ projection: cell.projection, taskId }).dispatches.findLast(
    (row) => row.executionId === executionId && workers.has(`runtime-session:${row.runtimeSessionId}`),
  );
}

function prepareWorkerContinuation(cell: RepoCellOperationalContext, input: ReworkContext, mode: "resume" | "fresh") {
  const snapshot = cell.projection.read(input.taskId).snapshot,
    execution = snapshot.executions.find((value) => value.executionId === input.execution.executionId)!,
    previous = submittingWorkerDispatch(cell, input.taskId, input.execution.executionId),
    submission = execution.submission!,
    agentId = previous?.agentId ?? cell.settings.readRepository().roles?.defaultWorker;
  return {
    mode,
    payload: {
      taskId: input.taskId,
      ...(agentId ? { agentId } : {}),
      ...(mode === "resume" && previous?.resume ? { dispatchId: previous.dispatchId } : {}),
      prompt: [
        `Continue task ${input.taskId}. Read its task package before addressing the review findings.`,
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
        "# Review feedback",
        [
          "# Review verdict: changes_requested",
          `Review ${input.review.reviewId} on your submitted cut requested changes: ${input.review.reason}`,
          `Read the full review report with ha doc show --path ${input.reportPath} --raw`,
          "Address the findings, then submit the reworked cut again.",
        ].join("\n"),
      ].join("\n"),
      dispatchKey: `task-return:${input.taskId}:${input.execution.executionId}:${mode}`,
    },
  };
}
