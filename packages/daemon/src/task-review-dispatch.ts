import { createHash, randomUUID } from "node:crypto";
import {
  completionGateIds,
  consumeKnownError,
  gateAppliesToSubmission,
  createEntityStore,
  currentSubmittedExecutions,
  submissionDigest,
  decisionReviewContentDigest,
  type ExecutionV1,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import { derivedTaskActionProtocolCommands } from "./protocol/daemon-protocol-commands-task.ts";
import { decisionLifecycleProtocolCommands } from "./protocol/daemon-protocol-commands-decision-lifecycle.ts";
import { isAgentDeclarationInvalid, readAgentDeclarationResolution } from "./agent-entities.ts";
import { agentDeclaresExplicitModels } from "./agent-runtime-contract.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { reviewLaneDispatchKey, reviewLaneHits, reviewLanePrompt, reviewPathLanes } from "./review-path-lanes.ts";
import { reviewFindingScopePrompt } from "./review-prompt-guidance.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import { runtimeErrorCode } from "./runtime-spawn-errors.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

/**
 * The owner's explicit reviewer argument overrides the cut's frozen claim (owner ruling 2026-09-21);
 * without one, the frozen claim still beats repository settings, which only select an unfrozen cut.
 */
export function selectReviewAgent(frozen?: string, argument?: string, setting?: string) {
  if (argument) return { reviewerId: argument, reviewerSource: "argument" as const };
  if (frozen) return { reviewerId: frozen, reviewerSource: "frozen" as const };
  if (setting) return { reviewerId: setting, reviewerSource: "settings" as const };
  return { reviewerId: "closeout-reviewer", reviewerSource: "bundled" as const };
}

/** A user-initiated review dispatch is keyed by the reviewed cut, never by a caller or node. */
export function reviewDispatchKey(taskId: string, execution: ExecutionV1, reviewerId?: string): string {
  const key = `task-review:${taskId}:${execution.executionId}:${execution.iteration}:${submissionDigest(
    execution.submission!,
  )}`;
  return reviewerId && reviewerId !== execution.submission?.completionContract.reviewer?.agentId
    ? `${key}:reviewer:${reviewerId}`
    : key;
}

/**
 * The deterministic impossibilities of dispatching a cut reviewer: no sealed daemon route, no
 * resolvable reviewer declaration, or an installed reviewer that declares no explicit model. The
 * same conditions `spawnCutReviewDispatch` fails on after its durable write; stated here as one
 * answer so the upgrade-forward precondition names exactly what the spawn itself would reject.
 * A launch that fails only at runtime (instances down) stays with the idempotent retry lane.
 */
export function cutReviewDispatchObstruction(
  cell: Pick<RepoCellOperationalContext, "input" | "rootDir" | "store">,
  input: {
    readonly reviewerId: string;
    readonly model?: string;
  },
): string | null {
  if (!cell.input.runtimeDaemonRoute) return "no sealed daemon route to dispatch its reviewer through this cell";
  try {
    const resolved = readAgentDeclarationResolution({
      rootDir: cell.rootDir,
      agentId: input.reviewerId,
      entityStore: createEntityStore(cell.store),
    });
    if (!resolved) return `no resolvable reviewer ${input.reviewerId}; install one or pass --agent <agent-id>`;
    if (
      resolved.layer === "installed" &&
      !agentDeclaresExplicitModels(resolved.declaration.runtimes) &&
      typeof input.model !== "string"
    )
      return `reviewer ${input.reviewerId} declares no explicit model; pass --model <model>`;
  } catch (error) {
    if (!isAgentDeclarationInvalid(error)) throw error;
    return error instanceof Error ? error.message : String(error);
  }
  return null;
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
      prompt: decisionReviewDispatchPrompt({ decisionId, digest, dispatchId: ids.dispatchId }),
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
};

/** Find the latest completed reviewer round for exactly one task/lane. */
function previousReviewerContinuation(
  cell: RepoCellOperationalContext,
  input: {
    readonly taskId: string;
    readonly reviewerId: string;
    readonly dispatchKey: string;
    readonly packagePath: string;
  },
): ReviewerContinuation | null {
  const lanePrefix = input.dispatchKey.startsWith(`task-review-lane:${input.reviewerId}:${input.taskId}:`)
    ? `task-review-lane:${input.reviewerId}:${input.taskId}:`
    : `task-review:${input.taskId}:`;
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
        payload.dispatchKey.startsWith(lanePrefix) &&
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
  return {
    dispatchId: payload.dispatchId,
    reportRef,
    resume: canResume,
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
}): string {
  const { decisionId, digest, dispatchId } = input,
    reports = `decisions/decision-${decisionId}/artifacts/reports`;
  return [
    `Independently review Decision ${decisionId} at reviewContentDigest ${digest}.`,
    `Read the frozen accepted document at harness/decisions/decision-${decisionId}/decision.md.`,
    "Record approved or changes_requested with ha decision review; never accept, reject, defer, or amend.",
    `Write the review report to harness/${reports}/${dispatchId}.md ` +
      `and the review input to harness/${reports}/${dispatchId}.json.`,
    `The review input's identity fields are fixed by this dispatch; any other value is rejected as ` +
      `actor_unauthorized. Use exactly reviewId review-${dispatchId}, reviewContentDigest ${digest}, ` +
      `reportRef harness/${reports}/${dispatchId}.md. ` +
      "Author only verdict, reason, findings, and evidenceChecked yourself.",
    decisionLifecycleProtocolCommands.find((command) => command.id === "decision-review")!.help,
    `Register with ha decision review ${decisionId} --from-file harness/${reports}/${dispatchId}.json.`,
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
}): string {
  const { taskId, packagePath, dispatchId, execution, gates } = input,
    inapplicable = (execution.submission?.completionContract?.gates ?? [])
      .filter((gate) => !gateAppliesToSubmission(gate, execution.submission!))
      .map((gate) => gate.gateId),
    report = `${packagePath}/artifacts/reports/${dispatchId}.md`,
    packet = `${packagePath}/artifacts/reports/${dispatchId}.json`;
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
      "treat it and the submission delivery as authoritative. Read the G33 production-delta result for this cut; " +
      "do not compare either machine-derived value against closeout prose.",
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
      `${reviewFindingScopePrompt("first")} ` +
      "Record approved or changes_requested through RecordReview; never infer approval from provider success.",
    `Write this execution's review report to harness/${report} and review input to harness/${packet}. ` +
      "These dispatch-specific paths replace any shared report path in your declaration.",
    derivedTaskActionProtocolCommands.find((command) => command.id === "task-review-execution")!.help,
    `Register with ha task review-execution ${taskId} --execution-id ${execution.executionId} ` +
      `--review-id review-${dispatchId} --from-file harness/${packet}.`,
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
  /** The configured path-review lane beside the cut review; absent means the primary cut lane. */
  readonly lane?: string;
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
    /** An explicit dispatch key for a secondary lane; absent selects the cut review key. */
    readonly dispatchKey?: string;
    /**
     * The lane's mission for one dispatch id; absent builds the cut review packet. The builder is
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
          "This is a re-review of the same task and reviewer lane.",
          `Read the previous registered report at harness/${continuation.reportRef} with ha doc show --path ${continuation.reportRef} --raw.`,
          reviewFindingScopePrompt("re-review"),
        ].join("\n")
      : reviewFindingScopePrompt("first"),
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
        })
      }\n${continuationNote}`,
    payload = {
      agentId: agent.id,
      role: "reviewer",
      taskId: input.taskId,
      executionId: input.execution.executionId,
      cwd: { scope: "repo-root" },
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
    await cell.runtimeSpawner.spawn(payload, { ...input.binding, authorizationDecision });
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
        .spawn(fallbackPayload, { ...input.binding, authorizationDecision })
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

/** One configured path-review lane's result for a submitted cut. */
type PathLaneDispatchResult = {
  readonly lane: string;
  readonly hits: readonly string[];
  readonly outcome: "dispatched" | "already_dispatched" | "failed";
  readonly ids?: ReturnType<typeof reviewDispatchIds>;
  readonly error?: string;
};

/**
 * The configured path-review lanes beside the cut review: each repository setting entry pairs a
 * reviewer agent with a path, and a submitted cut whose frozen manifest touches that path gets the
 * agent dispatched under its own idempotent key. The product owns the mechanism only; which agents
 * watch which paths is repository setting, and what the lane reviews is the agent's declaration.
 * A lane never disturbs the primary reviewer dispatch or the durable write that precedes it: its
 * own failures are returned per lane for the caller's retry lane.
 */
async function dispatchPathReviewLanes(
  cell: RepoCellOperationalContext,
  input: {
    readonly taskId: string;
    readonly execution: ExecutionV1;
    readonly packagePath: string;
    readonly binding: RepoCellBinding;
    readonly revision: number;
    readonly extras?: Readonly<Record<string, unknown>>;
  },
): Promise<readonly PathLaneDispatchResult[]> {
  const assessment = input.execution.submission?.riskTierAssessment;
  if (assessment?.effectiveTier !== "high") return [];
  const hits = new Map<string, readonly string[]>(
    assessment.matchedPathReviewers.map(({ agentId, paths }) => [agentId, paths]),
  );
  if (hits.size === 0) return [];
  const results: PathLaneDispatchResult[] = [];
  for (const [agentId, matched] of hits) {
    const { key, ids, existing } = reviewDispatchAttempt(
      cell,
      reviewLaneDispatchKey(agentId, input.taskId, input.execution),
    );
    if (existing !== null) {
      results.push({
        lane: agentId,
        hits: matched,
        outcome: "already_dispatched",
        ids: { ...ids, dispatchOpId: existing.opId },
      });
      continue;
    }
    const dispatch = await spawnCutReviewDispatch(cell, {
      taskId: input.taskId,
      execution: input.execution,
      packagePath: input.packagePath,
      binding: input.binding,
      revision: input.revision,
      reviewerId: agentId,
      dispatchKey: key,
      promptFor: (dispatchId) =>
        reviewLanePrompt({
          agentId: lane.agentId,
          taskId: input.taskId,
          packagePath: input.packagePath,
          dispatchId,
          execution: input.execution,
          hits: matched,
        }),
      ...(input.extras === undefined ? {} : { extras: input.extras }),
    });
    results.push(
      dispatch.outcome === "failed"
        ? { lane: agentId, hits: matched, outcome: "failed", error: dispatch.error }
        : { lane: agentId, hits: matched, outcome: dispatch.outcome, ids: dispatch.ids },
    );
  }
  return results;
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
        suffix?.startsWith(":reviewer:") === true ||
        (suffix?.startsWith(":attempt") === true && /^:attempt[1-9][0-9]*$/u.test(suffix));
    return payload.role === "reviewer" && isCutReviewKey && !reviewAttemptEnded(cell, payload.runtimeSessionId);
  });
}

/**
 * The automatic reviewer dispatch for a task's in-review cut, after a durable write that left the
 * cut without a current review: submit, amend, resumed submit, and an owner's explicit reviewer
 * selection. Returns null outside the in-review gate. A dispatch failure
 * never undoes the durable write: it lands as the returned step with the idempotent
 * `ha task dispatch-review` retry lane.
 */
export async function dispatchInReviewCutReview(
  cell: RepoCellOperationalContext,
  taskId: string,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  receipt: WriteReceiptDraft,
): Promise<{
  readonly selection: ReturnType<typeof selectReviewAgent>;
  readonly step: WriteReceiptDraft;
  /** The configured path-review lanes' own steps; a failed lane is a warning, never the cut's verdict. */
  readonly laneSteps: readonly WriteReceiptDraft[];
  readonly laneWarnings: readonly string[];
} | null> {
  const current = await cell.service.read(taskId);
  if (current.snapshot.task?.status !== "in_review") return null;
  const execution = current.snapshot.executions.find(
    (value) => value.iteration === current.snapshot.task?.iteration && value.state === "submitted",
  );
  if (!execution?.submission || !current.packagePath) return null;
  const selection = selectReviewAgent(
      execution.submission.completionContract?.reviewer?.agentId,
      typeof action.reviewer === "string" ? action.reviewer : undefined,
      cell.settings.readRepository().roles?.defaultReviewer,
    ),
    { reviewerId } = selection,
    dispatch = await spawnCutReviewDispatch(cell, {
      taskId,
      execution,
      packagePath: current.packagePath,
      binding,
      revision: cell.store.readHead()?.revision ?? 0,
      reviewerId,
      dispatchKey: reviewDispatchKey(taskId, execution, reviewerId),
      ...(typeof action.reason === "string" ? { ownerNote: action.reason } : {}),
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
                `Recover with ha task dispatch-review ${taskId} --agent ${reviewerId}; do not repeat adjudicate.`,
            ),
          )
        : ({
            ...receipt,
            dispatchId: dispatch.ids.dispatchId,
            runtimeSessionId: dispatch.ids.runtimeSessionId,
          } as WriteReceiptDraft);
  const laneResults = await dispatchPathReviewLanes(cell, {
      taskId,
      execution,
      packagePath: current.packagePath,
      binding,
      revision: cell.store.readHead()?.revision ?? 0,
      extras: {
        ...(typeof action.runtimeInstanceId === "string" ? { runtimeInstanceId: action.runtimeInstanceId } : {}),
        ...(typeof action.model === "string" ? { model: action.model } : {}),
      },
    }),
    laneSteps = laneResults.flatMap((lane): WriteReceiptDraft[] =>
      lane.outcome === "failed" || lane.ids === undefined
        ? []
        : [
            {
              ...receipt,
              dispatchId: lane.ids.dispatchId,
              runtimeSessionId: lane.ids.runtimeSessionId,
              summary: `Task ${taskId} path-review lane ${lane.lane} ${lane.ids.dispatchId} ${lane.outcome}.`,
            } as WriteReceiptDraft,
          ],
    ),
    laneWarnings = laneResults.flatMap((lane) =>
      lane.outcome === "failed"
        ? [
            `Task ${taskId} path-review lane ${lane.lane} dispatch failed: ${lane.error ?? "unknown error"} ` +
              `The cut review is unaffected; recover this lane with ha task dispatch-review ${taskId}.`,
          ]
        : [],
    );
  return { selection, step, laneSteps, laneWarnings };
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
      : (cell.settings.readRepository().roles?.defaultReviewer ?? "closeout-reviewer");
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
    steps: DispatchStep[] = [],
    reviewerFromArgument = typeof action.agentId === "string" && action.agentId.length > 0;
  for (const taskId of taskIds) {
    const fail = (error: string, executionId?: string) =>
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
          ? `Task ${taskId} has no automatic review requirement. Complete it, or explicitly request review with ` +
              `ha task adjudicate ${taskId} --forward --reviewer ${reviewerId} --note <why>.`
          : `Task ${taskId} is not at the in-review gate.`,
      );
      continue;
    }
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
    // A configured path-review lane keys off the same submitted cut as the primary review but
    // owns its dispatch identities, so it runs before any primary-path continue and reports its
    // own step. A failed lane never replaces the primary outcome.
    const laneResults = await dispatchPathReviewLanes(cell, {
        taskId,
        execution,
        packagePath: read.packagePath,
        binding,
        revision,
        extras: {
          ...(typeof action.runtimeInstanceId === "string" ? { runtimeInstanceId: action.runtimeInstanceId } : {}),
          ...(typeof action.model === "string" ? { model: action.model } : {}),
        },
      }),
      laneSteps: DispatchStep[] = laneResults.map((lane) =>
        lane.outcome === "failed" || lane.ids === undefined
          ? {
              taskId,
              executionId: execution.executionId,
              lane: lane.lane,
              agentId: lane.lane,
              outcome: "failed",
              error: lane.error ?? "path-review lane dispatch failed",
            }
          : {
              taskId,
              executionId: execution.executionId,
              lane: lane.lane,
              agentId: lane.lane,
              dispatchId: lane.ids.dispatchId,
              runtimeSessionId: lane.ids.runtimeSessionId,
              dispatchOpId: lane.ids.dispatchOpId,
              outcome: lane.outcome,
            },
      );
    const activeCutReviews = activeCutReviewDispatches(cell, taskId, execution),
      active = activeCutReviews.find(({ event }) => event.payload.agentId === agent.id) ?? activeCutReviews[0];
    if (active !== undefined) {
      const holding = active.event.payload,
        holdingAgent = typeof holding.agentId === "string" ? holding.agentId : null;
      if (reviewerFromArgument && holdingAgent !== agent.id) {
        fail(
          `Task ${taskId}'s submitted cut already holds review dispatch ${holding.dispatchId} by agent ` +
            `${holdingAgent ?? "with no recorded agent"} (runtime session ${holding.runtimeSessionId}, ` +
            `instance ${holding.instanceId}); --agent ${reviewerId} was not dispatched. Re-run ` +
            `ha task dispatch-review ${taskId} --agent ${reviewerId} after that review session ends.`,
          execution.executionId,
        );
      } else {
        steps.push({
          taskId,
          executionId: execution.executionId,
          dispatchId: holding.dispatchId,
          runtimeSessionId: holding.runtimeSessionId,
          dispatchOpId: active.event.opId,
          ...(holdingAgent === null ? {} : { agentId: holdingAgent }),
          instanceId: holding.instanceId,
          outcome: "already_dispatched",
        });
      }
      steps.push(...laneSteps);
      continue;
    }
    const { key, ids, existing } = reviewDispatchAttempt(cell, reviewDispatchKey(taskId, execution, reviewerId));
    if (existing !== null) {
      // One submitted cut holds one review dispatch at a time, so an explicit --agent must never
      // masquerade as another agent's in-flight dispatch: refuse naming both agents instead.
      const holdingAgent = typeof existing.payload.agentId === "string" ? existing.payload.agentId : null;
      if (reviewerFromArgument && holdingAgent !== agent.id) {
        fail(
          `Task ${taskId}'s submitted cut already holds review dispatch ${existing.payload.dispatchId} by agent ` +
            `${holdingAgent ?? "with no recorded agent"} (runtime session ${existing.payload.runtimeSessionId}, ` +
            `instance ${existing.payload.instanceId}); --agent ${reviewerId} was not dispatched. Re-run ` +
            `ha task dispatch-review ${taskId} --agent ${reviewerId} after that review session ends.`,
          execution.executionId,
        );
        steps.push(...laneSteps);
        continue;
      }
      steps.push(...laneSteps);
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
    const payload = {
        agentId: agent.id,
        role: "reviewer",
        taskId,
        executionId: execution.executionId,
        cwd: { scope: "repo-root" },
        dispatchKey: key,
        ...(typeof action.runtimeInstanceId === "string" ? { runtimeInstanceId: action.runtimeInstanceId } : {}),
        ...(typeof action.model === "string" ? { model: action.model } : {}),
        ...(typeof action.effort === "string" ? { effort: action.effort } : {}),
        ...(typeof action.fast === "boolean" ? { fast: action.fast } : {}),
        prompt: reviewDispatchPrompt({
          taskId,
          packagePath: read.packagePath,
          dispatchId: ids.dispatchId,
          execution,
          gates: completionGateIds(snapshot.task!.completionGateIds, execution.submission),
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
    if (authorizationDecision.outcome !== "allowed") {
      fail(`authorization_denied: ${authorizationDecision.nextActions.join(" ")}`, execution.executionId);
      steps.push(...laneSteps);
      continue;
    }
    try {
      // Already inside the center queue. Only launch admission is awaited; provider completion is not.
      await cell.runtimeSpawner.spawn(payload, { ...binding, authorizationDecision });
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
      steps.push(...laneSteps);
    } catch (error) {
      // One task's launch failure is reported on its own step; the batch continues for the rest.
      consumeKnownError(error);
      fail(error instanceof Error ? error.message : String(error), execution.executionId);
      steps.push(...laneSteps);
    }
  }
  const dispatchedTasks = new Set(
      steps.filter((step) => step.lane === undefined && step.outcome !== "failed").map((step) => step.taskId),
    ),
    failed = steps.filter((step) => step.outcome === "failed");
  return {
    outcome: dispatchedTasks.size === 0 ? "op_rejected" : "applied",
    opId: cell.operationId(action, binding, cell.input.repoId, revision),
    revision,
    ...(failed.length === 0 ? {} : { code: "review_dispatch_failed" }),
    ...(failed.length === 0 ? {} : { warnings: failed.map((step) => `${step.taskId}: ${step.error ?? ""}`) }),
    ...(failed.length === steps.length
      ? { rejectionExplanation: failed.map((step) => `${step.taskId}: ${step.error ?? ""}`).join("; ") }
      : {}),
    summary: `dispatch-review: ${String(dispatchedTasks.size)} of ${String(taskIds.length)} task(s) have a review dispatch.`,
    dispatches: steps,
  } as WriteReceiptDraft;
}
