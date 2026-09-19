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
import { isAgentDeclarationInvalid, readAgentDeclarationResolution } from "./agent-entities.ts";
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
 * The one review-dispatch spawn: the cut's frozen completionContract reviewer claim wins over the
 * repository default, the dispatch is keyed by `reviewDispatchKey` (task/execution/iteration/digest,
 * the deterministic claim fence that makes concurrent dispatches share one reviewer), and launch
 * admission is awaited while provider completion is not. Returns the idempotent identities the
 * caller reports on its own step shape.
 */
export async function spawnCutReviewDispatch(
  cell: RepoCellOperationalContext,
  input: {
    readonly taskId: string;
    readonly execution: ExecutionV1;
    readonly packagePath: string;
    readonly binding: RepoCellBinding;
    readonly revision: number;
    readonly reviewerId: string;
    readonly extras?: Readonly<Record<string, unknown>>;
  },
): Promise<
  | { readonly outcome: "dispatched" | "already_dispatched"; readonly ids: ReturnType<typeof reviewDispatchIds> }
  | { readonly outcome: "failed"; readonly error: string }
> {
  const key = reviewDispatchKey(input.taskId, input.execution),
    ids = reviewDispatchIds(cell.input.repoId, key);
  if (cell.store.readEvent(ids.dispatchOpId) !== null) return { outcome: "already_dispatched", ids };
  let resolved;
  try {
    resolved = readAgentDeclarationResolution({
      rootDir: cell.rootDir,
      agentId: input.reviewerId,
      entityStore: createEntityStore(cell.store),
    });
  } catch (error) {
    if (!isAgentDeclarationInvalid(error)) throw error;
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  if (!resolved)
    return {
      outcome: "failed",
      error:
        `Reviewer ${input.reviewerId} is not bundled or installed. Install a repository override, or select an ` +
        `available reviewer with ha task dispatch-review ${input.taskId} --agent <agent-id>.`,
    };
  const { declaration: agent, layer } = resolved;
  if (layer === "installed" && !agentDeclaresExplicitModels(agent.runtimes) && typeof input.extras?.model !== "string")
    return {
      outcome: "failed",
      error:
        `Declare an explicit model on every runtimes row for reviewer ${input.reviewerId}, or pass --model <model>. ` +
        "Installed reviewer overrides must not select an instance default model.",
    };
  const extras = input.extras ?? {},
    payload = {
      agentId: agent.id,
      role: "reviewer",
      taskId: input.taskId,
      executionId: input.execution.executionId,
      cwd: { scope: "repo-root" },
      idempotencyKey: key,
      ...(typeof extras.runtimeInstanceId === "string" ? { runtimeInstanceId: extras.runtimeInstanceId } : {}),
      ...(typeof extras.model === "string" ? { model: extras.model } : {}),
      ...(typeof extras.effort === "string" ? { effort: extras.effort } : {}),
      ...(extras.fast === true ? { fast: true } : {}),
      prompt: reviewDispatchPrompt({
        cell,
        taskId: input.taskId,
        packagePath: input.packagePath,
        dispatchId: ids.dispatchId,
        execution: input.execution,
        gates: completionGateIds(
          cell.projection.read(input.taskId).snapshot.task?.completionGateIds ?? [],
          input.execution.submission,
        ),
      }),
    },
    authorizationDecision = authorizeRepoCellAction({
      action: { kind: "runtime-spawn", ...payload },
      binding: input.binding,
      actionId: ids.dispatchOpId,
      revision: input.revision,
      now: cell.now(),
    });
  if (authorizationDecision.outcome !== "allowed")
    return { outcome: "failed", error: `authorization_denied: ${authorizationDecision.nextActions.join(" ")}` };
  try {
    // Already inside the center queue. Only launch admission is awaited; provider completion is not.
    await cell.runtimeSpawner.spawn(payload, { ...input.binding, authorizationDecision });
  } catch (error) {
    consumeKnownError(error);
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  return { outcome: "dispatched", ids };
}

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
      : (cell.settings.readRepository().defaultReviewer ?? "closeout-reviewer");
  let resolved;
  try {
    resolved = readAgentDeclarationResolution({
      rootDir: cell.rootDir,
      agentId: reviewerId,
      entityStore: createEntityStore(cell.store),
    });
  } catch (error) {
    // A reviewer whose stored declaration fails the current schema (the rewrite window) rejects
    // the batch with the reinstall command; the raw contract message never surfaces.
    if (!isAgentDeclarationInvalid(error)) throw error;
    throw cell.cellCodedError("review_dispatch_failed", error instanceof Error ? error.message : String(error));
  }
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
    } else if (snapshot.task?.status === "submitted") {
      // The owner's forward order owns the first dispatch (owner adjudication 2026-09-19); this
      // manual lane re-dispatches a cut already sitting at the review gate.
      fail(
        `Task ${taskId} still awaits its owner's triage. Run ha task adjudicate ${taskId} --forward ` +
          "--note <why>; the forward order dispatches the independent reviewer.",
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
