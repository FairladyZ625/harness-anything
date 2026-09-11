import { createHash } from "node:crypto";
import {
  completionGuidance,
  createEntityStore,
  submissionDigest,
  type ExecutionV1,
  type WriteReceiptDraft,
} from "../../kernel/src/index.ts";
import { isRuntimeEvent } from "./runtime-spawn-errors.ts";
import { readAgentDeclaration } from "./agent-entities.ts";
import { authorizeRepoCellAction } from "./repo-cell-authorization.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, Snapshot } from "./repo-cell-types.ts";

/** A cut, never a caller/node or current idle provider, owns the canonical root dispatch. */
export function completionReviewKey(taskId: string, execution: ExecutionV1): string {
  return `complete-review:${taskId}:${execution.executionId}:${execution.iteration}:${submissionDigest(execution.submission!)}`;
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
    idempotencyKey = completionReviewKey(taskId, execution),
    hash = createHash("sha256").update(`${cell.input.repoId}\0${idempotencyKey}`).digest("hex"),
    dispatchId = `dispatch_${hash.slice(0, 24)}`,
    runtimeSessionId = `runtime_${hash.slice(24, 48)}`,
    dispatchOpId = `runtime-spawn-${hash.slice(0, 32)}`,
    existing = cell.store.readEvent(dispatchOpId);
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
  if (existing && (!isRuntimeEvent(existing) || existing.type !== "runtime_dispatch_requested"))
    throw cell.cellCodedError(
      "runtime_dispatch_conflict",
      `Review dispatch ${dispatchOpId} conflicts with another event.`,
    );
  if (!existing) {
    // Installed declarations are canonical; a missing default never turns the executor into a reviewer.
    const reviewerId = cell.settings.readRepository().defaultReviewer ?? "closeout-reviewer";
    if (cell.projection.getEntity("agent", reviewerId) === null)
      return stopped(
        "ha agent install --source <closeout-reviewer-declaration-directory>",
        `Install an independent Agent declaration with id ${reviewerId}, or select an installed reviewer with ha settings update --default-reviewer <agent-id>, then retry completion.`,
      );
    const agent = readAgentDeclaration({
        rootDir: cell.rootDir,
        agentId: reviewerId,
        entityStore: createEntityStore(cell.store),
      }),
      report = `${packagePath}/artifacts/reports/${dispatchId}.md`,
      packet = `${packagePath}/artifacts/reports/${dispatchId}.json`,
      payload = {
        agentId: agent.id,
        role: "reviewer",
        taskId,
        cwd: { scope: "repo-root" },
        idempotencyKey,
        prompt: [
          `Independently review task ${taskId}, execution ${execution.executionId}, iteration ${execution.iteration}.`,
          `The exact submission digest is ${submissionDigest(execution.submission!)}; commit ${execution.submission!.commitSha}.`,
          "Read the task plan, closeout, and submitted delivery yourself. Record approved or changes_requested through RecordReview; never infer approval from provider success.",
          `Write this execution's review report to harness/${report} and review input to harness/${packet}. These dispatch-specific paths replace any shared report path in your declaration.`,
          `Register with ha task review-execution ${taskId} --execution-id ${execution.executionId} --review-id review-${dispatchId} --from-file harness/${packet}.`,
          "Do not submit, consent, or complete. If the submitted cut changes, stop and report it; do not review the replacement under this dispatch.",
        ].join("\n"),
      },
      revision = cell.store.readHead()?.revision ?? 0,
      authorizationDecision = authorizeRepoCellAction({
        action: { kind: "runtime-spawn", ...payload },
        binding,
        actionId: dispatchOpId,
        revision,
        now: cell.now(),
      });
    if (authorizationDecision.outcome !== "allowed")
      throw cell.cellCodedError("authorization_denied", authorizationDecision.nextActions.join(" "));
    // Already inside the center queue. Only launch admission is awaited; provider completion is not.
    await cell.runtimeSpawner.spawn(payload, { ...binding, authorizationDecision });
  }
  const session = cell.projection.readRuntimeSession(runtimeSessionId);
  return {
    ...stopped(
      session ? `ha runtime status ${runtimeSessionId}` : `ha receipt show ${dispatchOpId}`,
      session?.outcome
        ? `Reviewer dispatch ${dispatchId} ended ${session.outcome} without a current approved Review. Inspect its result; completion does not launch a new root dispatch.`
        : `Reviewer dispatch ${dispatchId} owns this submitted cut. Wait for its independent RecordReview, then retry completion.`,
    ),
    dispatchId,
    runtimeSessionId,
  } as WriteReceiptDraft;
}
