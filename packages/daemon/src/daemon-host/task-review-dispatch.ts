import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createEntityStore } from "@harness-anything/storage";
import {
  reviewDispatchFailureWarning,
  completionGateIds,
  consumeKnownError,
  EXECUTION_DELIVERY_BASELINE_NOTE,
  gateAppliesToSubmission,
  currentSubmittedExecutions,
  historicalReadConclusions,
  resolveHarnessLayout,
  runtimeSessionIdFromActor,
  submissionDigest,
  decisionReviewContentDigest,
  documentWorkspacePath,
  reviewReverifyRoute,
  type ExecutionV1,
  type ReviewReverifyRoute,
  type ReviewV1,
  type TaskReviewDispatchIntentV1,
  type TaskReviewDispatchFailureV1,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import { derivedTaskActionProtocolCommands } from "./protocol/daemon-protocol-commands-task.ts";
import { decisionLifecycleProtocolCommands } from "./protocol/daemon-protocol-commands-decision-lifecycle.ts";
import { isAgentDeclarationInvalid, readAgentDeclarationResolution } from "./agent-entities.ts";
import { agentDeclaresExplicitModels } from "./agent-runtime-contract.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import { reviewDispatchKey } from "./review-dispatch-key.ts";
import { activeCutReviewDispatches, reviewAttemptEnded } from "./review-dispatch-state.ts";

export { reviewDispatchKey } from "./review-dispatch-key.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import {
  reviewFindingCategoryPrompt,
  reviewFindingReverifyPrompt,
  reviewFindingScopePrompt,
  riskAssessmentGuidancePrompt,
  scopedReReviewPrompt,
} from "./review-prompt-guidance.ts";
import { selectReviewSeat, type ReviewSeat, type ReviewSeatSelection } from "./review-panel.ts";
import { reviewPathSeatPrompt } from "./review-path-matching.ts";
import { runtimeKindForId, runtimeVendorForKind } from "../runtime-engine/runtime-inventory.ts";
import { runtimeErrorCode } from "../runtime-engine/runtime-spawn-errors.ts";
import { worktreeAuthoredRelative } from "./worktree-setup.ts";
import { DecisionReviewContentConflictError } from "./repo-cell-errors.ts";
import type { RepoCellOperationalContext } from "./repo-cell-types.ts";
import type { RepoCellBinding, RepoCellContinuationWrite, RepoTaskAction } from "./repo-cell-types.ts";
import type { NodeAutoDispatchCandidate } from "./node-auto-dispatch.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { samePlacement, taskExecutionPlacement } from "./task-execution-placement.ts";
import { fetchPinnedReviewCommitFromOrigin } from "./task-worktree.ts";
import { workerRootPathToken } from "./runtime-spawn-mission.ts";
import {
  requireMaterializedDirectory,
  requireTaskPackageMaterialization,
  settleAuthoredMaterialization,
} from "./repo-cell-materialization.ts";

/**
 * The one seat a submitted cut reviews under (dec_6A77D43B8523823ABA1F5E4D3C CH1). A professional
 * path rule that the cut's frozen manifest hits replaces the default seat rather than opening a
 * second passing gate; an owner's `--agent` and a task's own reviewer are narrower declarations and
 * come first. Both the automatic submit dispatch and `ha task dispatch-review` call this.
 */
export function reviewSeatForCut(input: {
  readonly cell: RepoCellOperationalContext;
  readonly execution: ExecutionV1;
  readonly taskReviewer?: string | undefined;
  readonly argument?: string | undefined;
}): ReviewSeatSelection {
  const submission = input.execution.submission;
  return selectReviewSeat({
    argument: input.argument,
    taskReviewer: input.taskReviewer,
    frozenReviewer: submission?.completionContract?.reviewer?.agentId,
    repositoryDefault: input.cell.settings.readRepository().roles?.defaultReviewer,
    // The frozen assessment is the routing evidence the cut was submitted under; recomputing it at
    // dispatch time would let a later settings edit move a cut that is already under review.
    pathReviewers: submission?.riskTierAssessment?.matchedPathReviewers ?? [],
  });
}

/**
 * The kernel's reverify route for a submitted cut (dec_BEFCF7D0484E901F187C2C8EC6 CH2). Every review
 * dispatch path reads it here; the daemon never judges whether a re-review is owed itself.
 */
function cutReverifyRoute(
  snapshot: Omit<Parameters<typeof reviewReverifyRoute>[0], "execution">,
  execution: ExecutionV1,
): ReviewReverifyRoute {
  return reviewReverifyRoute({ reviews: snapshot.reviews, reviewResponses: snapshot.reviewResponses, execution });
}

export const centerReviewFailurePrefix = "Center review fallback:";

export function nodeReviewDispatchCandidate(
  cell: RepoCellOperationalContext,
  input:
    | { readonly taskId: string; readonly requiredNodeId: string }
    | { readonly taskId: string; readonly centerFallback: true },
): NodeAutoDispatchCandidate | null {
  const read = cell.projection.read(input.taskId),
    snapshot = read.snapshot;
  if (snapshot.task?.status !== "in_review") return null;
  const execution = currentSubmittedExecutions(snapshot).find(
    (candidate) => candidate.state === "submitted" && candidate.submission !== null,
  );
  if (!execution || !read.packagePath) return null;
  const placement = taskExecutionPlacement(cell, input.taskId, execution.executionId);
  if (placement.kind !== "node") return null;
  const centerFallback = "centerFallback" in input;
  if (!centerFallback && placement.nodeId !== input.requiredNodeId) return null;
  const intent =
      snapshot.task.reviewDispatchIntent?.executionId === execution.executionId
        ? snapshot.task.reviewDispatchIntent
        : undefined,
    reverify = cutReverifyRoute(snapshot, execution);
  // An owner-verify cut waits on the owner, not a reviewer; only an explicit owner request dispatches one.
  if (reverify.kind === "owner-verify" && !intent) return null;
  const selection = intent
    ? {
        kind: "seat" as const,
        seat: { reviewerId: intent.reviewerId, source: "argument" as const },
      }
    : reviewSeatForCut({ cell, execution, taskReviewer: snapshot.task.reviewer });
  if (selection.kind === "escalated") return null;
  const { reviewerId } = selection.seat,
    dispatchKey = reviewDispatchKey(input.taskId, execution, reviewerId),
    failure = snapshot.task.reviewDispatchFailure,
    { key, ids, existing } = reviewDispatchAttempt(cell, dispatchKey);
  const failed = failure?.executionId === execution.executionId && failure.dispatchKey === key;
  if (
    failed &&
    (!centerFallback ||
      failure.message.startsWith(centerReviewFailurePrefix) ||
      !["runtime_capacity_exhausted", "agent_runtime_unavailable"].includes(failure.code))
  )
    return null;
  const resolved = readAgentDeclarationResolution({
    rootDir: cell.rootDir,
    agentId: reviewerId,
    entityStore: createEntityStore(cell.store),
    verticalId: snapshot.task.metadata?.verticalId ?? cell.settings.readRepository().defaultVertical,
  });
  if (!resolved) return null;
  const { declaration: agent, layer } = resolved,
    intentModel = intent?.model;
  if (layer === "installed" && !agentDeclaresExplicitModels(agent.runtimes) && typeof intentModel !== "string")
    return null;
  if (existing !== null || activeCutReviewDispatches(cell, input.taskId, execution).length > 0) return null;
  const seatPrompt = selection.seat.source === "path" ? `\n${reviewPathSeatPrompt({ seat: selection.seat })}` : "";
  const selectionHints = taskReviewSelectionHints(cell, {
    taskId: input.taskId,
    executionId: execution.executionId,
    reviewerId,
    dispatchKey: key,
    packagePath: read.packagePath,
    explicitInstanceId: intent?.runtimeInstanceId,
    explicitModel: intent?.model,
  });
  const payload = {
    agentId: resolved.declaration.id,
    role: "reviewer",
    taskId: input.taskId,
    executionId: execution.executionId,
    dispatchKey: key,
    prompt:
      reviewDispatchPrompt({
        taskId: input.taskId,
        packagePath: read.packagePath,
        dispatchId: ids.dispatchId,
        execution,
        gates: completionGateIds(snapshot.task.completionGateIds, execution.submission),
        artifactPrefix: worktreeAuthoredRelative(resolveHarnessLayout(cell.rootDir)),
        implementationNodeId: placement.nodeId,
        ...(!centerFallback ? { reviewerNodeId: placement.nodeId } : {}),
        reverify,
      }) + seatPrompt,
    ...selectionHints,
    ...(intent?.runtimeInstanceId ? { runtimeInstanceId: intent.runtimeInstanceId } : {}),
    ...(intent?.model ? { model: intent.model } : {}),
    ...(intent?.effort ? { effort: intent.effort } : {}),
    ...(intent?.fast === undefined ? {} : { fast: intent.fast }),
  } satisfies JsonObject;
  return {
    repoId: cell.input.repoId,
    taskId: input.taskId,
    executionId: execution.executionId,
    kind: "review",
    requiredNodeId: placement.nodeId,
    ...(centerFallback && failed ? { edgeDispatchFailed: true } : {}),
    dispatchKey: key,
    payload,
  };
}

export async function prepareCenterReviewFallback(
  cell: RepoCellOperationalContext,
  payload: JsonObject,
  binding: RepoCellBinding,
): Promise<{ readonly commitSha: string | null; readonly recheckReviewCut: () => void }> {
  const taskId = cell.requiredCellText(payload.taskId, "taskId"),
    executionId = cell.requiredCellText(payload.executionId, "executionId"),
    snapshot = cell.projection.read(taskId).snapshot,
    execution = currentSubmittedExecutions(snapshot).find((row) => row.executionId === executionId),
    dispatchKey = cell.requiredCellText(payload.dispatchKey, "dispatchKey"),
    submission = execution?.submission;
  if (!execution || !submission || !snapshot.task || binding.source !== "local" || payload.role !== "reviewer")
    throw cell.cellCodedError("execution_scope_mismatch", "Center fallback requires a current reviewer cut.");
  const submissionOpId = cell.projection.readTaskSubmissionOperation(taskId, executionId),
    recheckReviewCut = () => {
      requireSubmittedReviewCut(cell, taskId, execution, submissionOpId);
      const current = nodeReviewDispatchCandidate(cell, { taskId, centerFallback: true });
      if (current?.dispatchKey !== dispatchKey)
        throw cell.cellCodedError("execution_scope_mismatch", "The Center review candidate changed.");
    };
  recheckReviewCut();
  const authorization = await authorizeTaskReviewSpawn(
    cell,
    payload,
    binding,
    reviewDispatchIds(cell.input.repoId, dispatchKey).dispatchOpId,
  );
  if (authorization.outcome !== "allowed")
    throw cell.cellCodedError("authorization_denied", authorization.nextActions.join(" "));
  if (submission.commitSha !== null) {
    await fetchPinnedReviewCommitFromOrigin(cell.rootDir, submission.commitSha);
    recheckReviewCut();
  }
  return { commitSha: submission.commitSha, recheckReviewCut };
}

/** Cut-review keys are qualified by reviewer so rerouting cannot reuse another reviewer's session. */
export function decisionReviewDispatchKey(decisionId: string, digest: string): string {
  return `decision-review:${decisionId}:${digest}`;
}

export async function dispatchDecisionReview(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceiptDraft> {
  const decisionId = cell.requiredCellText(action.decisionId, "decisionId"),
    read = cell.projection.readDecision(decisionId);
  if (read.watermark !== read.sourceRevision || !read.decision)
    throw cell.cellCodedError("content_not_ready", `Decision ${decisionId} is unavailable or pending.`);
  const path = `decisions/decision-${decisionId}/decision.md`,
    document = cell.projection.readDocument(path);
  if (document.watermark !== document.sourceRevision || !document.document)
    throw cell.cellCodedError("content_not_ready", `Decision document ${path} is unavailable or pending.`);
  const relations = cell.projection.readRelationQuery({ ownerRef: `decision/${decisionId}` }).rows.map((edge) => ({
      relation_id: edge.relationId,
      source: edge.sourceRef,
      target: edge.targetRef,
      type: edge.relationType,
      strength: edge.strength,
      direction: edge.direction,
      origin: edge.origin,
      rationale: edge.rationale,
      state: edge.state,
    })),
    current = { ...read.decision, relations },
    digest = decisionReviewContentDigest(current, document.document.body);
  if (typeof action.expectedDigest === "string" && action.expectedDigest !== digest)
    throw new DecisionReviewContentConflictError(action.expectedDigest, digest);
  const baseKey = decisionReviewDispatchKey(decisionId, digest),
    revision = cell.store.readHead()?.revision ?? 0,
    // A session that recorded its verdict for its digest has finished that review, whether or not
    // its runtime exit was ever observed.
    reviewRecorded = (reviewedDigest: string, runtimeSessionId: string) =>
      current.reviews.some(
        (review) =>
          review.reviewContentDigest === reviewedDigest &&
          review.actor.executor?.id === `runtime-session:${runtimeSessionId}`,
      );
  const activeDecisionDispatch = cell.projection.readRuntimeDispatchesByDecision(decisionId).find(({ event }) => {
    const target = event.payload.reviewTarget;
    return (
      target?.kind === "decision" &&
      target.decisionId === decisionId &&
      !reviewAttemptEnded(cell, event.payload.runtimeSessionId) &&
      !reviewRecorded(target.digest, event.payload.runtimeSessionId)
    );
  });
  if (activeDecisionDispatch && activeDecisionDispatch.event.payload.reviewTarget?.digest !== digest)
    throw cell.cellCodedError(
      "review_dispatch_failed",
      `Decision ${decisionId} already has an unfinished review dispatch for digest ${activeDecisionDispatch.event.payload.reviewTarget?.digest}; ` +
        "wait for it to finish before dispatching the amended digest.",
    );
  let attempt = 0,
    key = reviewAttemptKey(baseKey, attempt),
    ids = reviewDispatchIds(cell.input.repoId, key),
    existing = cell.projection.readRuntimeDispatchByDispatchKey(key)?.event ?? null;
  while (
    existing !== null &&
    reviewAttemptEnded(cell, ids.runtimeSessionId) &&
    !reviewRecorded(digest, ids.runtimeSessionId)
  ) {
    attempt += 1;
    key = reviewAttemptKey(baseKey, attempt);
    ids = reviewDispatchIds(cell.input.repoId, key);
    existing = cell.projection.readRuntimeDispatchByDispatchKey(key)?.event ?? null;
  }
  if (existing !== null) {
    // One content cut holds one review dispatch at a time: an explicit --agent must never
    // masquerade as another agent's in-flight dispatch, so refuse naming both agents instead.
    const holdingAgent = typeof existing.payload.agentId === "string" ? existing.payload.agentId : null;
    if (typeof action.agentId === "string" && action.agentId.length > 0 && holdingAgent !== action.agentId)
      throw cell.cellCodedError(
        "review_dispatch_failed",
        `Decision ${decisionId} already holds review dispatch ${existing.payload.dispatchId} by agent ` +
          `${holdingAgent ?? "with no recorded agent"} (runtime session ${existing.payload.runtimeSessionId}, ` +
          `instance ${existing.payload.instanceId}); --agent ${action.agentId} was not dispatched. Re-run ` +
          `ha decision dispatch-review ${decisionId} --agent ${action.agentId} after that review session ends.`,
      );
    return {
      outcome: "applied",
      opId: existing.opId,
      revision,
      summary: `Decision ${decisionId} already has review dispatch ${ids.dispatchId} for ${digest}.`,
      dispatches: [
        {
          decisionId,
          digest,
          ...ids,
          dispatchOpId: existing.opId,
          ...(holdingAgent === null ? {} : { agentId: holdingAgent }),
          instanceId: existing.payload.instanceId,
          outcome: "already_dispatched",
        },
      ],
    } as WriteReceiptDraft;
  }
  const reviewerId =
      typeof action.agentId === "string" && action.agentId.length > 0
        ? action.agentId
        : (cell.settings.readRepository().roles?.defaultReviewer ?? "closeout-reviewer"),
    resolved = readAgentDeclarationResolution({
      rootDir: cell.rootDir,
      agentId: reviewerId,
      entityStore: createEntityStore(cell.store),
      verticalId: cell.settings.readRepository().defaultVertical,
    });
  if (!resolved)
    throw cell.cellCodedError("review_dispatch_failed", `Reviewer ${reviewerId} is not bundled or installed.`);
  const payload = {
      agentId: resolved.declaration.id,
      role: "reviewer",
      reviewTarget: { kind: "decision", decisionId, digest },
      cwd: {
        scope: "repo-relative",
        path: requireMaterializedDirectory(cell, path, document.document.workspaceRevision),
      },
      dispatchKey: key,
      ...(typeof action.runtimeInstanceId === "string" ? { runtimeInstanceId: action.runtimeInstanceId } : {}),
      ...(typeof action.model === "string" ? { model: action.model } : {}),
      ...(typeof action.effort === "string" ? { effort: action.effort } : {}),
      prompt: decisionReviewDispatchPrompt({
        decisionId,
        digest,
        dispatchId: ids.dispatchId,
        previousReview: current.reviews.filter((review) => review.reviewContentDigest !== digest).at(-1),
      }),
    },
    authorizationDecision = await evaluateRepoCellAction({
      action: { kind: "runtime-spawn", ...payload },
      repoId: cell.input.repoId,
      binding,
      actionId: ids.dispatchOpId,
      revision,
      now: cell.now(),
      readTask: (taskId) => cell.projection.read(taskId).snapshot.task,
    });
  if (authorizationDecision.outcome !== "allowed")
    throw cell.cellCodedError("authorization_denied", authorizationDecision.nextActions.join(" "));
  const spawned = await cell.runtimeSpawner.spawn(payload, { ...binding, authorizationDecision });
  // The spawner resolved the concrete instance; read it from the dispatch event this spawn just
  // applied so the receipt names the agent and instance that will run the review.
  const dispatched = cell.projection.readRuntimeDispatchByDispatchKey(key)?.event,
    dispatchOpId = typeof spawned.opId === "string" ? spawned.opId : ids.dispatchOpId;
  return {
    outcome: "applied",
    opId: dispatchOpId,
    revision,
    summary: `Dispatched Decision ${decisionId} review ${ids.dispatchId} for ${digest}.`,
    dispatches: [
      {
        decisionId,
        digest,
        ...ids,
        dispatchOpId,
        agentId: resolved.declaration.id,
        ...(dispatched === undefined ? {} : { instanceId: dispatched.payload.instanceId }),
        outcome: "dispatched",
      },
    ],
  } as WriteReceiptDraft;
}

function reviewAttemptKey(base: string, attempt: number): string {
  return attempt === 0 ? base : `${base}:attempt${String(attempt)}`;
}

type ReviewerContinuation = {
  readonly dispatchId: string;
  readonly reportRef: string;
  readonly resume: boolean;
  readonly instanceId: string;
  readonly model?: string;
  readonly review?: ReviewV1;
};

function completedReviewerDispatchesForTask(
  cell: RepoCellOperationalContext,
  input: {
    readonly taskId: string;
    readonly reviewerId: string;
    readonly dispatchKey: string;
  },
) {
  if (typeof cell.projection.readRuntimeDispatchesByTaskIds !== "function") return [];
  const lanePrefix = `task-review-lane:${input.reviewerId}:${input.taskId}:`,
    seatPrefix = `task-review:${input.taskId}:`;
  return cell.projection
    .readRuntimeDispatchesByTaskIds([input.taskId])
    .filter((row) => {
      const payload = row.payload;
      return (
        payload.role === "reviewer" &&
        payload.taskId === input.taskId &&
        payload.agentId === input.reviewerId &&
        typeof payload.dispatchKey === "string" &&
        (payload.dispatchKey.startsWith(seatPrefix) || payload.dispatchKey.startsWith(lanePrefix)) &&
        payload.dispatchKey !== input.dispatchKey &&
        reviewAttemptEnded(cell, payload.runtimeSessionId)
      );
    })
    .sort((left, right) => String(right.payload.startedAt ?? "").localeCompare(String(left.payload.startedAt ?? "")));
}

/**
 * Find the latest completed reviewer round for exactly one task and reviewer. Historical path-lane
 * keys are still matched so a cut reviewed before the single-seat change can continue its reviewer.
 */
function previousReviewerContinuation(
  cell: RepoCellOperationalContext,
  input: {
    readonly taskId: string;
    readonly reviewerId: string;
    readonly dispatchKey: string;
    readonly packagePath: string;
  },
): ReviewerContinuation | null {
  if (typeof cell.projection.readDocument !== "function") return null;
  const previous = completedReviewerDispatchesForTask(cell, input).find((row) => {
    const reportRef = `${input.packagePath}/artifacts/reports/${row.payload.dispatchId}.md`;
    return cell.projection.readDocument(reportRef).document !== null;
  });
  if (!previous) return null;
  const payload = previous.payload,
    session = cell.projection.readRuntimeSession(payload.runtimeSessionId),
    declaration = session === null ? null : runtimeKindForId(session.kindId),
    canResume = Boolean(session?.providerSessionId && declaration?.declaredCapabilities.includes("resume")),
    previousModel = payload.definitionSnapshot?.model;
  const reportRef = `${input.packagePath}/artifacts/reports/${payload.dispatchId}.md`;
  const review = cell.projection
    .read(input.taskId)
    .snapshot.reviews.find(
      (candidate) =>
        candidate.reviewId === `review-${payload.dispatchId}` ||
        candidate.actor.executor?.id === `runtime-session:${payload.runtimeSessionId}`,
    );
  return {
    dispatchId: payload.dispatchId,
    reportRef,
    resume: canResume,
    instanceId: payload.instanceId,
    ...(typeof previousModel === "string" && previousModel.length > 0 ? { model: previousModel } : {}),
    ...(review === undefined ? {} : { review }),
  };
}

function implementationVendorForExecution(
  cell: RepoCellOperationalContext,
  taskId: string,
  executionId: string,
): string | undefined {
  if (typeof cell.projection.readRuntimeDispatchesByTaskExecution !== "function") return undefined;
  const executionDispatches = cell.projection
      .readRuntimeDispatchesByTaskExecution(taskId, executionId)
      .map(({ event }) => event.payload)
      .filter((payload) => payload.role !== "reviewer"),
    // Rework executions that submit manual fixes without a new worker spawn inherit the task's
    // latest implementation runtime vendor so a fallback still avoids the author's vendor.
    dispatches =
      executionDispatches.length > 0 || typeof cell.projection.readRuntimeDispatchesByTaskIds !== "function"
        ? executionDispatches
        : cell.projection
            .readRuntimeDispatchesByTaskIds([taskId])
            .map((row) => row.payload)
            .filter((payload) => payload.role !== "reviewer")
            .sort((left, right) => String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? "")));
  if (dispatches.length === 0) return undefined;
  const holderActor = cell.projection.readLatestLeaseIntervalForExecution?.(taskId, executionId)?.holder.actor,
    leaseSessionId = holderActor === undefined ? null : runtimeSessionIdFromActor(holderActor),
    sourceDispatch =
      (leaseSessionId === null
        ? undefined
        : dispatches.findLast((payload) => payload.runtimeSessionId === leaseSessionId)) ?? dispatches.at(-1);
  if (!sourceDispatch) return undefined;
  const kindId = sourceDispatch.kindId ?? sourceDispatch.definitionSnapshot?.kindId;
  return typeof kindId === "string" ? (runtimeVendorForKind(kindId) ?? undefined) : undefined;
}

function previousReviewedRoundAffinity(
  cell: RepoCellOperationalContext,
  input: {
    readonly taskId: string;
    readonly reviewerId: string;
    readonly dispatchKey: string;
    readonly packagePath?: string | null;
    readonly continuation?: ReviewerContinuation | null;
  },
): { readonly instanceId: string; readonly model?: string } | null {
  if (input.continuation) {
    return {
      instanceId: input.continuation.instanceId,
      ...(input.continuation.model ? { model: input.continuation.model } : {}),
    };
  }
  const snapshotReviews = cell.projection.read(input.taskId).snapshot.reviews;
  const previous = completedReviewerDispatchesForTask(cell, input).find((row) => {
    const payload = row.payload;
    const hasReport =
        typeof input.packagePath === "string" &&
        typeof cell.projection.readDocument === "function" &&
        cell.projection.readDocument(`${input.packagePath}/artifacts/reports/${payload.dispatchId}.md`).document !==
          null,
      hasReview = snapshotReviews.some(
        (candidate) =>
          candidate.reviewId === `review-${payload.dispatchId}` ||
          candidate.actor.executor?.id === `runtime-session:${payload.runtimeSessionId}`,
      );
    return hasReport || hasReview;
  });
  if (!previous) return null;
  const previousModel = previous.payload.definitionSnapshot?.model;
  return {
    instanceId: previous.payload.instanceId,
    ...(typeof previousModel === "string" && previousModel.length > 0 ? { model: previousModel } : {}),
  };
}

/** Resolve same-task re-review soft affinity and first-review implementation-vendor avoidance. */
function taskReviewSelectionHints(
  cell: RepoCellOperationalContext,
  input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly reviewerId: string;
    readonly dispatchKey: string;
    readonly packagePath?: string | null;
    readonly continuation?: ReviewerContinuation | null;
    readonly explicitInstanceId?: unknown;
    readonly explicitModel?: unknown;
  },
): JsonObject {
  if (typeof input.explicitInstanceId === "string" || typeof input.explicitModel === "string") return {};
  const affinity = previousReviewedRoundAffinity(cell, input),
    avoidVendor = implementationVendorForExecution(cell, input.taskId, input.executionId);
  return {
    ...(affinity === null
      ? {}
      : {
          preferredRuntimeInstanceId: affinity.instanceId,
          ...(affinity.model ? { preferredModel: affinity.model } : {}),
        }),
    ...(avoidVendor === undefined ? {} : { avoidVendor }),
  };
}
export function reviewDispatchIds(
  repoId: string,
  dispatchKey: string,
): { readonly dispatchId: string; readonly runtimeSessionId: string; readonly dispatchOpId: string } {
  const hash = createHash("sha256").update(`${repoId}\0${dispatchKey}`).digest("hex");
  return {
    dispatchId: `dispatch_${hash.slice(0, 24)}`,
    runtimeSessionId: `runtime_${hash.slice(24, 48)}`,
    dispatchOpId: randomUUID(),
  };
}

/**
 * The mission every dispatched Decision reviewer carries. The registration's identity fields are
 * dispatch-bound — the center rejects any reviewId but `review-<dispatchId>`, any other digest, and
 * any other reportRef as actor_unauthorized — so the mission states them verbatim instead of
 * leaving the reviewer to guess, and marks only verdict, reason, findings, and evidenceChecked as
 * reviewer-authored.
 */
export function decisionReviewDispatchPrompt(input: {
  readonly decisionId: string;
  readonly digest: string;
  readonly dispatchId: string;
  readonly previousReview?: {
    readonly reviewId: string;
    readonly verdict: string;
    readonly reason: string;
    readonly findings: readonly { readonly findingId: string; readonly text: string; readonly anchor?: string }[];
    readonly reportRef: string | null;
  };
}): string {
  const { decisionId, digest, dispatchId } = input,
    reports = `decisions/decision-${decisionId}/artifacts/reports`;
  return [
    `Independently review Decision ${decisionId} at reviewContentDigest ${digest}.`,
    `Read the frozen accepted document at harness/decisions/decision-${decisionId}/decision.md.`,
    "Record approved or changes_requested with ha decision review; never accept, reject, defer, or amend.",
    reviewFindingCategoryPrompt,
    `Write the review report to harness/${reports}/${dispatchId}.md ` +
      `and the review input to harness/${reports}/${dispatchId}.json.`,
    `The review input's identity fields are fixed by this dispatch; any other value is rejected as ` +
      `actor_unauthorized. Use exactly reviewId review-${dispatchId}, reviewContentDigest ${digest}, ` +
      `reportRef harness/${reports}/${dispatchId}.md. ` +
      "Author only verdict, reason, findings, and evidenceChecked yourself.",
    decisionLifecycleProtocolCommands.find((command) => command.id === "decision-review")!.help,
    `Register with ha decision review ${decisionId} --from-file harness/${reports}/${dispatchId}.json.`,
    ...(input.previousReview
      ? [
          "Previous registered review context (verify each item against the new digest; it does not waive newly visible blockers):",
          `reviewId=${input.previousReview.reviewId} verdict=${input.previousReview.verdict} reason=${input.previousReview.reason}`,
          `findings=${JSON.stringify(input.previousReview.findings)}`,
          `reportRef=${input.previousReview.reportRef ?? "none"}`,
          reviewFindingScopePrompt("re-review"),
        ]
      : []),
  ].join("\n");
}

/**
 * The ledger root a task-bound reviewer can write: the mirrored authored root inside the checkout
 * the dispatch actually runs in. A workspace-write sandbox only permits writes under that checkout,
 * so the canonical authored root is not a usable destination. The token is rendered at launch time;
 * a fleet/node reviewer's relative authored prefix is a separate contract and stays untouched.
 */
function reviewArtifactRoot(cell: RepoCellOperationalContext): string {
  const layout = resolveHarnessLayout(cell.rootDir);
  return path.join(workerRootPathToken, worktreeAuthoredRelative(layout));
}

/** The review packet prompt every reviewer dispatch carries; each dispatch owns exactly one task. */
export function reviewDispatchPrompt(input: {
  readonly taskId: string;
  readonly packagePath: string;
  readonly dispatchId: string;
  readonly execution: ExecutionV1;
  readonly gates: readonly string[];
  readonly ownerNote?: string;
  /** Authored root inside the reviewer's checkout; rendered from `workerRootPathToken` at launch. */
  readonly artifactRoot?: string;
  /** Relative authored root for a reviewer in a different node's checkout. */
  readonly artifactPrefix?: string;
  /** Physical node facts used by the fleet placement contract; absent means canonical-local. */
  readonly implementationNodeId?: string;
  readonly reviewerNodeId?: string;
  /** The kernel reverify route of this cut; a `re-review` route scopes the mission to its findings. */
  readonly reverify?: ReviewReverifyRoute;
}): string {
  const { taskId, packagePath, dispatchId, execution, gates } = input,
    inapplicable = (execution.submission?.completionContract?.gates ?? [])
      .filter((gate) => !gateAppliesToSubmission(gate, execution.submission!))
      .map((gate) => gate.gateId),
    report = `${packagePath}/artifacts/reports/${dispatchId}.md`,
    packet = `${packagePath}/artifacts/reports/${dispatchId}.json`,
    reportFile = input.artifactRoot
      ? path.join(input.artifactRoot, report)
      : path.join(input.artifactPrefix ?? "harness", report),
    packetFile = input.artifactRoot
      ? path.join(input.artifactRoot, packet)
      : path.join(input.artifactPrefix ?? "harness", packet),
    riskReasonsPrompt = riskAssessmentGuidancePrompt(execution.submission?.riskTierAssessment);
  return [
    `Independently review task ${taskId}, execution ${execution.executionId}, ` + `iteration ${execution.iteration}.`,
    ...(input.ownerNote
      ? [
          "Owner adjudication context (independently verify it against the frozen contract and evidence; " +
            "it does not waive permissions or gates):\n" +
            input.ownerNote,
        ]
      : []),
    `The exact submission digest is ${submissionDigest(execution.submission!)}.`,
    `Implementation node: ${input.implementationNodeId ?? "canonical-local"}. Reviewer node: ${input.reviewerNodeId ?? "canonical-local"}. ` +
      "Keep these identities separate from the reviewer principal, Agent, instance, or model.",
    `Read ha task show ${taskId} --json and select execution ${execution.executionId} from executions. ` +
      "Its submission contains the authoritative delivery, frozen completion contract, and complete artifact anchors. " +
      "The prompt references that submission; it does not inline evidence or enumerate anchors.",
    "Read that task show's reviewAttribution index before attributing actions. Each recorded actor identifies " +
      "the ledger action only; an artifact's author or submitter does not identify actors described inside it. " +
      `Follow page.nextCursor with ha event list --entity task/${taskId} --cursor <cursor> --json, ` +
      "and use ha event show <opId> --json for the original event and its target. " +
      `Use ha task dispatches ${taskId} --json to corroborate runtime/execution bindings. ` +
      "A shared principal, task membership, or model/agent name never establishes executor identity or permission. " +
      "For an authorization finding, establish who performed which action, the constraints/authorization at that " +
      "time, and why the action exceeded them. An execution lease does not authorize external publication. " +
      "Owner read-only API activity must not be attributed to the worker; a worker's action is not excused by " +
      "sharing the owner's principal. External statements and unknown actors remain asserted/unverified until " +
      "corroborated by original service evidence (time, actor, method/endpoint and authorization). " +
      "An unknown actor is an evidence gap; a proven shared invariant violation may still block the delivery " +
      "without claiming worker misconduct.",
    "For every evidence source, record its node and whether you observed it directly. Frozen canonical artifacts may be " +
      "verified from the center projection; live device or Lab data from another node is unverified when that node is " +
      "unreachable. Mark the item `unverified` and name the missing node/source instead of treating a cross-node " +
      "difference as a contradiction. Only same-node, same-cut evidence checked from the named source can establish " +
      "a conflicting finding.",
    "For re-review, read the previous registered reviews and reports, this submission's frozen reviewResponses " +
      "and their referenced attribution evidence. Verify corrections against the exact cut; a rebuttal does not " +
      "waive unrelated findings. Responses must come from the current authorized implementation identity, " +
      "never by impersonating an old worker.",
    `The execution-frozen delivery baseline is ${JSON.stringify(execution.deliveryBaseline ?? null)}; it is ` +
      `${EXECUTION_DELIVERY_BASELINE_NOTE}. The delivered head is the submission's commitSha ` +
      "(null for artifact-only cuts); treat the baseline and the submission delivery as authoritative. " +
      "Read the G33 production-delta result for this cut " +
      "when frozen facts are present. Historical read conclusion: " +
      `${historicalReadConclusions[0]!.conclusion} ` +
      "Use the shared Kernel readSubmissionFacts result for legacy paths; do not reject a legacy cut solely for " +
      "absent frozen facts or compare either machine-derived value against closeout prose.",
    `Effective completion gates: ${gates.length ? gates.join(", ") : "none"}.`,
    "These are task completion requirements. Follow the repository's ordering of source review, " +
      "pre-merge checks, and post-merge verification. Distinguish observed check failures from pending " +
      "evidence: a witness produced only after merge is not a source defect merely because this review " +
      "runs before merge. Report unverified evidence without claiming a gate passed or waiving it.",
    ...(execution.submission?.riskTierAssessment?.effectiveTier === "medium"
      ? [
          "This is a medium-risk functional review. Request changes only for a behavior defect, data-loss or data-integrity risk, " +
            "or security risk. Treat wording, formatting, explanation quality, and missing narrative/evidence as non-blocking notes; " +
            "do not return the cut for those issues.",
        ]
      : execution.submission?.riskTierAssessment?.effectiveTier === "high"
        ? ["This is a high-risk review; inspect the full delivery and apply the complete reviewer declaration."]
        : []),
    ...(riskReasonsPrompt ? [riskReasonsPrompt] : []),
    ...(inapplicable.length ? [`Declared gates not applicable to this delivery: ${inapplicable.join(", ")}.`] : []),
    "Read the task plan, closeout, and submitted delivery yourself. " +
      `${input.reverify?.kind === "re-review" ? scopedReReviewPrompt(input.reverify) : reviewFindingScopePrompt("first")} ` +
      `${reviewFindingCategoryPrompt} ${reviewFindingReverifyPrompt} ` +
      "Record approved or changes_requested through RecordReview; never infer approval from provider success.",
    `Write this execution's review report to ${reportFile} and review input to ${packetFile}. ` +
      "These dispatch-specific paths replace any shared report path in your declaration.",
    derivedTaskActionProtocolCommands.find((command) => command.id === "task-review-execution")!.help,
    `Register with ha task review-execution ${taskId} --execution-id ${execution.executionId} ` +
      `--review-id review-${dispatchId} --from-file ${packetFile}.`,
    "Do not submit, consent, or complete. If the submitted cut changes, stop and report it; " +
      "do not review the replacement under this dispatch. If ha task review-execution returns error code " +
      "review_cut_superseded, the cut has been replaced; this error is terminal and must not be retried.",
  ].join("\n");
}

type DispatchStep = {
  readonly taskId: string;
  readonly executionId?: string;
  readonly requiredNodeId?: string;
  readonly dispatchId?: string;
  readonly runtimeSessionId?: string;
  readonly dispatchOpId?: string;
  /** The agent the step's dispatch carries, or the requested reviewer on a failed step. */
  readonly agentId?: string;
  /** The runtime instance the dispatch actually landed on, from its dispatch request. */
  readonly instanceId?: string;
  readonly outcome: OperationalStatus.ReviewDispatchStepOutcome;
  readonly error?: string;
  readonly reviewDispatchFailure?: TaskReviewDispatchFailureV1;
};

function readReviewAgent(cell: RepoCellOperationalContext, reviewerId: string, verticalId?: string) {
  try {
    return {
      kind: "resolved" as const,
      value: readAgentDeclarationResolution({
        rootDir: cell.rootDir,
        agentId: reviewerId,
        entityStore: createEntityStore(cell.store),
        verticalId: verticalId ?? cell.settings.readRepository().defaultVertical,
      }),
    };
  } catch (error) {
    if (!isAgentDeclarationInvalid(error)) throw error;
    return { kind: "invalid" as const, detail: error instanceof Error ? error.message : String(error) };
  }
}

function requireSubmittedReviewCut(
  cell: RepoCellOperationalContext,
  taskId: string,
  expected: ExecutionV1,
  submissionOpId: string | null,
): ExecutionV1 {
  const current = cell.projection.read(taskId).snapshot,
    execution = current.executions.find((value) => value.executionId === expected.executionId);
  if (
    current.task?.status !== "in_review" ||
    current.task.iteration !== expected.iteration ||
    execution?.state !== "submitted" ||
    !execution.submission ||
    cell.projection.readTaskSubmissionOperation(taskId, execution.executionId) !== submissionOpId
  )
    throw cell.cellCodedError("execution_scope_mismatch", "The submitted review cut was superseded.");
  return execution;
}

async function prepareReviewWorktree(cell: RepoCellOperationalContext, payload: JsonObject, commit: string | null) {
  const worktree = await cell.runtimeSpawner.prepareWorktree(payload, commit);
  if (worktree === null) await settleAuthoredMaterialization(cell.store, "dispatch task review");
  return worktree;
}

/**
 * The one review-dispatch spawn: the cut's frozen completionContract reviewer claim wins over the
 * repository default, and the key includes an explicit replacement reviewer when selected. Old
 * base-key rows remain reusable only for the same live reviewer and cut; launch admission is awaited
 * while provider completion is not. Returns the idempotent identities the caller reports on its
 * own step shape.
 */
export async function spawnCutReviewDispatch(
  cell: RepoCellOperationalContext,
  input: {
    readonly taskId: string;
    readonly execution: ExecutionV1;
    readonly packagePath: string;
    readonly binding: RepoCellBinding;
    readonly revision: number;
    readonly enqueuePublication?: RepoCellContinuationWrite;
    readonly reviewerId: string;
    readonly ownerNote?: string;
    readonly extras?: Readonly<Record<string, unknown>>;
    /** An explicit seat key for a replacement reviewer; absent selects the cut review key. */
    readonly dispatchKey?: string;
    /**
     * The seat's mission for one dispatch id; absent builds the cut review packet. The builder is
     * called per attempt so a fresh dispatch — including the resume fallback — names its own
     * registration id and report paths.
     */
    readonly promptFor?: (dispatchId: string) => string;
  },
): Promise<
  | {
      readonly outcome: Extract<OperationalStatus.ReviewDispatchStepOutcome, "dispatched" | "already_dispatched">;
      readonly ids: ReturnType<typeof reviewDispatchIds>;
    }
  | { readonly outcome: "failed"; readonly error: string }
> {
  const cutReviewKey = reviewDispatchKey(input.taskId, input.execution, input.reviewerId),
    submission = input.execution.submission!,
    submissionOpId = cell.projection.readTaskSubmissionOperation(input.taskId, input.execution.executionId);
  let key = input.dispatchKey ?? cutReviewKey,
    ids = reviewDispatchIds(cell.input.repoId, key),
    alreadyDispatched = false;
  const existing = cell.projection.readRuntimeDispatchByDispatchKey(key)?.event ?? null;
  if (existing !== null) {
    // One cut holds one live review seat. A row whose session already reached its terminal verdict
    // is spent — a resumed submit or an amendment that re-derives the same cut after its review was
    // cancelled must advance to the next attempt, exactly as `ha task dispatch-review` does, instead
    // of reporting the dead dispatch as if a reviewer were still running.
    const cutReviewed = cell.projection
      .read(input.taskId)
      .snapshot.reviews.some(
        (review) =>
          review.executionId === input.execution.executionId &&
          review.submissionDigest === submissionDigest(submission),
      );
    if (cutReviewed || !reviewAttemptEnded(cell, existing.payload.runtimeSessionId))
      return {
        outcome: "already_dispatched",
        ids: {
          dispatchId: existing.payload.dispatchId,
          runtimeSessionId: existing.payload.runtimeSessionId,
          dispatchOpId: existing.opId,
        },
      };
    const attempt = reviewDispatchAttempt(cell, key);
    if (attempt.existing !== null)
      return {
        outcome: "already_dispatched",
        ids: {
          dispatchId: attempt.existing.payload.dispatchId,
          runtimeSessionId: attempt.existing.payload.runtimeSessionId,
          dispatchOpId: attempt.existing.opId,
        },
      };
    key = attempt.key;
    ids = attempt.ids;
  }
  let resolved;
  try {
    resolved = readAgentDeclarationResolution({
      rootDir: cell.rootDir,
      agentId: input.reviewerId,
      entityStore: createEntityStore(cell.store),
      verticalId:
        cell.projection.read(input.taskId).snapshot.task?.metadata?.verticalId ??
        cell.settings.readRepository().defaultVertical,
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
    reverify = cutReverifyRoute(cell.projection.read(input.taskId).snapshot, input.execution),
    continuation = previousReviewerContinuation(cell, {
      taskId: input.taskId,
      reviewerId: input.reviewerId,
      dispatchKey: key,
      packagePath: input.packagePath,
    }),
    continuationWorkspaceReport =
      continuation === null ? null : documentWorkspacePath(cell.rootDir, continuation.reportRef),
    continuationNote = continuation
      ? [
          "This is a re-review of the same task and reviewer seat.",
          `Read the previous registered report at ${continuationWorkspaceReport} with ha doc show --path ${continuationWorkspaceReport} --raw.`,
          ...(continuation.review
            ? [
                `Previous review ${continuation.review.reviewId}: verdict=${continuation.review.verdict}; reason=${continuation.review.reason}.`,
                `Previous findings: ${JSON.stringify(continuation.review.findings ?? [])}.`,
              ]
            : []),
          // A scoped route already carries its re-review rule in the mission body.
          ...(reverify.kind === "re-review" ? [] : [reviewFindingScopePrompt("re-review")]),
        ].join("\n")
      : "",
    // The mission text and its registration identity are one value: whatever dispatch id the
    // spawner renders is the id the reviewer must register under, so the prompt is always
    // rebuilt from that id instead of being carried over from an earlier attempt.
    missionPrompt = (dispatchId: string): string =>
      `${
        input.promptFor?.(dispatchId) ??
        reviewDispatchPrompt({
          ownerNote: input.ownerNote,
          taskId: input.taskId,
          packagePath: input.packagePath,
          dispatchId,
          execution: input.execution,
          gates: completionGateIds(
            cell.projection.read(input.taskId).snapshot.task?.completionGateIds ?? [],
            input.execution.submission,
          ),
          artifactRoot: reviewArtifactRoot(cell),
          reverify,
        })
      }${continuationNote ? `\n${continuationNote}` : ""}`,
    selectionHints = taskReviewSelectionHints(cell, {
      taskId: input.taskId,
      executionId: input.execution.executionId,
      reviewerId: input.reviewerId,
      dispatchKey: key,
      packagePath: input.packagePath,
      continuation,
      explicitInstanceId: extras.runtimeInstanceId,
      explicitModel: extras.model,
    }),
    payload = {
      agentId: agent.id,
      role: "reviewer",
      taskId: input.taskId,
      executionId: input.execution.executionId,
      dispatchKey: key,
      ...selectionHints,
      ...(continuation?.resume ? { dispatchId: continuation.dispatchId } : {}),
      ...(typeof extras.runtimeInstanceId === "string" ? { runtimeInstanceId: extras.runtimeInstanceId } : {}),
      ...(typeof extras.model === "string" ? { model: extras.model } : {}),
      ...(typeof extras.effort === "string" ? { effort: extras.effort } : {}),
      ...(extras.fast === true ? { fast: true } : {}),
      prompt: missionPrompt(ids.dispatchId),
    },
    enqueuePublication = async (
      attemptPayload: typeof payload,
      effect: (authorizationDecision: import("@harness-anything/kernel").AuthorizationDecision) => Promise<unknown>,
    ) => {
      const apply = async (authorizedBinding?: RepoCellBinding): Promise<WriteReceiptDraft> => {
        const execution = requireSubmittedReviewCut(cell, input.taskId, input.execution, submissionOpId);
        const existing = cell.projection.readRuntimeDispatchByDispatchKey(attemptPayload.dispatchKey)?.event;
        if (existing) {
          ids = {
            dispatchId: existing.payload.dispatchId,
            runtimeSessionId: existing.payload.runtimeSessionId,
            dispatchOpId: existing.opId,
          };
          return { outcome: "no_changes", opId: existing.opId } as WriteReceiptDraft;
        }
        if (input.dispatchKey === undefined || key === cutReviewKey) {
          const holding = activeCutReviewDispatches(cell, input.taskId, execution).at(-1)?.event;
          if (holding?.payload.agentId === input.reviewerId) {
            ids = {
              dispatchId: holding.payload.dispatchId,
              runtimeSessionId: holding.payload.runtimeSessionId,
              dispatchOpId: holding.opId,
            };
            return { outcome: "no_changes", opId: holding.opId } as WriteReceiptDraft;
          }
          if (holding && input.dispatchKey === undefined)
            throw cell.cellCodedError(
              "review_dispatch_failed",
              `Task ${input.taskId}'s submitted cut already holds review dispatch ${holding.payload.dispatchId} by agent ` +
                `${holding.payload.agentId ?? "with no recorded agent"} (runtime session ${holding.payload.runtimeSessionId}); ` +
                `reviewer ${input.reviewerId} was not dispatched. ` +
                "Retry after that review session ends.",
            );
        }
        const authorizationDecision = authorizedBinding?.authorizationDecision
          ? authorizedBinding.authorizationDecision
          : await evaluateRepoCellAction({
              action: { kind: "runtime-spawn", ...attemptPayload },
              repoId: cell.input.repoId,
              binding: input.binding,
              actionId: reviewDispatchIds(cell.input.repoId, attemptPayload.dispatchKey).dispatchOpId,
              revision: cell.store.readHead()?.revision ?? 0,
              now: cell.now(),
              readTask: (taskId) => cell.projection.read(taskId).snapshot.task,
            });
        if (authorizationDecision.outcome !== "allowed")
          throw cell.cellCodedError(
            "authorization_denied",
            `authorization_denied: ${authorizationDecision.nextActions.join(" ")}`,
          );
        return (await effect(authorizationDecision)) as WriteReceiptDraft;
      };
      const receipt = await (input.enqueuePublication
        ? input
            .enqueuePublication({ kind: "runtime-spawn", ...attemptPayload }, input.binding, apply)
            .catch((error) => {
              if (runtimeErrorCode(error) !== "authorization_denied") throw error;
              throw cell.cellCodedError(
                "authorization_denied",
                `authorization_denied: ${error instanceof Error ? error.message : String(error)}`,
              );
            })
        : apply());
      if (receipt.outcome === "no_changes") alreadyDispatched = true;
      if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes")
        throw cell.cellCodedError(
          receipt.code ?? "review_dispatch_failed",
          `${receipt.code === "authorization_denied" ? "authorization_denied: " : ""}${receipt.rejectionExplanation ?? "Review dispatch failed."}`,
        );
    },
    prepareAndLaunch = async (attemptPayload: typeof payload): Promise<void> => {
      const worktree = await prepareReviewWorktree(cell, attemptPayload, submission.commitSha);
      await enqueuePublication(attemptPayload, async (authorizationDecision) => {
        if (worktree === null) requireTaskPackageMaterialization(cell, input.taskId);
        return cell.runtimeSpawner.spawn(attemptPayload, { ...input.binding, authorizationDecision }, worktree);
      });
    };
  try {
    await prepareAndLaunch(payload);
  } catch (error) {
    if (continuation?.resume && runtimeErrorCode(error) === "runtime_resume_failed") {
      const fallbackKey = `${key}:resume-fallback`,
        fallbackIds = reviewDispatchIds(cell.input.repoId, fallbackKey),
        fallbackPayload = {
          ...payload,
          dispatchKey: fallbackKey,
          prompt:
            `${missionPrompt(fallbackIds.dispatchId)}\n` +
            "The provider could not resume the prior session; this is a fresh session. " +
            `Write and register this round as review-${fallbackIds.dispatchId} at the paths named above.`,
        };
      delete (fallbackPayload as { dispatchId?: string }).dispatchId;
      const fallbackError = await prepareAndLaunch(fallbackPayload).then(
        () => null,
        (error: unknown) => error,
      );
      if (fallbackError !== null) {
        consumeKnownError(fallbackError);
        return {
          outcome: "failed",
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        };
      }
      return {
        outcome: alreadyDispatched ? "already_dispatched" : "dispatched",
        ids: alreadyDispatched ? ids : fallbackIds,
      };
    } else {
      consumeKnownError(error);
      return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { outcome: alreadyDispatched ? "already_dispatched" : "dispatched", ids };
}

/** The idempotent attempt chain of one review cut: advance only after the prior session ended. */
function reviewDispatchAttempt(cell: RepoCellOperationalContext, baseKey: string) {
  let attempt = 0,
    key = reviewAttemptKey(baseKey, attempt),
    ids = reviewDispatchIds(cell.input.repoId, key),
    existing = cell.projection.readRuntimeDispatchByDispatchKey(key)?.event ?? null;
  while (existing !== null && reviewAttemptEnded(cell, existing.payload.runtimeSessionId)) {
    attempt += 1;
    key = reviewAttemptKey(baseKey, attempt);
    ids = reviewDispatchIds(cell.input.repoId, key);
    existing = cell.projection.readRuntimeDispatchByDispatchKey(key)?.event ?? null;
  }
  return {
    key,
    ids:
      existing === null
        ? ids
        : {
            dispatchId: existing.payload.dispatchId,
            runtimeSessionId: existing.payload.runtimeSessionId,
            dispatchOpId: existing.opId,
          },
    existing,
  };
}

/**
 * The automatic reviewer dispatch for a task's in-review cut, after a durable write that left the
 * cut without a current review: submit, amend, resumed submit, and an owner's explicit reviewer
 * selection. Returns null outside the in-review gate. A dispatch failure never undoes the durable
 * write: it lands as the returned step with the idempotent `ha task dispatch-review` retry lane.
 *
 * The seat comes from `reviewSeatForCut`, the same function `ha task dispatch-review` uses, so a
 * professional path reviewer that the cut hits takes the one seat instead of a second review gate.
 */
export async function dispatchInReviewCutReview(
  cell: RepoCellOperationalContext,
  taskId: string,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  receipt: WriteReceiptDraft,
  enqueuePublication?: RepoCellContinuationWrite,
  submissionOpId?: string,
): Promise<{
  readonly seat?: ReviewSeat;
  readonly step: WriteReceiptDraft;
  readonly warnings: readonly string[];
} | null> {
  const current = await cell.service.read(taskId);
  if (current.snapshot.task?.status !== "in_review") return null;
  const execution = current.snapshot.executions.find(
    (value) => value.iteration === current.snapshot.task?.iteration && value.state === "submitted",
  );
  if (!execution?.submission || !current.packagePath) return null;
  if (submissionOpId && cell.projection.readTaskSubmissionOperation(taskId, execution.executionId) !== submissionOpId)
    return null;
  const reverify = cutReverifyRoute(current.snapshot, execution);
  // dec_BEFCF7D0484E901F187C2C8EC6 CH2: a resubmission whose previous blocking findings are all
  // owner-verify and adopted waits on the owner's verification; only an explicit reviewer selection
  // dispatches one.
  if (reverify.kind === "owner-verify" && typeof action.reviewer !== "string") {
    const cited = reverify.reviews.at(-1)!.reviewId,
      warning =
        `Task ${taskId}'s previous blocking findings are all owner-verify and adopted; no reviewer was dispatched. ` +
        `The task owner verifies the fixes and consents with ha task review-consent ${taskId} ` +
        `--execution-id ${execution.executionId} --review-id ${cited} --dispose ${cited} --rationale <what was verified>.`;
    return {
      step: {
        ...receipt,
        warnings: [...((receipt as { readonly warnings?: readonly string[] }).warnings ?? []), warning],
      } as WriteReceiptDraft,
      warnings: [warning],
    };
  }
  const selection = reviewSeatForCut({
    cell,
    execution,
    taskReviewer: current.snapshot.task.reviewer,
    argument: typeof action.reviewer === "string" ? action.reviewer : undefined,
  });
  if (selection.kind === "escalated")
    return {
      seat: { reviewerId: selection.reviewers.join(", "), source: "path" },
      step: cell.failed(
        receipt.opId,
        cell.cellCodedError(
          "review_dispatch_failed",
          `${selection.reason} Ask the CEO to select a reviewer with ha task dispatch-review ${taskId} --agent <agent-id>; workers cannot dispatch reviewers.`,
        ),
      ),
      warnings: [selection.reason],
    };
  const placement = taskExecutionPlacement(cell, taskId, execution.executionId);
  if (placement.kind === "node") {
    const failure =
      current.snapshot.task.reviewDispatchFailure?.executionId === execution.executionId
        ? current.snapshot.task.reviewDispatchFailure
        : undefined;
    const step = {
      ...receipt,
      ...(failure ? { reviewDispatchFailure: failure } : {}),
      outcome: "pending",
      continuation: {
        mode: "pending",
        outcome: "pending",
        requiredNodeId: placement.nodeId,
        taskId,
        executionId: execution.executionId,
      },
      warnings: [
        ...((receipt as { readonly warnings?: readonly string[] }).warnings ?? []),
        failure
          ? reviewDispatchFailureWarning(failure)
          : `Task ${taskId} review is pending on implementation node ${placement.nodeId}; the center did not create a runtime dispatch.`,
      ],
    } as WriteReceiptDraft;
    return {
      seat: selection.seat,
      step,
      warnings: [
        failure
          ? reviewDispatchFailureWarning(failure)
          : `Task ${taskId} review is pending on implementation node ${placement.nodeId}; it will dispatch when that node is online.`,
      ],
    };
  }
  if (placement.kind === "unresolved") {
    const warning = `Task ${taskId} review is pending: ${placement.reason}; the center did not create a runtime dispatch.`;
    return {
      seat: selection.seat,
      step: {
        ...receipt,
        outcome: "pending",
        warnings: [...((receipt as { readonly warnings?: readonly string[] }).warnings ?? []), warning],
      } as WriteReceiptDraft,
      warnings: [warning],
    };
  }
  const { seat } = selection,
    { reviewerId } = seat,
    pathSeat = seat.source === "path",
    dispatch = await spawnCutReviewDispatch(cell, {
      taskId,
      execution,
      packagePath: current.packagePath,
      binding,
      revision: cell.store.readHead()?.revision ?? 0,
      ...(enqueuePublication ? { enqueuePublication } : {}),
      reviewerId,
      ...(typeof action.reviewer === "string" ? { dispatchKey: reviewDispatchKey(taskId, execution, reviewerId) } : {}),
      ...(typeof action.reason === "string" ? { ownerNote: action.reason } : {}),
      ...(pathSeat
        ? {
            promptFor: (dispatchId: string): string =>
              `${reviewDispatchPrompt({
                taskId,
                packagePath: current.packagePath!,
                dispatchId,
                execution,
                gates: completionGateIds(current.snapshot.task!.completionGateIds, execution.submission),
                ...(typeof action.reason === "string" ? { ownerNote: action.reason } : {}),
                artifactRoot: reviewArtifactRoot(cell),
                reverify,
              })}\n${reviewPathSeatPrompt({ seat })}`,
          }
        : {}),
      // The same reviewer-resource pins dispatch-review takes: an unpinned reviewer declaration
      // would otherwise land on an unpredictable default instance.
      extras: {
        ...(typeof action.runtimeInstanceId === "string" ? { runtimeInstanceId: action.runtimeInstanceId } : {}),
        ...(typeof action.model === "string" ? { model: action.model } : {}),
      },
    }),
    // The step mirrors the historical review-dispatch receipt shape (dispatchId/runtimeSessionId
    // ride the draft the same way dispatch-review's steps do).
    step: WriteReceiptDraft =
      dispatch.outcome === "failed"
        ? cell.failed(
            receipt.opId,
            cell.cellCodedError(
              "review_dispatch_failed",
              `Task ${taskId} is already in_review. Reviewer ${reviewerId} dispatch failed: ${dispatch.error} ` +
                `Ask the CEO to recover with ha task dispatch-review ${taskId} --agent ${reviewerId}. ` +
                "Workers cannot dispatch reviewers; give the CEO this submit receipt.",
            ),
          )
        : ({
            ...receipt,
            dispatchId: dispatch.ids.dispatchId,
            runtimeSessionId: dispatch.ids.runtimeSessionId,
          } as WriteReceiptDraft);
  return {
    seat,
    step,
    warnings:
      dispatch.outcome === "failed"
        ? [
            `Task ${taskId}'s review seat ${reviewerId} dispatch failed: ${dispatch.error ?? "unknown error"}. ` +
              `Ask the CEO to recover with ha task dispatch-review ${taskId}. ` +
              "Workers cannot dispatch reviewers; give the CEO this submit receipt.",
          ]
        : dispatch.outcome === "already_dispatched"
          ? [
              `Task ${taskId} already holds review dispatch ${dispatch.ids.dispatchId} ` +
                `(runtime session ${dispatch.ids.runtimeSessionId}); no new reviewer was dispatched.`,
            ]
          : [],
  };
}

/**
 * `ha task dispatch-review`: expand one batch invocation into one independent reviewer dispatch per
 * task. Each dispatch is keyed by the task's submitted cut and binds to that execution only — never
 * to the task's active implementation lease — so a review cannot open or claim an implementation
 * iteration.
 *
 * The seat per task comes from `reviewSeatForCut`, the same function the automatic submit dispatch
 * uses. A cut therefore holds one seat whichever path dispatched it, and a seat that was cancelled
 * or failed can be re-dispatched alone with `--agent <seat>` without inheriting another reviewer.
 */
export async function prepareTaskReviewDispatch(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
) {
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
  const reviewerFromArgument =
      typeof action.agentId === "string" && action.agentId.length > 0 ? action.agentId : undefined,
    revision = cell.store.readHead()?.revision ?? 0,
    steps: (DispatchStep | PreparedTaskReview)[] = [],
    warnings: string[] = [];
  let materializationFailures = 0;
  for (const taskId of taskIds) {
    const fail = (error: string, reviewerId: string, executionId?: string) =>
      steps.push({
        taskId,
        agentId: reviewerId,
        ...(executionId ? { executionId } : {}),
        outcome: "failed",
        error,
      });
    const read = requireCurrentTaskProjection(cell.projection, taskId, "task dispatch-review"),
      snapshot = read.snapshot,
      candidates = currentSubmittedExecutions(snapshot);
    if (snapshot.task?.status !== "in_review") {
      fail(
        snapshot.task?.status === "submitted"
          ? `Task ${taskId} has no automatic review requirement; its cut lifted review. Complete it with ` +
              `ha task complete ${taskId}.`
          : `Task ${taskId} is not at the in-review gate.`,
        reviewerFromArgument ?? snapshot.task?.reviewer ?? "closeout-reviewer",
      );
      continue;
    }
    let execution: ExecutionV1 | undefined;
    if (executionSelector !== undefined) {
      execution = candidates.find((candidate) => candidate.executionId === executionSelector);
      if (execution === undefined) {
        fail(
          `Execution ${executionSelector} is not a submitted cut on task ${taskId}'s current iteration.`,
          reviewerFromArgument ?? "closeout-reviewer",
          executionSelector,
        );
        continue;
      }
    } else if (candidates.length === 0) {
      fail(
        `Task ${taskId} has no submitted execution to review. A review dispatch binds to a submitted ` +
          "cut; submit the implementation first.",
        reviewerFromArgument ?? "closeout-reviewer",
      );
      continue;
    } else if (candidates.length > 1) {
      fail(
        `Task ${taskId} has ${String(candidates.length)} submitted executions on its current iteration. ` +
          "Dispatch each review explicitly with --execution-id.",
        reviewerFromArgument ?? "closeout-reviewer",
      );
      continue;
    } else execution = candidates[0]!;
    const selection = reviewSeatForCut({
      cell,
      execution,
      taskReviewer: snapshot.task?.reviewer,
      argument: reviewerFromArgument,
    });
    if (selection.kind === "escalated") {
      fail(selection.reason, selection.reviewers.join(", "), execution.executionId);
      continue;
    }
    const { seat } = selection,
      { reviewerId } = seat;
    const placement = taskExecutionPlacement(cell, taskId, execution.executionId);
    if (placement.kind === "unresolved") {
      steps.push({
        taskId,
        executionId: execution.executionId,
        agentId: reviewerId,
        outcome: "pending",
      });
      warnings.push(`Task ${taskId} review is pending: ${placement.reason}; no runtime dispatch was created.`);
      continue;
    }
    const agentResolution = readReviewAgent(cell, reviewerId, snapshot.task.metadata?.verticalId);
    if (agentResolution.kind === "invalid") {
      fail(agentResolution.detail, reviewerId, execution.executionId);
      continue;
    }
    const resolved = agentResolution.value;
    if (!resolved) {
      fail(
        `Reviewer ${reviewerId} is not bundled or installed. Install a repository override, or select an ` +
          `available reviewer with ha task dispatch-review ${taskId} --agent <agent-id>.`,
        reviewerId,
        execution.executionId,
      );
      continue;
    }
    const { declaration: agent, layer } = resolved;
    if (layer === "installed" && !agentDeclaresExplicitModels(agent.runtimes) && typeof action.model !== "string") {
      fail(
        `Declare an explicit model on every runtimes row for reviewer ${reviewerId}, or pass --model <model>. ` +
          "Installed reviewer overrides must not select an instance default model.",
        reviewerId,
        execution.executionId,
      );
      continue;
    }
    const { key, ids, existing } = reviewDispatchAttempt(cell, reviewDispatchKey(taskId, execution, reviewerId));
    const inFlight = activeCutReviewDispatches(cell, taskId, execution).at(-1)?.event ?? null;
    if (inFlight !== null && existing === null) {
      const holdingAgent = typeof inFlight.payload.agentId === "string" ? inFlight.payload.agentId : null;
      if (reviewerFromArgument !== undefined && holdingAgent !== agent.id) {
        fail(
          `Task ${taskId}'s submitted cut already holds review dispatch ${inFlight.payload.dispatchId} by agent ` +
            `${holdingAgent ?? "with no recorded agent"} (runtime session ${inFlight.payload.runtimeSessionId}, ` +
            `instance ${inFlight.payload.instanceId}); --agent ${reviewerId} was not dispatched. Re-run ` +
            `ha task dispatch-review ${taskId} --agent ${reviewerId} after that review session ends.`,
          reviewerId,
          execution.executionId,
        );
        continue;
      }
      steps.push({
        taskId,
        executionId: execution.executionId,
        dispatchId: inFlight.payload.dispatchId,
        runtimeSessionId: inFlight.payload.runtimeSessionId,
        dispatchOpId: inFlight.opId,
        ...(holdingAgent === null ? {} : { agentId: holdingAgent }),
        instanceId: inFlight.payload.instanceId,
        outcome: "already_dispatched",
      });
      continue;
    }
    if (existing !== null) {
      // One submitted cut holds one review dispatch at a time, so an explicit --agent must never
      // masquerade as another agent's in-flight dispatch: refuse naming both agents instead.
      const holdingAgent = typeof existing.payload.agentId === "string" ? existing.payload.agentId : null;
      if (reviewerFromArgument !== undefined && holdingAgent !== agent.id) {
        fail(
          `Task ${taskId}'s submitted cut already holds review dispatch ${existing.payload.dispatchId} by agent ` +
            `${holdingAgent ?? "with no recorded agent"} (runtime session ${existing.payload.runtimeSessionId}, ` +
            `instance ${existing.payload.instanceId}); --agent ${reviewerId} was not dispatched. Re-run ` +
            `ha task dispatch-review ${taskId} --agent ${reviewerId} after that review session ends.`,
          reviewerId,
          execution.executionId,
        );
        continue;
      }
      steps.push({
        taskId,
        executionId: execution.executionId,
        dispatchId: ids.dispatchId,
        runtimeSessionId: ids.runtimeSessionId,
        dispatchOpId: existing.opId,
        ...(holdingAgent === null ? {} : { agentId: holdingAgent }),
        instanceId: existing.payload.instanceId,
        outcome: "already_dispatched",
      });
      continue;
    }
    const submissionOpId = cell.projection.readTaskSubmissionOperation(taskId, execution.executionId),
      target = { taskId, execution, submissionOpId, reviewerId, placement };
    if (placement.kind === "node") {
      const intent: TaskReviewDispatchIntentV1 = {
        executionId: execution.executionId,
        reviewerId,
        ...(typeof action.runtimeInstanceId === "string" ? { runtimeInstanceId: action.runtimeInstanceId } : {}),
        ...(typeof action.model === "string" ? { model: action.model } : {}),
        ...(typeof action.effort === "string" ? { effort: action.effort as TaskReviewDispatchIntentV1["effort"] } : {}),
        ...(typeof action.fast === "boolean" ? { fast: action.fast } : {}),
      };
      const failure =
        snapshot.task?.reviewDispatchFailure?.executionId === execution.executionId
          ? snapshot.task.reviewDispatchFailure
          : undefined;
      steps.push({ ...target, kind: "node", nodeId: placement.nodeId, intent, failure });
      continue;
    }
    const seatPrompt = seat.source === "path" ? reviewPathSeatPrompt({ seat }) : null,
      selectionHints = taskReviewSelectionHints(cell, {
        taskId,
        executionId: execution.executionId,
        reviewerId,
        dispatchKey: key,
        packagePath: read.packagePath,
        explicitInstanceId: action.runtimeInstanceId,
        explicitModel: action.model,
      }),
      payload = {
        agentId: agent.id,
        role: "reviewer",
        taskId,
        executionId: execution.executionId,
        dispatchKey: key,
        ...selectionHints,
        ...(typeof action.runtimeInstanceId === "string" ? { runtimeInstanceId: action.runtimeInstanceId } : {}),
        ...(typeof action.model === "string" ? { model: action.model } : {}),
        ...(typeof action.effort === "string" ? { effort: action.effort } : {}),
        ...(typeof action.fast === "boolean" ? { fast: action.fast } : {}),
        prompt:
          reviewDispatchPrompt({
            taskId,
            packagePath: read.packagePath,
            dispatchId: ids.dispatchId,
            execution,
            gates: completionGateIds(snapshot.task!.completionGateIds, execution.submission),
            artifactRoot: reviewArtifactRoot(cell),
          }) + (seatPrompt === null ? "" : `\n${seatPrompt}`),
      };
    const decision = await authorizeTaskReviewSpawn(cell, payload, binding, ids.dispatchOpId);
    if (decision.outcome !== "allowed") {
      fail(`authorization_denied: ${decision.nextActions.join(" ")}`, reviewerId, execution.executionId);
      continue;
    }
    const checkout = await prepareReviewWorktree(cell, payload, execution.submission?.commitSha ?? null).then(
      (worktree) => ({ kind: "ready" as const, worktree }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    if (checkout.kind === "failed") {
      const { error } = checkout,
        code = runtimeErrorCode(error);
      if (code === "materialization_failed") materializationFailures += 1;
      fail(error instanceof Error ? error.message : String(error), reviewerId, execution.executionId);
      continue;
    }
    steps.push({ ...target, kind: "local", payload, ids, worktree: checkout.worktree });
  }
  return { steps, warnings, revision, materializationFailures };
}

type PreparedTaskReview = {
  readonly taskId: string;
  readonly execution: ExecutionV1;
  readonly submissionOpId: string | null;
  readonly reviewerId: string;
  readonly placement: ReturnType<typeof taskExecutionPlacement>;
} & (
  | {
      readonly kind: "node";
      readonly nodeId: string;
      readonly intent: TaskReviewDispatchIntentV1;
      readonly failure: TaskReviewDispatchFailureV1 | undefined;
    }
  | {
      readonly kind: "local";
      readonly payload: JsonObject & { readonly dispatchKey: string; readonly agentId: string };
      readonly ids: ReturnType<typeof reviewDispatchIds>;
      readonly worktree: Awaited<ReturnType<typeof prepareReviewWorktree>>;
    }
);

function authorizeTaskReviewSpawn(
  cell: RepoCellOperationalContext,
  payload: JsonObject,
  binding: RepoCellBinding,
  dispatchOpId: string,
) {
  return evaluateRepoCellAction({
    action: { kind: "runtime-spawn", ...payload },
    repoId: cell.input.repoId,
    binding,
    actionId: dispatchOpId,
    revision: cell.store.readHead()?.revision ?? 0,
    now: cell.now(),
    readTask: (taskId) => cell.projection.read(taskId).snapshot.task,
  });
}

/** Publish the prepared review batch at the authorized writer cut. */
export async function dispatchTaskReview(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  prepared: Awaited<ReturnType<typeof prepareTaskReviewDispatch>>,
): Promise<WriteReceiptDraft> {
  const { revision } = prepared,
    steps: DispatchStep[] = [],
    warnings = [...prepared.warnings];
  let { materializationFailures } = prepared;
  for (const step of prepared.steps) {
    if (!("execution" in step)) {
      steps.push(step);
      continue;
    }
    const { taskId, execution, submissionOpId, reviewerId, placement } = step,
      { executionId } = execution;
    try {
      const current = requireSubmittedReviewCut(cell, taskId, execution, submissionOpId);
      if (!samePlacement(placement, taskExecutionPlacement(cell, taskId, executionId)))
        throw cell.cellCodedError("execution_scope_mismatch", "Review placement changed. Retry the dispatch.");
      if (step.kind === "node") {
        const receipt = cell.taskSurfaceWrite(
          {
            kind: "task-amend",
            taskId,
            patches: [
              { field: "reviewDispatchIntent", value: JSON.stringify(step.intent) },
              { field: "reviewDispatchFailure", value: "null" },
            ],
          },
          binding,
        );
        if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes")
          throw cell.cellCodedError(
            "review_dispatch_failed",
            `Task ${taskId} review intent could not be persisted on implementation node ${step.nodeId}.`,
          );
        steps.push({
          taskId,
          executionId,
          requiredNodeId: step.nodeId,
          agentId: reviewerId,
          outcome: "pending",
          ...(step.failure ? { reviewDispatchFailure: step.failure } : {}),
        });
        warnings.push(
          step.failure
            ? `Previous attempt: ${reviewDispatchFailureWarning(step.failure)}`
            : `Task ${taskId} review is pending on implementation node ${step.nodeId}.`,
        );
        continue;
      }
      const { payload, ids, worktree } = step,
        key = payload.dispatchKey,
        holding =
          cell.projection.readRuntimeDispatchByDispatchKey(key)?.event ??
          activeCutReviewDispatches(cell, taskId, current).at(-1)?.event;
      if (holding) {
        if (
          typeof action.agentId === "string" &&
          action.agentId.length > 0 &&
          holding.payload.agentId !== payload.agentId
        )
          throw cell.cellCodedError(
            "review_dispatch_failed",
            `Task ${taskId}'s review seat was taken by ${holding.payload.agentId}. Retry after it finishes.`,
          );
        steps.push({
          taskId,
          executionId,
          dispatchId: holding.payload.dispatchId,
          runtimeSessionId: holding.payload.runtimeSessionId,
          dispatchOpId: holding.opId,
          ...(holding.payload.agentId ? { agentId: holding.payload.agentId } : {}),
          instanceId: holding.payload.instanceId,
          outcome: "already_dispatched",
        });
        continue;
      }
      const authorizationDecision = await authorizeTaskReviewSpawn(cell, payload, binding, ids.dispatchOpId);
      if (authorizationDecision.outcome !== "allowed")
        throw cell.cellCodedError("authorization_denied", authorizationDecision.nextActions.join(" "));
      if (worktree === null) requireTaskPackageMaterialization(cell, taskId);
      const spawned = await cell.runtimeSpawner.spawn(payload, { ...binding, authorizationDecision }, worktree),
        selection = spawned.runtimeSelection;
      if (selection !== null && typeof selection === "object" && !Array.isArray(selection)) {
        const reason = "reason" in selection && typeof selection.reason === "string" ? selection.reason : undefined;
        if (reason?.includes("resolves to")) {
          const instanceId = "instanceId" in selection ? String(selection.instanceId) : "unknown",
            basis = "basis" in selection && typeof selection.basis === "string" ? ` (${selection.basis})` : "";
          warnings.push(`runtime instance: ${instanceId}${basis} — ${reason}`);
        }
      }
      const dispatched = cell.projection.readRuntimeDispatchByDispatchKey(key)?.event;
      steps.push({
        taskId,
        executionId,
        dispatchId: ids.dispatchId,
        runtimeSessionId: ids.runtimeSessionId,
        dispatchOpId: ids.dispatchOpId,
        agentId: payload.agentId,
        ...(dispatched === undefined ? {} : { instanceId: dispatched.payload.instanceId }),
        outcome: "dispatched",
      });
    } catch (error) {
      consumeKnownError(error);
      const code = runtimeErrorCode(error),
        detail = error instanceof Error ? error.message : String(error);
      if (code === "materialization_failed") materializationFailures += 1;
      steps.push({
        taskId,
        executionId,
        agentId: reviewerId,
        outcome: "failed",
        error: code === "authorization_denied" ? `authorization_denied: ${detail}` : detail,
      });
    }
  }
  const dispatchedTasks = new Set(
      steps
        .filter((step) => ["dispatched", "already_dispatched", "already_reviewed"].includes(step.outcome))
        .map((step) => step.taskId),
    ),
    pending = steps.filter((step) => step.outcome === "pending"),
    failed = steps.filter((step) => step.outcome === "failed");
  return {
    outcome: dispatchedTasks.size > 0 ? "applied" : pending.length > 0 ? "pending" : "op_rejected",
    opId: cell.operationId(action, binding, cell.input.repoId, revision),
    revision,
    ...(failed.length === 0
      ? {}
      : { code: materializationFailures === steps.length ? "materialization_failed" : "review_dispatch_failed" }),
    ...(failed.length === 0 && warnings.length === 0
      ? {}
      : { warnings: [...warnings, ...failed.map((step) => `${step.taskId}: ${step.error ?? ""}`)] }),
    ...(failed.length === steps.length
      ? { rejectionExplanation: failed.map((step) => `${step.taskId}: ${step.error ?? ""}`).join("; ") }
      : {}),
    summary:
      `dispatch-review: ${String(dispatchedTasks.size)} of ${String(steps.length)} task(s) have a review dispatch; ` +
      `${String(pending.length)} are pending on their implementation node.`,
    dispatches: steps,
  } as WriteReceiptDraft;
}
