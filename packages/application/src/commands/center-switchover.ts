import {
  computeSwitchoverTargetEpoch,
  createCenterSwitchoverState,
  evaluateRpoZeroCatchupBarrier,
  evaluateSwitchoverPreflight,
  evaluateSwitchoverRollbackEligibility,
  transitionCenterSwitchoverState,
  type CenterSwitchoverPhase,
  type CenterSwitchoverState,
  type RpoZeroBarrierIssue,
  type SwitchoverFrozenCut,
  type SwitchoverPreflightInput,
  type SwitchoverPreflightResult,
  type SwitchoverReplicaCut,
  type SwitchoverTriggerSource,
} from "@harness-anything/kernel/internal/domain/center-switchover.ts";

export interface SwitchoverCededFenceRecord {
  readonly switchoverId: string;
  readonly repoId: string;
  readonly oldEpoch: number;
  readonly cededEpoch: number;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly finalRevision: number;
  readonly tipHash: string;
  readonly newExternalUrl: string;
  readonly newLoginUrl: string;
  readonly spkiSha256: string;
  readonly fencedAt: string;
}

export interface SwitchoverTargetActivationReceipt {
  readonly switchoverId: string;
  readonly repoId: string;
  readonly oldEpoch: number;
  readonly newEpoch: number;
  readonly finalRevision: number;
  readonly tipHash: string;
  readonly replicationHistory: string;
  readonly replicationSequence: number;
  readonly retainedLogMinSequence: number;
  readonly retainedLogRowCount: number;
  readonly promotedAt: string;
}

export interface SwitchoverDemotionReceipt {
  readonly switchoverId: string;
  readonly repoId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly newEpoch: number;
  readonly mode: "remote-edge";
  readonly viewRoot: string;
  readonly demotedAt: string;
}

export interface SwitchoverRollbackReceipt {
  readonly switchoverId: string;
  readonly repoId: string;
  readonly oldEpoch: number;
  readonly cededEpoch: number;
  readonly rollbackEpoch: number;
  readonly auditPath: string;
  readonly rolledBackAt: string;
}

export interface CenterSwitchoverRequest {
  readonly switchoverId: string;
  readonly repoId: string;
  readonly targetNodeId: string;
  readonly triggerSource?: SwitchoverTriggerSource;
  readonly allowSentinelTrigger?: boolean;
  readonly dryRun?: boolean;
  readonly catchupTimeoutMs?: number;
}

export interface CenterSwitchoverPorts {
  readonly now?: () => string;
  readonly authorize: (input: {
    readonly repoId: string;
    readonly targetNodeId: string;
    readonly dryRun: boolean;
  }) => Promise<void>;
  readonly inspectPreflight: (input: {
    readonly repoId: string;
    readonly targetNodeId: string;
    readonly triggerSource: SwitchoverTriggerSource;
  }) => Promise<SwitchoverPreflightInput>;
  readonly freezeAndDrainSource: (input: {
    readonly repoId: string;
    readonly switchoverId: string;
    readonly oldEpoch: number;
  }) => Promise<SwitchoverFrozenCut>;
  readonly unfreezeSource: (input: { readonly repoId: string; readonly switchoverId: string }) => Promise<void>;
  readonly awaitTargetCatchup: (input: {
    readonly repoId: string;
    readonly targetNodeId: string;
    readonly frozenCut: SwitchoverFrozenCut;
    readonly timeoutMs: number;
  }) => Promise<SwitchoverReplicaCut>;
  readonly persistCededFence: (input: {
    readonly repoId: string;
    readonly switchoverId: string;
    readonly oldEpoch: number;
    readonly cededEpoch: number;
    readonly sourceNodeId: string;
    readonly targetNodeId: string;
    readonly frozenCut: SwitchoverFrozenCut;
    readonly targetExternalUrl: string;
    readonly targetLoginUrl: string;
    readonly targetSpkiSha256: string;
  }) => Promise<void>;
  readonly activateTargetCenter: (input: {
    readonly repoId: string;
    readonly switchoverId: string;
    readonly expectedOldEpoch: number;
    readonly newEpoch: number;
    readonly frozenCut: SwitchoverFrozenCut;
    readonly targetNodeId: string;
  }) => Promise<SwitchoverTargetActivationReceipt>;
  readonly demoteSourceToEdge: (input: {
    readonly repoId: string;
    readonly switchoverId: string;
    readonly sourceNodeId: string;
    readonly targetNodeId: string;
    readonly newEpoch: number;
    readonly targetExternalUrl: string;
    readonly targetLoginUrl: string;
    readonly targetSpkiSha256: string;
  }) => Promise<SwitchoverDemotionReceipt>;
}

export type CenterSwitchoverOutcome =
  | {
      readonly ok: true;
      readonly dryRun: true;
      readonly phase: CenterSwitchoverPhase;
      readonly preflight: SwitchoverPreflightResult;
      readonly state: CenterSwitchoverState;
    }
  | {
      readonly ok: true;
      readonly dryRun: false;
      readonly phase: CenterSwitchoverPhase;
      readonly preflight: SwitchoverPreflightResult;
      readonly state: CenterSwitchoverState;
      readonly activation: SwitchoverTargetActivationReceipt;
      readonly demotion: SwitchoverDemotionReceipt;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly detail: string;
      readonly phase: CenterSwitchoverPhase;
      readonly preflight?: SwitchoverPreflightResult;
      readonly barrierIssues?: readonly RpoZeroBarrierIssue[];
      readonly state?: CenterSwitchoverState;
      readonly fencedCeded?: boolean;
    };

export interface CenterSwitchoverRollbackRequest {
  readonly repoId: string;
  readonly switchoverId: string;
  readonly reason: string;
}

export interface CenterSwitchoverRollbackPorts {
  readonly now?: () => string;
  readonly authorize: (input: { readonly repoId: string; readonly switchoverId: string }) => Promise<void>;
  readonly readCededFence: (repoId: string) => Promise<SwitchoverCededFenceRecord | null>;
  readonly invalidateTargetAttempt: (input: {
    readonly repoId: string;
    readonly switchoverId: string;
    readonly targetNodeId: string;
    readonly cededEpoch: number;
  }) => Promise<{
    readonly targetNeverActivated: boolean;
    readonly targetInvalidated: boolean;
  }>;
  readonly commitAuditedRollback: (input: {
    readonly repoId: string;
    readonly switchoverId: string;
    readonly oldEpoch: number;
    readonly cededEpoch: number;
    readonly rollbackEpoch: number;
    readonly reason: string;
  }) => Promise<SwitchoverRollbackReceipt>;
}

export type CenterSwitchoverRollbackOutcome =
  | {
      readonly ok: true;
      readonly phase: "aborted_rolled_back";
      readonly rollback: SwitchoverRollbackReceipt;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly detail: string;
    };

export async function runCenterSwitchover(
  request: CenterSwitchoverRequest,
  ports: CenterSwitchoverPorts,
): Promise<CenterSwitchoverOutcome> {
  const now = ports.now ?? (() => new Date().toISOString()),
    triggerSource = request.triggerSource ?? "operator",
    dryRun = request.dryRun === true;

  await ports.authorize({ repoId: request.repoId, targetNodeId: request.targetNodeId, dryRun });

  const preflightInput = await ports.inspectPreflight({
      repoId: request.repoId,
      targetNodeId: request.targetNodeId,
      triggerSource,
    }),
    preflight = evaluateSwitchoverPreflight({
      ...preflightInput,
      triggerSource,
      ...(request.allowSentinelTrigger === undefined ? {} : { allowSentinelTrigger: request.allowSentinelTrigger }),
    });

  if (!preflight.ok) {
    return {
      ok: false,
      code: preflight.blockingCodes[0] ?? "switchover_preflight_failed",
      detail: preflight.checks
        .filter((check) => !check.passed)
        .map((check) => `${check.check}: ${check.detail}`)
        .join("; "),
      phase: "idle",
      preflight,
    };
  }

  let state = createCenterSwitchoverState({
    switchoverId: request.switchoverId,
    repoId: request.repoId,
    triggerSource,
    sourceNodeId: preflightInput.sourceNodeId,
    targetNodeId: request.targetNodeId,
    oldEpoch: preflightInput.oldEpoch,
    now: now(),
  });

  if (dryRun) {
    return { ok: true, dryRun: true, phase: state.phase, preflight, state };
  }

  // Phase 0: freeze writes (CENTER_MIGRATING) & drain queue, then enforce RPO=0 catch-up barrier.
  state = transitionCenterSwitchoverState(state, "freezing", { now: now() });
  let frozenCut: SwitchoverFrozenCut;
  try {
    frozenCut = await ports.freezeAndDrainSource({
      repoId: request.repoId,
      switchoverId: request.switchoverId,
      oldEpoch: preflightInput.oldEpoch,
    });
  } catch (error) {
    await ports.unfreezeSource({ repoId: request.repoId, switchoverId: request.switchoverId });
    const abortedState = transitionCenterSwitchoverState(state, "aborted_rolled_back", { now: now() });
    return {
      ok: false,
      code: errorCode(error, "source_freeze_failed"),
      detail: errorMessage(error),
      phase: abortedState.phase,
      preflight,
      state: abortedState,
    };
  }

  let replicaCut: SwitchoverReplicaCut;
  try {
    replicaCut = await ports.awaitTargetCatchup({
      repoId: request.repoId,
      targetNodeId: request.targetNodeId,
      frozenCut,
      timeoutMs: request.catchupTimeoutMs ?? 30_000,
    });
  } catch (error) {
    await ports.unfreezeSource({ repoId: request.repoId, switchoverId: request.switchoverId });
    const abortedState = transitionCenterSwitchoverState(state, "aborted_rolled_back", { now: now() });
    return {
      ok: false,
      code: errorCode(error, "rpo_zero_catchup_timeout"),
      detail: errorMessage(error),
      phase: abortedState.phase,
      preflight,
      state: abortedState,
    };
  }

  const barrier = evaluateRpoZeroCatchupBarrier(frozenCut, replicaCut);
  if (!barrier.ok) {
    await ports.unfreezeSource({ repoId: request.repoId, switchoverId: request.switchoverId });
    const abortedState = transitionCenterSwitchoverState(state, "aborted_rolled_back", { now: now() });
    return {
      ok: false,
      code: barrier.code,
      detail: barrier.detail,
      phase: abortedState.phase,
      preflight,
      barrierIssues: barrier.issues,
      state: abortedState,
    };
  }

  // Phase 1: durably persist the reversible cededEpoch fence on the old center BEFORE activating target.
  const cededEpoch = computeSwitchoverTargetEpoch(preflightInput.oldEpoch);
  try {
    await ports.persistCededFence({
      repoId: request.repoId,
      switchoverId: request.switchoverId,
      oldEpoch: preflightInput.oldEpoch,
      cededEpoch,
      sourceNodeId: preflightInput.sourceNodeId,
      targetNodeId: request.targetNodeId,
      frozenCut,
      targetExternalUrl: preflightInput.targetExternalUrl,
      targetLoginUrl: preflightInput.targetLoginUrl,
      targetSpkiSha256: preflightInput.targetSpkiSha256,
    });
  } catch (error) {
    await ports.unfreezeSource({ repoId: request.repoId, switchoverId: request.switchoverId });
    const abortedState = transitionCenterSwitchoverState(state, "aborted_rolled_back", { now: now() });
    return {
      ok: false,
      code: errorCode(error, "persist_ceded_fence_failed"),
      detail: errorMessage(error),
      phase: abortedState.phase,
      preflight,
      state: abortedState,
    };
  }

  state = transitionCenterSwitchoverState(state, "fenced_ceded", { now: now(), frozenCut });

  // Phase 2: activate target at oldEpoch + 1. From this point onward, NEVER unfreeze source automatically;
  // recovery must either finish target activation or perform audited oldEpoch + 2 rollback.
  let activation: SwitchoverTargetActivationReceipt;
  try {
    activation = await ports.activateTargetCenter({
      repoId: request.repoId,
      switchoverId: request.switchoverId,
      expectedOldEpoch: preflightInput.oldEpoch,
      newEpoch: cededEpoch,
      frozenCut,
      targetNodeId: request.targetNodeId,
    });
  } catch (error) {
    return {
      ok: false,
      code: errorCode(error, "target_activation_failed"),
      detail: `${errorMessage(error)} Source remains durably fenced at epoch ${String(cededEpoch)}; complete target activation or run audited --abort-rollback.`,
      phase: state.phase,
      preflight,
      state,
      fencedCeded: true,
    };
  }

  state = transitionCenterSwitchoverState(state, "target_activated", { now: now() });

  // Phase 3: demote old center in place to remote-edge pointing at the newly activated center.
  const demotion = await ports.demoteSourceToEdge({
    repoId: request.repoId,
    switchoverId: request.switchoverId,
    sourceNodeId: preflightInput.sourceNodeId,
    targetNodeId: request.targetNodeId,
    newEpoch: activation.newEpoch,
    targetExternalUrl: preflightInput.targetExternalUrl,
    targetLoginUrl: preflightInput.targetLoginUrl,
    targetSpkiSha256: preflightInput.targetSpkiSha256,
  });

  state = transitionCenterSwitchoverState(state, "demoted_edge", { now: now() });
  return { ok: true, dryRun: false, phase: state.phase, preflight, state, activation, demotion };
}

export async function abortCenterSwitchoverRollback(
  request: CenterSwitchoverRollbackRequest,
  ports: CenterSwitchoverRollbackPorts,
): Promise<CenterSwitchoverRollbackOutcome> {
  const now = ports.now ?? (() => new Date().toISOString());
  if (request.reason.trim().length === 0)
    return { ok: false, code: "missing_reason", detail: "Audited switchover rollback requires a non-empty --reason." };

  await ports.authorize({ repoId: request.repoId, switchoverId: request.switchoverId });

  const fence = await ports.readCededFence(request.repoId);
  if (fence === null)
    return {
      ok: false,
      code: "switchover_fence_missing",
      detail: `No active reversible switchover fence exists for repository ${request.repoId}.`,
    };

  const invalidation = await ports.invalidateTargetAttempt({
    repoId: request.repoId,
    switchoverId: request.switchoverId,
    targetNodeId: fence.targetNodeId,
    cededEpoch: fence.cededEpoch,
  });

  const eligibility = evaluateSwitchoverRollbackEligibility({
    requestedSwitchoverId: request.switchoverId,
    fenceSwitchoverId: fence.switchoverId,
    oldEpoch: fence.oldEpoch,
    cededEpoch: fence.cededEpoch,
    targetNeverActivated: invalidation.targetNeverActivated,
    targetInvalidated: invalidation.targetInvalidated,
  });

  if (!eligibility.ok) {
    return { ok: false, code: eligibility.code, detail: eligibility.detail };
  }

  // Validate transition through the pure kernel state machine before committing rollback.
  let state = createCenterSwitchoverState({
    switchoverId: fence.switchoverId,
    repoId: fence.repoId,
    triggerSource: "operator",
    sourceNodeId: fence.sourceNodeId,
    targetNodeId: fence.targetNodeId,
    oldEpoch: fence.oldEpoch,
    now: fence.fencedAt,
  });
  state = transitionCenterSwitchoverState(state, "freezing", { now: fence.fencedAt });
  state = transitionCenterSwitchoverState(state, "fenced_ceded", {
    now: fence.fencedAt,
    frozenCut: {
      repoId: fence.repoId,
      finalRevision: fence.finalRevision,
      tipHash: fence.tipHash,
      history: "0".repeat(32),
      sequence: 0,
    },
  });
  transitionCenterSwitchoverState(state, "aborted_rolled_back", {
    now: now(),
    rollbackAudit: {
      targetNeverActivated: invalidation.targetNeverActivated,
      targetInvalidated: invalidation.targetInvalidated,
      rollbackEpoch: eligibility.rollbackEpoch,
      reason: request.reason,
    },
  });

  const rollback = await ports.commitAuditedRollback({
    repoId: fence.repoId,
    switchoverId: fence.switchoverId,
    oldEpoch: fence.oldEpoch,
    cededEpoch: fence.cededEpoch,
    rollbackEpoch: eligibility.rollbackEpoch,
    reason: request.reason,
  });

  return { ok: true, phase: "aborted_rolled_back", rollback };
}

function errorCode(error: unknown, fallback: string): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
