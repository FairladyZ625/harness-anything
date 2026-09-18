import { createHash } from "node:crypto";
import {
  completionGateIds,
  consumeKnownError,
  gateAppliesToSubmission,
  createEntityStore,
  currentSubmittedExecutions,
  submissionDigest,
  type ExecutionV1,
  type WriteReceiptDraft,
} from "../../kernel/src/index.ts";
import { readSubmissionArtifact } from "./submission-artifacts.ts";
import { readAgentDeclarationResolution } from "./agent-entities.ts";
import { agentDeclaresExplicitModels } from "./agent-runtime-contract.ts";
import { authorizeRepoCellAction } from "./repo-cell-authorization.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

/** A user-initiated review dispatch is keyed by the reviewed cut, never by a caller or node. */
export function reviewDispatchKey(taskId: string, execution: ExecutionV1): string {
  return `task-review:${taskId}:${execution.executionId}:${execution.iteration}:${submissionDigest(
    execution.submission!,
  )}`;
}

export function reviewDispatchIds(
  repoId: string,
  idempotencyKey: string,
): { readonly dispatchId: string; readonly runtimeSessionId: string; readonly dispatchOpId: string } {
  const hash = createHash("sha256").update(`${repoId}\0${idempotencyKey}`).digest("hex");
  return {
    dispatchId: `dispatch_${hash.slice(0, 24)}`,
    runtimeSessionId: `runtime_${hash.slice(24, 48)}`,
    dispatchOpId: `runtime-spawn-${hash.slice(0, 32)}`,
  };
}

/** The review packet prompt every reviewer dispatch carries; each dispatch owns exactly one task. */
export function reviewDispatchPrompt(input: {
  readonly cell: RepoCellOperationalContext;
  readonly taskId: string;
  readonly packagePath: string;
  readonly dispatchId: string;
  readonly execution: ExecutionV1;
  readonly gates: readonly string[];
}): string {
  const { cell, taskId, packagePath, dispatchId, execution, gates } = input,
    inapplicable = (execution.submission?.completionContract?.gates ?? [])
      .filter((gate) => !gateAppliesToSubmission(gate, execution.submission!))
      .map((gate) => gate.gateId),
    report = `${packagePath}/artifacts/reports/${dispatchId}.md`,
    packet = `${packagePath}/artifacts/reports/${dispatchId}.json`;
  return [
    `Independently review task ${taskId}, execution ${execution.executionId}, ` + `iteration ${execution.iteration}.`,
    `The exact submission digest is ${submissionDigest(execution.submission!)}; ` +
      `delivery ${JSON.stringify(execution.submission!)}.`,
    ...(execution.submission!.artifacts ?? []).map((anchor) =>
      JSON.stringify(readSubmissionArtifact(cell, packagePath, anchor.path, anchor.revision, anchor.blobSha256)),
    ),
    "For artifact anchors, review the center-accepted frozen contents above against the contract; " +
      "do not substitute local files or require Git ancestry for them.",
    `Effective completion gates: ${gates.length ? gates.join(", ") : "none"}.`,
    ...(inapplicable.length ? [`Declared gates not applicable to this delivery: ${inapplicable.join(", ")}.`] : []),
    "Read the task plan, closeout, and submitted delivery yourself. " +
      "Record approved or changes_requested through RecordReview; never infer approval from provider success.",
    `Write this execution's review report to harness/${report} and review input to harness/${packet}. ` +
      "These dispatch-specific paths replace any shared report path in your declaration.",
    `Register with ha task review-execution ${taskId} --execution-id ${execution.executionId} ` +
      `--review-id review-${dispatchId} --from-file harness/${packet}.`,
    "Do not submit, consent, or complete. If the submitted cut changes, stop and report it; " +
      "do not review the replacement under this dispatch.",
  ].join("\n");
}

type DispatchStep = {
  readonly taskId: string;
  readonly executionId?: string;
  readonly dispatchId?: string;
  readonly runtimeSessionId?: string;
  readonly dispatchOpId?: string;
  readonly outcome: "dispatched" | "already_dispatched" | "already_reviewed" | "failed";
  readonly error?: string;
};

/**
 * `ha task dispatch-review`: expand one batch invocation into one independent reviewer dispatch per
 * task. Each dispatch is keyed by the task's submitted cut and binds to that execution only — never
 * to the task's active implementation lease — so a review cannot open or claim an implementation
 * iteration.
 */
export async function dispatchTaskReview(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceiptDraft> {
  const rawIds = Array.isArray(action.taskIds) ? action.taskIds : [],
    taskIds = rawIds.map((value) => String(value)).filter((value) => value.length > 0);
  if (taskIds.length === 0 || taskIds.length !== rawIds.length)
    throw cell.cellCodedError(
      "missing_field",
      "task dispatch-review requires at least one task id (ha task dispatch-review <task-id> [--task <id>...]).",
    );
  if (new Set(taskIds).size !== taskIds.length)
    throw cell.cellCodedError("invalid_command", "task dispatch-review task ids must be unique.");
  const executionSelector = typeof action.executionId === "string" ? action.executionId : undefined;
  if (executionSelector !== undefined && taskIds.length !== 1)
    throw cell.cellCodedError(
      "invalid_command",
      "--execution-id selects exactly one reviewed execution; a batch dispatch reviews each task's submitted cut.",
    );
  const reviewerId =
      typeof action.agentId === "string" && action.agentId.length > 0
        ? action.agentId
        : (cell.settings.readRepository().defaultReviewer ?? "closeout-reviewer"),
    resolved = readAgentDeclarationResolution({
      rootDir: cell.rootDir,
      agentId: reviewerId,
      entityStore: createEntityStore(cell.store),
    });
  if (!resolved)
    throw cell.cellCodedError(
      "review_dispatch_failed",
      `Reviewer ${reviewerId} is not bundled or installed. Install a repository override, or select an ` +
        "available reviewer with ha task dispatch-review <task-id> --agent <agent-id>.",
    );
  const { declaration: agent, layer } = resolved;
  if (layer === "installed" && !agentDeclaresExplicitModels(agent.runtimes) && typeof action.model !== "string")
    throw cell.cellCodedError(
      "review_dispatch_failed",
      `Declare an explicit model on every runtimes row for reviewer ${reviewerId}, or pass --model <model>. ` +
        "Installed reviewer overrides must not select an instance default model.",
    );
  const revision = cell.store.readHead()?.revision ?? 0,
    steps: DispatchStep[] = [];
  for (const taskId of taskIds) {
    const fail = (error: string, executionId?: string) =>
      steps.push({ taskId, ...(executionId ? { executionId } : {}), outcome: "failed", error });
    const read = requireCurrentTaskProjection(cell.projection, taskId, "task dispatch-review"),
      snapshot = read.snapshot,
      candidates = currentSubmittedExecutions(snapshot);
    let execution: ExecutionV1 | undefined;
    if (executionSelector !== undefined) {
      execution = candidates.find((candidate) => candidate.executionId === executionSelector);
      if (execution === undefined) {
        fail(
          `Execution ${executionSelector} is not a submitted cut on task ${taskId}'s current iteration.`,
          executionSelector,
        );
        continue;
      }
    } else if (candidates.length === 0) {
      fail(
        `Task ${taskId} has no submitted execution to review. A review dispatch binds to a submitted ` +
          "cut; submit the implementation first.",
      );
      continue;
    } else if (candidates.length > 1) {
      fail(
        `Task ${taskId} has ${String(candidates.length)} submitted executions on its current iteration. ` +
          "Dispatch each review explicitly with --execution-id.",
      );
      continue;
    } else execution = candidates[0]!;
    const key = reviewDispatchKey(taskId, execution),
      ids = reviewDispatchIds(cell.input.repoId, key),
      existing = cell.store.readEvent(ids.dispatchOpId);
    if (existing !== null) {
      steps.push({
        taskId,
        executionId: execution.executionId,
        dispatchId: ids.dispatchId,
        runtimeSessionId: ids.runtimeSessionId,
        dispatchOpId: ids.dispatchOpId,
        outcome: "already_dispatched",
      });
      continue;
    }
    if (snapshot.reviews.some((review) => review.reviewId === `review-${ids.dispatchId}`)) {
      steps.push({
        taskId,
        executionId: execution.executionId,
        dispatchId: ids.dispatchId,
        runtimeSessionId: ids.runtimeSessionId,
        dispatchOpId: ids.dispatchOpId,
        outcome: "already_reviewed",
      });
      continue;
    }
    const payload = {
        agentId: agent.id,
        role: "reviewer",
        taskId,
        executionId: execution.executionId,
        cwd: { scope: "repo-root" },
        idempotencyKey: key,
        ...(typeof action.runtimeInstanceId === "string" ? { runtimeInstanceId: action.runtimeInstanceId } : {}),
        ...(typeof action.model === "string" ? { model: action.model } : {}),
        ...(typeof action.effort === "string" ? { effort: action.effort } : {}),
        ...(typeof action.fast === "boolean" ? { fast: action.fast } : {}),
        prompt: reviewDispatchPrompt({
          cell,
          taskId,
          packagePath: read.packagePath,
          dispatchId: ids.dispatchId,
          execution,
          gates: completionGateIds(snapshot.task!.completionGateIds, execution.submission),
        }),
      },
      authorizationDecision = authorizeRepoCellAction({
        action: { kind: "runtime-spawn", ...payload },
        binding,
        actionId: ids.dispatchOpId,
        revision,
        now: cell.now(),
      });
    if (authorizationDecision.outcome !== "allowed") {
      fail(`authorization_denied: ${authorizationDecision.nextActions.join(" ")}`, execution.executionId);
      continue;
    }
    try {
      // Already inside the center queue. Only launch admission is awaited; provider completion is not.
      await cell.runtimeSpawner.spawn(payload, { ...binding, authorizationDecision });
      steps.push({
        taskId,
        executionId: execution.executionId,
        dispatchId: ids.dispatchId,
        runtimeSessionId: ids.runtimeSessionId,
        dispatchOpId: ids.dispatchOpId,
        outcome: "dispatched",
      });
    } catch (error) {
      // One task's launch failure is reported on its own step; the batch continues for the rest.
      consumeKnownError(error);
      fail(error instanceof Error ? error.message : String(error), execution.executionId);
    }
  }
  const dispatched = steps.filter((step) => step.outcome !== "failed"),
    failed = steps.filter((step) => step.outcome === "failed");
  return {
    outcome: dispatched.length === 0 ? "op_rejected" : "applied",
    opId: cell.operationId(action, binding, cell.input.repoId, revision),
    revision,
    ...(failed.length === 0 ? {} : { code: "review_dispatch_failed" }),
    ...(failed.length === 0 ? {} : { warnings: failed.map((step) => `${step.taskId}: ${step.error ?? ""}`) }),
    ...(failed.length === steps.length
      ? { rejectionExplanation: failed.map((step) => `${step.taskId}: ${step.error ?? ""}`).join("; ") }
      : {}),
    summary: `dispatch-review: ${String(dispatched.length)} of ${String(steps.length)} task(s) have a review dispatch.`,
    dispatches: steps,
  } as WriteReceiptDraft;
}
