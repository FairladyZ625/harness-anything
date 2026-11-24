export const centerSwitchoverPhases = [
  "idle",
  "freezing",
  "fenced_ceded",
  "target_activated",
  "demoted_edge",
  "aborted_rolled_back",
] as const;

export type CenterSwitchoverPhase = (typeof centerSwitchoverPhases)[number];

export const centerSwitchoverFenceStates = ["fenced_ceded", "demoted_edge"] as const;

export type CenterSwitchoverFenceState = (typeof centerSwitchoverFenceStates)[number];

export const switchoverTriggerSources = ["operator", "sentinel"] as const;

export type SwitchoverTriggerSource = (typeof switchoverTriggerSources)[number];

export interface SwitchoverFrozenCut {
  readonly repoId: string;
  readonly finalRevision: number;
  readonly tipHash: string;
  readonly history: string;
  readonly sequence: number;
}

export interface SwitchoverReplicaCut {
  readonly repoId: string;
  readonly revision: number;
  readonly tipHash: string;
  readonly history: string;
  readonly sequence: number;
}

export interface SwitchoverRollbackAudit {
  readonly targetNeverActivated: boolean;
  readonly targetInvalidated: boolean;
  readonly rollbackEpoch: number;
  readonly reason: string;
}

export interface CenterSwitchoverState {
  readonly switchoverId: string;
  readonly repoId: string;
  readonly triggerSource: SwitchoverTriggerSource;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly oldEpoch: number;
  readonly targetEpoch: number;
  readonly rollbackEpoch: number | null;
  readonly phase: CenterSwitchoverPhase;
  readonly frozenCut: SwitchoverFrozenCut | null;
  readonly updatedAt: string;
}

export interface SwitchoverPreflightInput {
  readonly repoId: string;
  readonly triggerSource: SwitchoverTriggerSource;
  readonly allowSentinelTrigger?: boolean;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly oldEpoch: number;
  readonly centerHistory: string;
  readonly tlsReachable: boolean;
  readonly tlsError?: string;
  readonly targetExternalUrl: string;
  readonly targetSpkiSha256: string;
  readonly replicaConnected: boolean;
  readonly replicaHistory: string | null;
  readonly replicaSyncFailureCode: string | null;
  readonly replicaLagRevisions: number | null;
  readonly maxAllowedLagRevisions: number;
  readonly availableDiskBytes: number;
  readonly requiredDiskBytes: number;
  readonly authReachable: boolean;
  readonly authError?: string;
  readonly targetLoginUrl: string;
  readonly sourceSymmetricReady: boolean;
  readonly sourceSymmetricIssue?: string;
}

export interface SwitchoverPreflightCheck {
  readonly check:
    | "trigger_source"
    | "node_identity"
    | "tls_reachable"
    | "replica_healthy"
    | "auth_reachable"
    | "symmetric_readiness";
  readonly passed: boolean;
  readonly code: string;
  readonly detail: string;
}

export interface SwitchoverPreflightResult {
  readonly ok: boolean;
  readonly checks: readonly SwitchoverPreflightCheck[];
  readonly blockingCodes: readonly string[];
}

export type RpoZeroBarrierIssue =
  | "repository_mismatch"
  | "history_mismatch"
  | "revision_lagging_or_mismatch"
  | "tip_hash_mismatch"
  | "sequence_mismatch";

export type RpoZeroBarrierVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "rpo_zero_barrier_unmet";
      readonly issues: readonly RpoZeroBarrierIssue[];
      readonly detail: string;
    };

export interface SwitchoverRollbackEligibilityInput {
  readonly requestedSwitchoverId: string;
  readonly fenceSwitchoverId: string;
  readonly oldEpoch: number;
  readonly cededEpoch: number;
  readonly targetNeverActivated: boolean;
  readonly targetInvalidated: boolean;
}

export type SwitchoverRollbackEligibilityVerdict =
  | { readonly ok: true; readonly rollbackEpoch: number }
  | { readonly ok: false; readonly code: string; readonly detail: string };

const SWITCHOVER_PHASE_GRAPH: Readonly<Record<CenterSwitchoverPhase, readonly CenterSwitchoverPhase[]>> = {
  idle: ["freezing"],
  freezing: ["fenced_ceded", "aborted_rolled_back"],
  fenced_ceded: ["target_activated", "aborted_rolled_back"],
  target_activated: ["demoted_edge"],
  demoted_edge: [],
  aborted_rolled_back: [],
};

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REPO_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const HEX_HISTORY_PATTERN = /^[0-9a-f]{32}$/u;
const SPKI_SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/u;

export function computeSwitchoverTargetEpoch(oldEpoch: number): number {
  if (!Number.isSafeInteger(oldEpoch) || oldEpoch < 1)
    throw new Error("Switchover oldEpoch must be a positive safe integer.");
  const targetEpoch = oldEpoch + 1;
  if (!Number.isSafeInteger(targetEpoch)) throw new Error("Switchover targetEpoch exceeds safe integer range.");
  return targetEpoch;
}

export function computeSwitchoverRollbackEpoch(oldEpoch: number, cededEpoch = oldEpoch + 1): number {
  verifySwitchoverFenceEpoch(oldEpoch, cededEpoch);
  const rollbackEpoch = Math.max(oldEpoch + 2, cededEpoch + 1);
  if (!Number.isSafeInteger(rollbackEpoch)) throw new Error("Switchover rollbackEpoch exceeds safe integer range.");
  return rollbackEpoch;
}

export function verifySwitchoverFenceEpoch(oldEpoch: number, cededEpoch: number): void {
  if (!Number.isSafeInteger(oldEpoch) || oldEpoch < 1 || !Number.isSafeInteger(cededEpoch) || cededEpoch < oldEpoch + 1)
    throw new Error(
      `Switchover fence epoch requires positive oldEpoch (${String(oldEpoch)}) and cededEpoch (${String(cededEpoch)}) >= oldEpoch + 1.`,
    );
}

export function isSwitchoverPhaseTransitionAllowed(from: CenterSwitchoverPhase, to: CenterSwitchoverPhase): boolean {
  return SWITCHOVER_PHASE_GRAPH[from].includes(to);
}

export function createCenterSwitchoverState(input: {
  readonly switchoverId: string;
  readonly repoId: string;
  readonly triggerSource: SwitchoverTriggerSource;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly oldEpoch: number;
  readonly now: string;
}): CenterSwitchoverState {
  if (input.switchoverId.trim().length === 0) throw new Error("switchoverId must be nonempty.");
  if (!REPO_ID_PATTERN.test(input.repoId)) throw new Error(`Invalid repository id for switchover: ${input.repoId}`);
  const targetEpoch = computeSwitchoverTargetEpoch(input.oldEpoch);
  return {
    switchoverId: input.switchoverId,
    repoId: input.repoId,
    triggerSource: input.triggerSource,
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    oldEpoch: input.oldEpoch,
    targetEpoch,
    rollbackEpoch: null,
    phase: "idle",
    frozenCut: null,
    updatedAt: input.now,
  };
}

export function transitionCenterSwitchoverState(
  state: CenterSwitchoverState,
  nextPhase: CenterSwitchoverPhase,
  context: {
    readonly now: string;
    readonly frozenCut?: SwitchoverFrozenCut;
    readonly rollbackAudit?: SwitchoverRollbackAudit;
  },
): CenterSwitchoverState {
  if (!isSwitchoverPhaseTransitionAllowed(state.phase, nextPhase))
    throw new Error(`Illegal center switchover transition: ${state.phase} -> ${nextPhase}`);
  if (nextPhase === "fenced_ceded") {
    const cut = context.frozenCut ?? state.frozenCut;
    if (cut === null) throw new Error("fenced_ceded requires a frozen center cut.");
    return { ...state, phase: nextPhase, frozenCut: cut, updatedAt: context.now };
  }
  if (nextPhase === "aborted_rolled_back" && state.phase === "fenced_ceded") {
    const audit = context.rollbackAudit;
    if (!audit || !audit.targetNeverActivated || !audit.targetInvalidated)
      throw new Error(
        "Aborting after fenced_ceded requires audited proof that target never activated and its attempt is invalidated.",
      );
    const expectedRollback = computeSwitchoverRollbackEpoch(state.oldEpoch, state.targetEpoch);
    if (audit.rollbackEpoch < expectedRollback)
      throw new Error(
        `Rollback epoch (${String(audit.rollbackEpoch)}) must be >= ${String(expectedRollback)} (oldEpoch + 2).`,
      );
    return { ...state, phase: nextPhase, rollbackEpoch: audit.rollbackEpoch, updatedAt: context.now };
  }
  return {
    ...state,
    phase: nextPhase,
    ...(context.frozenCut ? { frozenCut: context.frozenCut } : {}),
    updatedAt: context.now,
  };
}

function isHttpsOriginUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.pathname === "/";
  } catch {
    return false;
  }
}

function isHttpOrHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.username === "" && parsed.password === ""
    );
  } catch {
    return false;
  }
}

export function evaluateSwitchoverPreflight(input: SwitchoverPreflightInput): SwitchoverPreflightResult {
  const checks: SwitchoverPreflightCheck[] = [];

  const triggerAllowed =
    input.triggerSource === "operator" || (input.triggerSource === "sentinel" && input.allowSentinelTrigger === true);
  checks.push({
    check: "trigger_source",
    passed: triggerAllowed,
    code: triggerAllowed ? "ok" : "unsupported_trigger_source",
    detail: triggerAllowed
      ? `Trigger source "${input.triggerSource}" is admitted.`
      : `Switchover v1 requires triggerSource="operator" unless external quorum sentinel is explicitly enabled.`,
  });

  const validNodes =
    REPO_ID_PATTERN.test(input.repoId) &&
    NODE_ID_PATTERN.test(input.sourceNodeId) &&
    NODE_ID_PATTERN.test(input.targetNodeId) &&
    input.sourceNodeId !== input.targetNodeId &&
    Number.isSafeInteger(input.oldEpoch) &&
    input.oldEpoch >= 1 &&
    HEX_HISTORY_PATTERN.test(input.centerHistory);
  checks.push({
    check: "node_identity",
    passed: validNodes,
    code: validNodes ? "ok" : "invalid_switchover_identity",
    detail: validNodes
      ? `Switchover ${input.sourceNodeId} -> ${input.targetNodeId} for ${input.repoId} at epoch ${String(input.oldEpoch)}.`
      : "Switchover requires valid repoId, distinct source/target nodeIds, valid history, and positive oldEpoch.",
  });

  const tlsValid =
    input.tlsReachable && isHttpsOriginUrl(input.targetExternalUrl) && SPKI_SHA256_PATTERN.test(input.targetSpkiSha256);
  checks.push({
    check: "tls_reachable",
    passed: tlsValid,
    code: tlsValid ? "ok" : "target_tls_unreachable",
    detail: tlsValid
      ? `Target TLS endpoint ${input.targetExternalUrl} is reachable with valid SPKI.`
      : (input.tlsError ??
        `Target TLS endpoint ${input.targetExternalUrl} is unreachable or has invalid URL/SPKI format.`),
  });

  const replicaIssues: string[] = [];
  if (!input.replicaConnected) replicaIssues.push("replica_disconnected");
  if (input.replicaSyncFailureCode !== null) replicaIssues.push(`sync_failure:${input.replicaSyncFailureCode}`);
  if (input.replicaHistory !== input.centerHistory) replicaIssues.push("history_mismatch");
  if (input.replicaLagRevisions === null || input.replicaLagRevisions > input.maxAllowedLagRevisions)
    replicaIssues.push("replica_lag_exceeded");
  if (
    !Number.isFinite(input.availableDiskBytes) ||
    !Number.isFinite(input.requiredDiskBytes) ||
    input.availableDiskBytes < input.requiredDiskBytes
  )
    replicaIssues.push("insufficient_disk_space");
  const replicaHealthy = replicaIssues.length === 0;
  checks.push({
    check: "replica_healthy",
    passed: replicaHealthy,
    code: replicaHealthy ? "ok" : replicaIssues[0]!,
    detail: replicaHealthy
      ? `Target replica is healthy (lag=${String(input.replicaLagRevisions)} rev, free=${String(input.availableDiskBytes)} bytes).`
      : `Target replica failed health preflight: ${replicaIssues.join(", ")}.`,
  });

  const authValid = input.authReachable && isHttpOrHttpsUrl(input.targetLoginUrl);
  checks.push({
    check: "auth_reachable",
    passed: authValid,
    code: authValid ? "ok" : "auth_surface_unreachable",
    detail: authValid
      ? `Target authentication surface ${input.targetLoginUrl} is reachable.`
      : (input.authError ?? `Target authentication surface ${input.targetLoginUrl} is unreachable or invalid.`),
  });

  checks.push({
    check: "symmetric_readiness",
    passed: input.sourceSymmetricReady,
    code: input.sourceSymmetricReady ? "ok" : "source_symmetric_identity_missing",
    detail: input.sourceSymmetricReady
      ? `Source center ${input.sourceNodeId} has registered nodeId/credential and viewRoot ready for demotion.`
      : (input.sourceSymmetricIssue ??
        "Source center lacks registered nodeId/machine credential or viewRoot required for symmetric demotion."),
  });

  const blockingCodes = checks.filter((entry) => !entry.passed).map((entry) => entry.code);
  return {
    ok: blockingCodes.length === 0,
    checks,
    blockingCodes,
  };
}

export function evaluateRpoZeroCatchupBarrier(
  centerCut: SwitchoverFrozenCut,
  replicaCut: SwitchoverReplicaCut,
): RpoZeroBarrierVerdict {
  const issues: RpoZeroBarrierIssue[] = [];
  if (replicaCut.repoId !== centerCut.repoId) issues.push("repository_mismatch");
  if (replicaCut.history !== centerCut.history) issues.push("history_mismatch");
  if (replicaCut.revision !== centerCut.finalRevision) issues.push("revision_lagging_or_mismatch");
  if (replicaCut.tipHash !== centerCut.tipHash) issues.push("tip_hash_mismatch");
  if (replicaCut.sequence !== centerCut.sequence) issues.push("sequence_mismatch");
  if (issues.length > 0)
    return {
      ok: false,
      code: "rpo_zero_barrier_unmet",
      issues,
      detail:
        `RPO=0 catch-up barrier unmet (${issues.join(", ")}): ` +
        `center=(rev=${String(centerCut.finalRevision)}, seq=${String(centerCut.sequence)}, hist=${centerCut.history}, tip=${centerCut.tipHash}) vs ` +
        `replica=(rev=${String(replicaCut.revision)}, seq=${String(replicaCut.sequence)}, hist=${replicaCut.history}, tip=${replicaCut.tipHash}).`,
    };
  return { ok: true };
}

export function evaluateSwitchoverRollbackEligibility(
  input: SwitchoverRollbackEligibilityInput,
): SwitchoverRollbackEligibilityVerdict {
  if (input.fenceSwitchoverId !== input.requestedSwitchoverId)
    return {
      ok: false,
      code: "switchover_id_mismatch",
      detail: `Active fence names switchover ${input.fenceSwitchoverId}, not ${input.requestedSwitchoverId}.`,
    };
  if (!Number.isSafeInteger(input.oldEpoch) || input.oldEpoch < 1 || input.cededEpoch < input.oldEpoch + 1)
    return {
      ok: false,
      code: "switchover_fence_epoch_invalid",
      detail: `Fence epoch pair (${String(input.oldEpoch)} -> ${String(input.cededEpoch)}) is invalid.`,
    };
  if (!input.targetNeverActivated)
    return {
      ok: false,
      code: "target_activation_not_disproven",
      detail:
        "Audited rollback refused: target node may already have activated cededEpoch; complete demotion instead of rolling back.",
    };
  if (!input.targetInvalidated)
    return {
      ok: false,
      code: "target_attempt_not_invalidated",
      detail:
        "Audited rollback refused: switchoverId must be durably invalidated on target before restoring source writes at oldEpoch + 2.",
    };
  return {
    ok: true,
    rollbackEpoch: computeSwitchoverRollbackEpoch(input.oldEpoch, input.cededEpoch),
  };
}
