import {
  completionGateIds,
  completionGuidance,
  createEntityStore,
  submissionDigest,
  type ExecutionV1,
  type WriteReceiptDraft,
} from "../../kernel/src/index.ts";
import { isRuntimeEvent } from "./runtime-spawn-errors.ts";
import { readDispatchStream } from "./dispatch-stream.ts";
import { readAgentDeclarationResolution } from "./agent-entities.ts";
import { authorizeRepoCellAction } from "./repo-cell-authorization.ts";
import { reviewDispatchIds, reviewDispatchPrompt } from "./task-review-dispatch.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, Snapshot } from "./repo-cell-types.ts";

/** A cut, never a caller/node or current idle provider, owns the canonical root dispatch. */
export function completionReviewKey(taskId: string, execution: ExecutionV1): string {
  const digest = submissionDigest(execution.submission!);
  return `complete-review:${taskId}:${execution.executionId}:${execution.iteration}:${digest}`;
}

export async function dispatchCompletionReview(
  cell: RepoCellOperationalContext,
  snapshot: Snapshot,
  execution: ExecutionV1,
  packagePath: string,
  binding: RepoCellBinding,
  opId: string,
  steps: readonly WriteReceiptDraft[],
): Promise<WriteReceiptDraft> {
  const taskId = snapshot.task!.taskId,
    gates = completionGateIds(snapshot.task!.completionGateIds, execution.submission),
    baseKey = completionReviewKey(taskId, execution),
    dispatchIdsFor = (idempotencyKey: string) => reviewDispatchIds(cell.input.repoId, idempotencyKey);
  const stopped = (action: string, reason: string) =>
    cell.completionStopped(
      opId,
      snapshot,
      execution.executionId,
      {
        code: "review_missing",
        gate: "review",
        next: completionGuidance(snapshot, execution.executionId, action, reason),
      },
      steps,
    );
  // Once the return budget is spent the ledger refuses a changes_requested RecordReview; the cut can
  // still be approved. The receipt must say both instead of promising a verdict that cannot land.
  const returnBudget = snapshot.task!.reviewReturnBudget ?? cell.settings.readRepository().reviewReturnBudget,
    budgetNote =
      snapshot.task!.iteration >= returnBudget
        ? ` Return budget ${String(returnBudget)} is spent at iteration ${String(snapshot.task!.iteration)}: a ` +
          "changes_requested RecordReview will be refused. Amend the submission so the reviewer can " +
          "approve, or escalate to the dispatching principal to raise the review return budget — " +
          `for this task with \`ha task amend ${taskId} --set reviewReturnBudget:<n>\`, or ` +
          "repository-wide with `ha settings update --review-return-budget <n>`."
        : "";
  // Attempt 0 keeps the historical key; each retry appends ":retry<N>". The deterministic opId per
  // key stays the claim fence that makes concurrent completions share one dispatch per attempt.
  let replaced: { readonly dispatchId: string; readonly outcome: string } | null = null;
  for (let attempt = 0; ; attempt += 1) {
    // Termination: attempt strictly increases and the loop exits at the first attempt with no
    // dispatch event; retries are only ever spawned at that first empty attempt slot.
    const attemptKey = attempt === 0 ? baseKey : `${baseKey}:retry${attempt}`,
      ids = dispatchIdsFor(attemptKey),
      existing = cell.store.readEvent(ids.dispatchOpId);
    if (existing && (!isRuntimeEvent(existing) || existing.type !== "runtime_dispatch_requested"))
      throw cell.cellCodedError(
        "runtime_dispatch_conflict",
        `Review dispatch ${ids.dispatchOpId} conflicts with another event.`,
      );
    if (!existing) {
      // Repository-installed declarations shadow bundled product defaults; the executor never becomes the reviewer.
      // The cut's frozen declaration wins over the live repository setting so a settings change
      // never redirects a cut already under review.
      const reviewerId =
        execution.submission!.completionContract?.reviewer?.agentId ??
        cell.settings.readRepository().defaultReviewer ??
        "closeout-reviewer";
      const resolved = readAgentDeclarationResolution({
        rootDir: cell.rootDir,
        agentId: reviewerId,
        entityStore: createEntityStore(cell.store),
      });
      if (!resolved)
        return stopped(
          "ha agent install --source <closeout-reviewer-declaration>",
          `Reviewer ${reviewerId} is not bundled or installed. Install a repository override, or select an available ` +
            "reviewer with ha settings update --default-reviewer <agent-id>, then retry completion.",
        );
      const { declaration: agent, layer } = resolved;
      if (layer === "installed" && !agent.model)
        return stopped(
          "ha agent install --source <closeout-reviewer-declaration>",
          `Declare an explicit model for reviewer ${reviewerId}, then retry completion. ` +
            "Installed reviewer overrides must not select an instance default model.",
        );
      const payload = {
          agentId: agent.id,
          role: "reviewer",
          taskId,
          cwd: { scope: "repo-root" },
          idempotencyKey: attemptKey,
          prompt: reviewDispatchPrompt({
            cell,
            taskId,
            packagePath,
            dispatchId: ids.dispatchId,
            execution,
            gates,
          }),
        },
        revision = cell.store.readHead()?.revision ?? 0,
        authorizationDecision = authorizeRepoCellAction({
          action: { kind: "runtime-spawn", ...payload },
          binding,
          actionId: ids.dispatchOpId,
          revision,
          now: cell.now(),
        });
      if (authorizationDecision.outcome !== "allowed")
        throw cell.cellCodedError("authorization_denied", authorizationDecision.nextActions.join(" "));
      // Already inside the center queue. Only launch admission is awaited; provider completion is not. A cell
      // without a runtime route (no ready instance, no sealed daemon route) stops at the review gate like a
      // missing reviewer would; it must not surface as an indeterminate publication.
      try {
        await cell.runtimeSpawner.spawn(payload, { ...binding, authorizationDecision });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          ![
            "agent_runtime_unavailable",
            "agent_model_unavailable",
            "runtime_model_not_ready",
            "runtime_preconditions_unavailable",
          ].includes(String(error.code))
        )
          throw error;
        return {
          ...stopped(
            "ha runtime instance list",
            layer === "bundled"
              ? `Bundled reviewer ${reviewerId} needs a ready ${agent.runtime_type} runtime instance; configure one, ` +
                  "then retry completion. Its configured default model will be used."
              : `Reviewer ${reviewerId} requires model ${agent.model}; configure a ready compatible instance, ` +
                  "then retry completion. The declared model is not replaced by an instance default.",
          ),
          diagnostic: { kind: "failure", code: String(error.code) },
          rejectionExplanation: error.message,
        };
      }
    }
    // An attempt, together with its provider-fallback continuations, owns the cut while any of its
    // sessions is live or unobserved, or another continuation is scheduled behind a settled one.
    // Receipts always name the attempt's root dispatch so every completion during one attempt's
    // lifetime — including its fallback window — reports the same reviewer identity.
    const waiting = (
      chain: ReturnType<typeof dispatchIdsFor>,
      session: ReturnType<typeof cell.projection.readRuntimeSession>,
    ): WriteReceiptDraft =>
      ({
        ...stopped(
          session && session.outcome === null
            ? `ha runtime status ${chain.runtimeSessionId}`
            : `ha receipt show ${ids.dispatchOpId}`,
          replaced
            ? `Reviewer dispatch ${replaced.dispatchId} ended ${replaced.outcome} without recording a review; ` +
                `replacement dispatch ${ids.dispatchId} owns this submitted cut. Wait for its independent ` +
                "RecordReview, then retry completion." +
                budgetNote
            : `Reviewer dispatch ${ids.dispatchId} owns this submitted cut. Wait for its independent ` +
                "RecordReview, then retry completion." +
                budgetNote,
        ),
        dispatchId: ids.dispatchId,
        runtimeSessionId: ids.runtimeSessionId,
      }) as WriteReceiptDraft;
    const rootSession = cell.projection.readRuntimeSession(ids.runtimeSessionId),
      rootContinuationScheduled = readDispatchStream(cell.rootDir, ids.dispatchId)?.fallbackState === "scheduled";
    if (!rootSession || rootSession.outcome === null || rootContinuationScheduled) return waiting(ids, rootSession);
    for (let fallback = 1; ; fallback += 1) {
      // Termination: fallback continuation keys are contiguous after the attempt key; the scan
      // stops at the first continuation with no dispatch event.
      const chain = dispatchIdsFor(`${attemptKey}:fallback:${fallback}`);
      if (!cell.store.readEvent(chain.dispatchOpId)) break;
      const session = cell.projection.readRuntimeSession(chain.runtimeSessionId),
        continuationScheduled = readDispatchStream(cell.rootDir, chain.dispatchId)?.fallbackState === "scheduled";
      if (!session || session.outcome === null || continuationScheduled) return waiting(chain, session);
    }
    // Every session of the attempt ended without recording a Review: the attempt no longer owns
    // the cut, and the next iteration dispatches a fresh reviewer for the same submission.
    replaced = { dispatchId: ids.dispatchId, outcome: rootSession.outcome };
  }
}
