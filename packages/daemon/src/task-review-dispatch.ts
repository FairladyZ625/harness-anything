import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  completionGateIds,
  consumeKnownError,
  gateAppliesToSubmission,
  createEntityStore,
  currentSubmittedExecutions,
  historicalReadConclusions,
  resolveHarnessLayout,
  submissionDigest,
  decisionReviewContentDigest,
  type ExecutionV1,
  type ReviewV1,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import { derivedTaskActionProtocolCommands } from "./protocol/daemon-protocol-commands-task.ts";
import { decisionLifecycleProtocolCommands } from "./protocol/daemon-protocol-commands-decision-lifecycle.ts";
import { isAgentDeclarationInvalid, readAgentDeclarationResolution } from "./agent-entities.ts";
import { agentDeclaresExplicitModels } from "./agent-runtime-contract.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { reviewFindingCategoryPrompt, reviewFindingScopePrompt } from "./review-prompt-guidance.ts";
import { selectReviewSeat, type ReviewSeat, type ReviewSeatSelection } from "./review-panel.ts";
import { reviewPathSeatPrompt } from "./review-path-matching.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import { runtimeErrorCode } from "./runtime-spawn-errors.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

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

/** Cut-review keys are qualified by reviewer so rerouting cannot reuse another reviewer's session. */
export function reviewDispatchKey(taskId: string, execution: ExecutionV1, reviewerId?: string): string {
  const key = `task-review:${taskId}:${execution.executionId}:${execution.iteration}:${submissionDigest(
    execution.submission!,
  )}`;
  return reviewerId ? `${key}:reviewer:${reviewerId}` : key;
}

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
    throw cell.cellCodedError(
      "version_conflict",
      `Decision review content changed: expected=${action.expectedDigest} current=${digest}.`,
    );
  const baseKey = decisionReviewDispatchKey(decisionId, digest),
    revision = cell.store.readHead()?.revision ?? 0;
  const activeDecisionDispatch = cell.projection.readRuntimeDispatchesByDecision(decisionId).find(({ event }) => {
    const target = event.payload.reviewTarget;
    return (
      target?.kind === "decision" &&
      target.decisionId === decisionId &&
      !reviewAttemptEnded(cell, event.payload.runtimeSessionId)
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
    !current.reviews.some(
      (review) =>
        review.reviewContentDigest === digest &&
        review.actor.executor?.id === `runtime-session:${ids.runtimeSessionId}`,
    )
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
    });
  if (!resolved)
    throw cell.cellCodedError("review_dispatch_failed", `Reviewer ${reviewerId} is not bundled or installed.`);
  const payload = {
      agentId: resolved.declaration.id,
      role: "reviewer",
      reviewTarget: { kind: "decision", decisionId, digest },
      cwd: { scope: "repo-relative", path: `harness/decisions/decision-${decisionId}` },
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

function reviewAttemptEnded(cell: RepoCellOperationalContext, runtimeSessionId: string): boolean {
  return cell.projection
    .readRuntimeSessionEvents(runtimeSessionId, 0, 10_000)
    .some((event) =>
      ["runtime_session_exited", "runtime_session_outcome_observed", "runtime_dispatch_outcome_unknown"].includes(
        event.type,
      ),
    );
}

type ReviewerContinuation = {
  readonly dispatchId: string;
  readonly reportRef: string;
  readonly resume: boolean;
  readonly review?: ReviewV1;
};

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
  const lanePrefix = `task-review-lane:${input.reviewerId}:${input.taskId}:`,
    seatPrefix = `task-review:${input.taskId}:`;
  const candidates = cell.projection
    .readRuntimeDispatches()
    .filter((row) => {
      const payload = row.payload;
      const reportRef = `${input.packagePath}/artifacts/reports/${payload.dispatchId}.md`;
      return (
        payload.role === "reviewer" &&
        payload.taskId === input.taskId &&
        payload.agentId === input.reviewerId &&
        typeof payload.dispatchKey === "string" &&
        (payload.dispatchKey.startsWith(seatPrefix) || payload.dispatchKey.startsWith(lanePrefix)) &&
        payload.dispatchKey !== input.dispatchKey &&
        reviewAttemptEnded(cell, payload.runtimeSessionId) &&
        cell.projection.readDocument(reportRef).document !== null
      );
    })
    .sort((left, right) => String(right.payload.startedAt ?? "").localeCompare(String(left.payload.startedAt ?? "")));
  const previous = candidates[0];
  if (!previous) return null;
  const payload = previous.payload,
    session = cell.projection.readRuntimeSession(payload.runtimeSessionId),
    declaration = session === null ? null : runtimeKindForId(session.kindId),
    canResume = Boolean(session?.providerSessionId && declaration?.declaredCapabilities.includes("resume"));
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
    ...(review === undefined ? {} : { review }),
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

/** The review packet prompt every reviewer dispatch carries; each dispatch owns exactly one task. */
export function reviewDispatchPrompt(input: {
  readonly taskId: string;
  readonly packagePath: string;
  readonly dispatchId: string;
  readonly execution: ExecutionV1;
  readonly gates: readonly string[];
  readonly ownerNote?: string;
  /** Absolute authored root when the reviewer runs in a checkout that does not hold the ledger. */
  readonly artifactRoot?: string;
}): string {
  const { taskId, packagePath, dispatchId, execution, gates } = input,
    inapplicable = (execution.submission?.completionContract?.gates ?? [])
      .filter((gate) => !gateAppliesToSubmission(gate, execution.submission!))
      .map((gate) => gate.gateId),
    report = `${packagePath}/artifacts/reports/${dispatchId}.md`,
    packet = `${packagePath}/artifacts/reports/${dispatchId}.json`,
    reportFile = input.artifactRoot ? path.join(input.artifactRoot, report) : `harness/${report}`,
    packetFile = input.artifactRoot ? path.join(input.artifactRoot, packet) : `harness/${packet}`;
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
    `Read ha task show ${taskId} --json and select execution ${execution.executionId} from executions. ` +
      "Its submission contains the authoritative delivery, frozen completion contract, and complete artifact anchors. " +
      "The prompt references that submission; it does not inline evidence or enumerate anchors.",
    `The execution-frozen delivery baseline is ${JSON.stringify(execution.deliveryBaseline ?? null)}; ` +
      "treat it and the submission delivery as authoritative. Read the G33 production-delta result for this cut " +
      "when frozen facts are present. Historical read conclusion: " +
      `${historicalReadConclusions[0]!.conclusion} ` +
      "Use the shared Kernel readSubmissionFacts result for legacy paths; do not reject a legacy cut solely for " +
      "absent frozen facts or compare either machine-derived value against closeout prose.",
    "For every artifact anchor in that submission, read the full center-accepted frozen content with " +
      "ha doc show --path <anchor.path> --raw; do not substitute local files or require Git ancestry. " +
      `Resolve package-relative artifacts/ paths under ${packagePath}/; full tasks/ paths are already resolved. ` +
      "Your reviewer credential resolves only this submission's registered anchors at their frozen revisions " +
      "through the center, including on an edge; binary artifact bodies are returned as base64.",
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
    ...(inapplicable.length ? [`Declared gates not applicable to this delivery: ${inapplicable.join(", ")}.`] : []),
    "Read the task plan, closeout, and submitted delivery yourself. " +
      `${reviewFindingScopePrompt("first")} ${reviewFindingCategoryPrompt} ` +
      "Record approved or changes_requested through RecordReview; never infer approval from provider success.",
    "For a re-review, include resolutions for prior findings as {reviewId, findingId, resolution: upheld|withdrawn}; " +
      "upheld findings go to the CEO, while a new blocking finding without an upheld resolution returns to the worker.",
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
  readonly dispatchId?: string;
  readonly runtimeSessionId?: string;
  readonly dispatchOpId?: string;
  /** The agent the step's dispatch carries, or the requested reviewer on a failed step. */
  readonly agentId?: string;
  /** The runtime instance the dispatch actually landed on, from its dispatch request. */
  readonly instanceId?: string;
  readonly outcome: "dispatched" | "already_dispatched" | "already_reviewed" | "failed";
  readonly error?: string;
};

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
  | { readonly outcome: "dispatched" | "already_dispatched"; readonly ids: ReturnType<typeof reviewDispatchIds> }
  | { readonly outcome: "failed"; readonly error: string }
> {
  const cutReviewKey = reviewDispatchKey(input.taskId, input.execution, input.reviewerId),
    key = input.dispatchKey ?? cutReviewKey,
    ids = reviewDispatchIds(cell.input.repoId, key);
  const existing = cell.projection.readRuntimeDispatchByDispatchKey(key)?.event ?? null;
  if (existing !== null)
    return {
      outcome: "already_dispatched",
      ids: {
        dispatchId: existing.payload.dispatchId,
        runtimeSessionId: existing.payload.runtimeSessionId,
        dispatchOpId: existing.opId,
      },
    };
  if (input.dispatchKey === undefined || key === cutReviewKey) {
    const inFlight = activeCutReviewDispatches(cell, input.taskId, input.execution).at(-1)?.event ?? null;
    if (inFlight !== null) {
      const holdingReviewer = typeof inFlight.payload.agentId === "string" ? inFlight.payload.agentId : null;
      if (holdingReviewer === input.reviewerId)
        return {
          outcome: "already_dispatched",
          ids: {
            dispatchId: inFlight.payload.dispatchId,
            runtimeSessionId: inFlight.payload.runtimeSessionId,
            dispatchOpId: inFlight.opId,
          },
        };
      if (input.dispatchKey === undefined)
        return {
          outcome: "failed",
          error:
            `Task ${input.taskId}'s submitted cut already holds review dispatch ${inFlight.payload.dispatchId} by agent ` +
            `${holdingReviewer ?? "with no recorded agent"} (runtime session ${inFlight.payload.runtimeSessionId}); ` +
            `reviewer ${input.reviewerId} was not dispatched. Retry after that review session ends.`,
        };
    }
  }
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
    continuation = previousReviewerContinuation(cell, {
      taskId: input.taskId,
      reviewerId: input.reviewerId,
      dispatchKey: key,
      packagePath: input.packagePath,
    }),
    continuationNote = continuation
      ? [
          "This is a re-review of the same task and reviewer seat.",
          `Read the previous registered report at harness/${continuation.reportRef} with ha doc show --path ${continuation.reportRef} --raw.`,
          ...(continuation.review
            ? [
                `Previous review ${continuation.review.reviewId}: verdict=${continuation.review.verdict}; reason=${continuation.review.reason}.`,
                `Previous findings: ${JSON.stringify(continuation.review.findings ?? [])}.`,
                `Previous resolutions: ${JSON.stringify(continuation.review.resolutions ?? [])}.`,
              ]
            : []),
          reviewFindingScopePrompt("re-review"),
          reviewFindingCategoryPrompt,
        ].join("\n")
      : `${reviewFindingScopePrompt("first")} ${reviewFindingCategoryPrompt}`,
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
          artifactRoot: resolveHarnessLayout(cell.rootDir).authoredRoot,
        })
      }\n${continuationNote}`,
    payload = {
      agentId: agent.id,
      role: "reviewer",
      taskId: input.taskId,
      executionId: input.execution.executionId,
      dispatchKey: key,
      ...(continuation?.resume ? { dispatchId: continuation.dispatchId } : {}),
      ...(typeof extras.runtimeInstanceId === "string" ? { runtimeInstanceId: extras.runtimeInstanceId } : {}),
      ...(typeof extras.model === "string" ? { model: extras.model } : {}),
      ...(typeof extras.effort === "string" ? { effort: extras.effort } : {}),
      ...(extras.fast === true ? { fast: true } : {}),
      prompt: missionPrompt(ids.dispatchId),
    },
    authorizationDecision = await evaluateRepoCellAction({
      action: { kind: "runtime-spawn", ...payload },
      repoId: cell.input.repoId,
      binding: input.binding,
      actionId: ids.dispatchOpId,
      revision: input.revision,
      now: cell.now(),
      readTask: (taskId) => cell.projection.read(taskId).snapshot.task,
    });
  if (authorizationDecision.outcome !== "allowed")
    return { outcome: "failed", error: `authorization_denied: ${authorizationDecision.nextActions.join(" ")}` };
  try {
    // Already inside the center queue. Only launch admission is awaited; provider completion is not.
    const worktree = await cell.runtimeSpawner.prepareWorktree(payload);
    await cell.runtimeSpawner.spawn(payload, { ...input.binding, authorizationDecision }, worktree);
  } catch (error) {
    if (continuation?.resume && runtimeErrorCode(error) === "runtime_resume_failed") {
      // A provider can reject a previously valid session after admission (for example after its
      // local transcript was compacted). The source remains consumed; retry once as a fresh
      // reviewer session that owns its own dispatch identity, registration id, and report paths.
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
      // The fallback spawns inside the same queued publication turn as the resume it replaces: the
      // authorization decision was evaluated over the same actor, target, and repository revision,
      // so carrying it forward adds no permission the cut dispatch did not already have.
      const fallbackError = await cell.runtimeSpawner
        .prepareWorktree(fallbackPayload)
        .then((worktree) =>
          cell.runtimeSpawner.spawn(fallbackPayload, { ...input.binding, authorizationDecision }, worktree),
        )
        .then(
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
      return { outcome: "dispatched", ids: fallbackIds };
    } else {
      consumeKnownError(error);
      return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { outcome: "dispatched", ids };
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

/** A task cut can have only one active primary reviewer, including keys written before migration. */
export function activeCutReviewDispatches(
  cell: RepoCellOperationalContext,
  taskId: string,
  execution: ExecutionV1,
): ReturnType<RepoCellOperationalContext["projection"]["readRuntimeDispatchesByTaskExecution"]> {
  const baseKey = reviewDispatchKey(taskId, execution);
  return cell.projection.readRuntimeDispatchesByTaskExecution(taskId, execution.executionId).filter(({ event }) => {
    const payload = event.payload,
      key = payload.dispatchKey,
      suffix = typeof key === "string" && key.startsWith(baseKey) ? key.slice(baseKey.length) : null,
      isCutReviewKey =
        suffix === "" ||
        /^:reviewer:[^:]+(?::attempt[1-9][0-9]*)?(?::fallback:[1-9][0-9]*)?(?::resume-fallback)?$/u.test(
          suffix ?? "",
        ) ||
        /^:attempt[1-9][0-9]*(?::fallback:[1-9][0-9]*)?(?::resume-fallback)?$/u.test(suffix ?? "");
    return payload.role === "reviewer" && isCutReviewKey && !reviewAttemptEnded(cell, payload.runtimeSessionId);
  });
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
): Promise<{
  readonly seat: ReviewSeat;
  readonly step: WriteReceiptDraft;
  readonly warnings: readonly string[];
} | null> {
  const current = await cell.service.read(taskId);
  if (current.snapshot.task?.status !== "in_review") return null;
  const execution = current.snapshot.executions.find(
    (value) => value.iteration === current.snapshot.task?.iteration && value.state === "submitted",
  );
  if (!execution?.submission || !current.packagePath) return null;
  const selection = reviewSeatForCut({
    cell,
    execution,
    argument: typeof action.reviewer === "string" ? action.reviewer : undefined,
  });
  if (selection.kind === "escalated")
    return {
      seat: { reviewerId: selection.reviewers.join(", "), source: "path" },
      step: cell.failed(receipt.opId, cell.cellCodedError("review_dispatch_failed", selection.reason)),
      warnings: [selection.reason],
    };
  const { seat } = selection,
    { reviewerId } = seat,
    pathSeat = seat.source === "path",
    dispatch = await spawnCutReviewDispatch(cell, {
      taskId,
      execution,
      packagePath: current.packagePath,
      binding,
      revision: cell.store.readHead()?.revision ?? 0,
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
                artifactRoot: resolveHarnessLayout(cell.rootDir).authoredRoot,
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
                `Recover with ha task dispatch-review ${taskId} --agent ${reviewerId}.`,
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
              `Recover with ha task dispatch-review ${taskId}.`,
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
  const reviewerFromArgument =
      typeof action.agentId === "string" && action.agentId.length > 0 ? action.agentId : undefined,
    revision = cell.store.readHead()?.revision ?? 0,
    steps: DispatchStep[] = [],
    warnings: string[] = [];
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
    let resolved;
    try {
      resolved = readAgentDeclarationResolution({
        rootDir: cell.rootDir,
        agentId: reviewerId,
        entityStore: createEntityStore(cell.store),
      });
    } catch (error) {
      // A reviewer whose stored declaration fails the current schema (the rewrite window) rejects
      // the task with the reinstall command; the raw contract message never surfaces.
      if (!isAgentDeclarationInvalid(error)) throw error;
      consumeKnownError(error);
      fail(error instanceof Error ? error.message : String(error), reviewerId, execution.executionId);
      continue;
    }
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
    const seatPrompt = seat.source === "path" ? reviewPathSeatPrompt({ seat }) : null,
      payload = {
        agentId: agent.id,
        role: "reviewer",
        taskId,
        executionId: execution.executionId,
        dispatchKey: key,
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
            artifactRoot: resolveHarnessLayout(cell.rootDir).authoredRoot,
          }) + (seatPrompt === null ? "" : `\n${seatPrompt}`),
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
    if (authorizationDecision.outcome !== "allowed") {
      fail(`authorization_denied: ${authorizationDecision.nextActions.join(" ")}`, reviewerId, execution.executionId);
      continue;
    }
    try {
      // Already inside the center queue. Only launch admission is awaited; provider completion is not.
      const worktree = await cell.runtimeSpawner.prepareWorktree(payload);
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
      // The spawner resolved the concrete instance; read it from the dispatch event this spawn
      // just applied so the receipt names the agent and instance that will run the review.
      const dispatched = cell.projection.readRuntimeDispatchByDispatchKey(key)?.event;
      steps.push({
        taskId,
        executionId: execution.executionId,
        dispatchId: ids.dispatchId,
        runtimeSessionId: ids.runtimeSessionId,
        dispatchOpId: ids.dispatchOpId,
        agentId: agent.id,
        ...(dispatched === undefined ? {} : { instanceId: dispatched.payload.instanceId }),
        outcome: "dispatched",
      });
    } catch (error) {
      // One task's launch failure is reported on its own step; the batch continues for the rest.
      consumeKnownError(error);
      fail(error instanceof Error ? error.message : String(error), reviewerId, execution.executionId);
    }
  }
  const dispatchedTasks = new Set(steps.filter((step) => step.outcome !== "failed").map((step) => step.taskId)),
    failed = steps.filter((step) => step.outcome === "failed");
  return {
    outcome: dispatchedTasks.size === 0 ? "op_rejected" : "applied",
    opId: cell.operationId(action, binding, cell.input.repoId, revision),
    revision,
    ...(failed.length === 0 ? {} : { code: "review_dispatch_failed" }),
    ...(failed.length === 0 && warnings.length === 0
      ? {}
      : { warnings: [...warnings, ...failed.map((step) => `${step.taskId}: ${step.error ?? ""}`)] }),
    ...(failed.length === steps.length
      ? { rejectionExplanation: failed.map((step) => `${step.taskId}: ${step.error ?? ""}`).join("; ") }
      : {}),
    summary: `dispatch-review: ${String(dispatchedTasks.size)} of ${String(taskIds.length)} task(s) have a review dispatch.`,
    dispatches: steps,
  } as WriteReceiptDraft;
}
