import type { LocalDaemonTarget } from "@harness-anything/daemon";
import type { DaemonLaunchConfiguration } from "../../daemon/daemon-launch-spec.ts";
import {
  incompleteReplacementReason,
  isCompleteReplacement,
  normalizeDaemonLifecycleStatus,
  replacementIdentityIsInvalid,
  type DaemonGenerationConvergenceExpectation,
  type DaemonLifecycleStatus
} from "./control-convergence.ts";
import { waitForDaemonControlHandoff } from "./control-handoff.ts";
import { daemonRecoveryCommand, rollbackDaemonReplacement } from "./snapshot-rollback.ts";

export interface DaemonControlLifecycle {
  readonly target: LocalDaemonTarget;
  readonly probeGenerationStatus?: (target: LocalDaemonTarget) => Promise<Record<string, unknown> | undefined>;
  readonly probeStatus: (
    target: LocalDaemonTarget,
    capability?: { readonly includeGenerationAxes: true },
    requestTimeoutMs?: number
  ) => Promise<Record<string, unknown> | undefined>;
  readonly probeEndpointOwner?: (
    target: LocalDaemonTarget
  ) => { readonly pid: number; readonly alive: boolean } | undefined;
  readonly ownerIsAlive: (pid: number) => boolean;
  readonly isReadinessTimeout?: (error: unknown) => boolean;
  readonly readinessTimeoutPid?: (error: unknown) => number | undefined;
  readonly reportProgress?: (message: string) => void;
  readonly prepareReplacement?: (target: LocalDaemonTarget) => Promise<DaemonLaunchConfiguration>;
  readonly startReplacement: (
    target: LocalDaemonTarget,
    timeoutMs: number,
    launchConfiguration: DaemonLaunchConfiguration,
    capability?: { readonly includeGenerationAxes: true }
  ) => Promise<Record<string, unknown>>;
  readonly stopReplacement?: (target: LocalDaemonTarget, pid: number, timeoutMs: number) => Promise<void>;
  readonly wait: (ms: number) => Promise<void>;
}

export interface DaemonControlRecoveryGuidance {
  readonly retryCommand: string;
  readonly occupiedEndpoint: string;
}

interface HandoffRecoveryAttempt {
  readonly attempt: number;
  readonly occupantPid: number;
  readonly loadedIdentity: string;
  readonly expectedSnapshotIdentity: string;
  readonly disposition: "stopped-and-retrying" | "stopped-retry-exhausted" | "stopped-successor-detected" | "cleanup-failed";
  readonly cleanupFailure?: string;
  readonly successorPid?: number;
}

interface CompleteDaemonReplacementInput {
  readonly lifecycle: DaemonControlLifecycle;
  readonly beforePid: unknown;
  readonly beforeLoadedIdentity: unknown;
  readonly operationId: unknown;
  readonly handoffTimeoutMs: number;
  readonly replacementTimeoutMs: number;
  readonly replacementSettlingTimeoutMs: number;
  readonly kind: "restart" | "refresh" | "upgrade";
  readonly method: "admin.daemon.restart" | "admin.daemon.refresh";
  readonly launchConfiguration: DaemonLaunchConfiguration;
  readonly expectedIdentity: string | undefined;
  readonly expectedGeneration: DaemonGenerationConvergenceExpectation | undefined;
  readonly rollbackLaunchConfiguration?: DaemonLaunchConfiguration;
  readonly rollbackExpectedIdentity?: unknown;
  readonly upgradeRecovery?: DaemonControlRecoveryGuidance;
}

interface StartedReplacementResult {
  readonly kind: "complete" | "wrong-snapshot-occupant";
  readonly status: Record<string, unknown>;
  readonly lifecycle: DaemonLifecycleStatus;
}

class DaemonReplacementEndpointUnownedError extends Error {}

const upgradeHandoffMaxAttempts = 3;

export async function completeDaemonReplacement(
  input: CompleteDaemonReplacementInput
): Promise<Record<string, unknown>> {
  if (!isPositivePid(input.beforePid)) {
    throw new Error(`${input.method} accepted receipt did not identify the running daemon PID`);
  }
  if (typeof input.beforeLoadedIdentity !== "string" || typeof input.operationId !== "string") {
    throw new Error(`${input.method} accepted receipt did not identify the loaded build and operation`);
  }
  const attempts: HandoffRecoveryAttempt[] = [];
  const maxAttempts = input.upgradeRecovery ? upgradeHandoffMaxAttempts : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await attemptDaemonReplacement(input, input.beforePid, input.operationId);
    if (result.kind === "complete") {
      return withHandoffRecovery(result.status, input.upgradeRecovery, attempt, attempts);
    }
    await stopWrongSnapshotOccupant(input, result.lifecycle, input.operationId, attempt, maxAttempts, attempts);
  }
  throw new Error("daemon replacement retry loop exhausted without a terminal result");
}

async function attemptDaemonReplacement(
  input: CompleteDaemonReplacementInput,
  beforePid: number,
  operationId: string
): Promise<StartedReplacementResult> {
  let handoff: Awaited<ReturnType<typeof waitForDaemonControlHandoff>>;
  try {
    handoff = await waitForDaemonControlHandoff(
      input.lifecycle, beforePid, operationId, input.handoffTimeoutMs, input.expectedIdentity, input.expectedGeneration
    );
  } catch (error) {
    return await failOrRollback(input, error, beforePid, operationId, "handoff");
  }
  if (handoff.kind === "adopt") {
    const lifecycle = normalizeDaemonLifecycleStatus(handoff.status);
    if (!lifecycle) throw new Error(`daemon ${input.kind} adopted replacement returned an invalid status`);
    return { kind: "complete", status: handoff.status, lifecycle };
  }
  if (handoff.kind === "reject") {
    if (isWrongSnapshotOccupant(handoff.status, input.expectedIdentity, operationId, input.upgradeRecovery)) {
      return { kind: "wrong-snapshot-occupant", status: lifecycleStatusRecord(handoff.status), lifecycle: handoff.status };
    }
    await rejectIncompleteReplacement(input, handoff.status, beforePid, operationId);
  }
  let replacement: Record<string, unknown>;
  try {
    replacement = await input.lifecycle.startReplacement(
      input.lifecycle.target,
      input.replacementTimeoutMs,
      input.launchConfiguration,
      input.expectedGeneration ? { includeGenerationAxes: true } : undefined
    );
  } catch (error) {
    if (!input.lifecycle.isReadinessTimeout?.(error)) {
      return await failOrRollback(input, error, beforePid, operationId, "replacement-start");
    }
    try {
      replacement = await waitForTimedOutReplacement(input, error, beforePid);
    } catch (settlingError) {
      return await failOrRollback(input, settlingError, beforePid, operationId, "replacement-start");
    }
  }
  try {
    const replacementLifecycle = normalizeDaemonLifecycleStatus(replacement);
    if (!replacementLifecycle) {
      throw new Error(`daemon ${input.kind} replacement did not return a reachable started daemon status`);
    }
    if (replacementLifecycle.pid === beforePid) {
      throw new Error(`daemon ${input.kind} replacement PID did not change: ${String(replacementLifecycle.pid)}; replacement was not signaled`);
    }
    return await waitForStartedReplacement(input, replacement, replacementLifecycle, beforePid, operationId);
  } catch (error) {
    return await failOrRollback(input, error, beforePid, operationId, "replacement-validation");
  }
}

async function waitForTimedOutReplacement(
  input: CompleteDaemonReplacementInput,
  readinessTimeout: unknown,
  beforePid: number
): Promise<Record<string, unknown>> {
  const initialOwner = input.lifecycle.probeEndpointOwner?.(input.lifecycle.target);
  const spawnedPid = input.lifecycle.readinessTimeoutPid?.(readinessTimeout);
  const replacementPid = spawnedPid
    ?? (initialOwner?.alive === true && initialOwner.pid !== beforePid ? initialOwner.pid : undefined);
  if (replacementPid === undefined || !input.lifecycle.ownerIsAlive(replacementPid)) {
    throw readinessTimeout;
  }
  if (initialOwner && initialOwner.pid !== replacementPid) {
    throw new Error(
      `replacement readiness deadline elapsed, but endpoint owner pid ${initialOwner.pid} did not match launched pid ${replacementPid}`
    );
  }

  input.lifecycle.reportProgress?.(
    `Replacement readiness deadline elapsed after ${input.replacementTimeoutMs}ms; pid ${replacementPid} is alive`
    + `${initialOwner?.pid === replacementPid ? " and owns the endpoint" : ""}, and is still starting. `
    + `Continuing bounded observation for up to ${input.replacementSettlingTimeoutMs}ms.`
  );

  const deadline = Date.now() + input.replacementSettlingTimeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const status = await input.lifecycle.probeStatus(
      input.lifecycle.target,
      input.expectedGeneration ? { includeGenerationAxes: true } : undefined,
      Math.min(1_000, remainingMs)
    );
    const observedLifecycle = status ? normalizeDaemonLifecycleStatus(status) : undefined;
    if (status && observedLifecycle) {
      if (observedLifecycle.pid !== replacementPid) {
        throw new Error(
          `replacement readiness observation reached pid ${observedLifecycle.pid}, expected launched pid ${replacementPid}`
        );
      }
      return status;
    }
    if (!input.lifecycle.ownerIsAlive(replacementPid)) throw readinessTimeout;
    const owner = input.lifecycle.probeEndpointOwner?.(input.lifecycle.target);
    if (owner && owner.pid !== replacementPid) {
      throw new Error(
        `replacement readiness observation found endpoint owner pid ${owner.pid}, expected launched pid ${replacementPid}`
      );
    }
    const waitMs = Math.min(100, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) await input.lifecycle.wait(waitMs);
  }

  if (!input.lifecycle.ownerIsAlive(replacementPid)) throw readinessTimeout;
  if (!input.lifecycle.stopReplacement) {
    throw new Error(
      `replacement pid ${replacementPid} remained alive but unreachable after the additional `
      + `${input.replacementSettlingTimeoutMs}ms settling limit; cleanup unavailable, so it may still be starting`
    );
  }
  try {
    await input.lifecycle.stopReplacement(
      input.lifecycle.target,
      replacementPid,
      input.replacementTimeoutMs
    );
  } catch (error) {
    throw new Error(
      `replacement pid ${replacementPid} remained alive but unreachable after the additional `
      + `${input.replacementSettlingTimeoutMs}ms settling limit; cleanup failed and it may still be starting: `
      + daemonReplacementErrorMessage(error)
    );
  }
  throw new DaemonReplacementEndpointUnownedError(
    `replacement pid ${replacementPid} exceeded the additional ${input.replacementSettlingTimeoutMs}ms settling limit; `
    + "the timed-out replacement was stopped and the endpoint remained unowned"
  );
}

async function waitForStartedReplacement(
  input: CompleteDaemonReplacementInput,
  initialStatus: Record<string, unknown>,
  initialLifecycle: DaemonLifecycleStatus,
  beforePid: number,
  operationId: string
): Promise<StartedReplacementResult> {
  let status = initialStatus;
  let replacement = initialLifecycle;
  const pollIntervalMs = 100;
  const attempts = Math.ceil(input.replacementTimeoutMs / pollIntervalMs) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (replacement.pid === beforePid) {
      throw new Error(`daemon ${input.kind} replacement PID did not change: ${String(replacement.pid)}; replacement was not signaled`);
    }
    if (replacementIdentityIsInvalid(replacement, input.expectedIdentity)) {
      await rejectIncompleteReplacement(input, replacement, beforePid, operationId);
    }
    if (isCompleteReplacement(replacement, beforePid, operationId, input.expectedIdentity, input.expectedGeneration)) {
      return { kind: "complete", status, lifecycle: replacement };
    }
    if (attempt + 1 < attempts) {
      await input.lifecycle.wait(pollIntervalMs);
      const observed = await input.lifecycle.probeStatus(
        input.lifecycle.target,
        input.expectedGeneration ? { includeGenerationAxes: true } : undefined
      );
      const observedLifecycle = observed ? normalizeDaemonLifecycleStatus(observed) : undefined;
      if (observed && observedLifecycle) {
        status = observed;
        replacement = observedLifecycle;
      }
    }
  }
  if (replacement.activeOperationId && replacement.activeOperationId !== operationId) {
    throw new Error(
      `daemon ${input.kind} replacement remained healthy but another daemon control operation remained active: `
      + `${replacement.activeOperationId}; replacement was left running`
    );
  }
  return await rejectIncompleteReplacement(input, replacement, beforePid, operationId);
}

async function stopWrongSnapshotOccupant(
  input: CompleteDaemonReplacementInput,
  occupant: DaemonLifecycleStatus,
  operationId: string,
  attempt: number,
  maxAttempts: number,
  attempts: HandoffRecoveryAttempt[]
): Promise<void> {
  const expectedIdentity = input.expectedIdentity!;
  const base = {
    attempt,
    occupantPid: occupant.pid,
    loadedIdentity: occupant.loadedIdentity!,
    expectedSnapshotIdentity: expectedIdentity
  } as const;
  if (!input.lifecycle.stopReplacement) {
    attempts.push({ ...base, disposition: "cleanup-failed", cleanupFailure: "cleanup unavailable" });
    throw recoveryError(
      `daemon upgrade found a wrong-identity endpoint owner; cleanup unavailable; replacement may still be serving. ${input.upgradeRecovery!.occupiedEndpoint}`,
      maxAttempts,
      attempt,
      attempts
    );
  }
  try {
    await input.lifecycle.stopReplacement(input.lifecycle.target, occupant.pid, input.replacementTimeoutMs);
  } catch (error) {
    const failure = daemonReplacementErrorMessage(error);
    const successor = await probeWrongSnapshotSuccessor(input, occupant, operationId);
    if (successor) {
      attempts.push({
        ...base,
        disposition: "stopped-successor-detected",
        cleanupFailure: failure,
        successorPid: successor.pid
      });
      if (attempt < maxAttempts) return;
      throw recoveryError(
        `DAEMON_UPGRADE_HANDOFF_RETRIES_EXHAUSTED: stopping pid ${occupant.pid} exposed another wrong-identity endpoint owner pid ${successor.pid}. ${input.upgradeRecovery!.occupiedEndpoint}`,
        maxAttempts,
        attempt,
        attempts
      );
    }
    attempts.push({ ...base, disposition: "cleanup-failed", cleanupFailure: failure });
    throw recoveryError(
      `daemon upgrade found a wrong-identity endpoint owner; cleanup failed and replacement may still be serving: ${failure}. ${input.upgradeRecovery!.occupiedEndpoint}`,
      maxAttempts,
      attempt,
      attempts
    );
  }
  const exhausted = attempt === maxAttempts;
  attempts.push({ ...base, disposition: exhausted ? "stopped-retry-exhausted" : "stopped-and-retrying" });
  if (exhausted) {
    throw recoveryError(
      `DAEMON_UPGRADE_HANDOFF_RETRIES_EXHAUSTED: stopped ${maxAttempts} wrong-identity endpoint owners; endpoint remained unowned. Retry exactly with: ${input.upgradeRecovery!.retryCommand}`,
      maxAttempts,
      attempt,
      attempts
    );
  }
}

async function rejectIncompleteReplacement(
  input: CompleteDaemonReplacementInput,
  replacement: DaemonLifecycleStatus,
  beforePid: number,
  operationId: string
): Promise<never> {
  const failure = incompleteReplacementReason(
    replacement, beforePid, operationId, input.expectedIdentity, input.expectedGeneration
  );
  if (replacement.pid === beforePid) {
    throw new Error(`daemon ${input.kind} replacement ${failure}; replacement was not signaled`);
  }
  if (!input.lifecycle.stopReplacement) {
    throw new Error(`daemon ${input.kind} replacement ${failure}; cleanup unavailable; replacement may still be serving`);
  }
  try {
    await input.lifecycle.stopReplacement(input.lifecycle.target, replacement.pid, input.replacementTimeoutMs);
  } catch (error) {
    throw new Error(
      `daemon ${input.kind} replacement ${failure}; cleanup failed and replacement may still be serving: ${daemonReplacementErrorMessage(error)}`
    );
  }
  throw new DaemonReplacementEndpointUnownedError(
    `daemon ${input.kind} replacement ${failure}; rejected replacement was stopped and endpoint remained unowned`
  );
}

async function failOrRollback(
  input: CompleteDaemonReplacementInput,
  error: unknown,
  beforePid: number,
  operationId: string,
  phase: "handoff" | "replacement-start" | "replacement-validation"
): Promise<never> {
  const failure = phase === "replacement-start"
    ? new Error(
        `DAEMON_${input.kind.toUpperCase()}_REPLACEMENT_FAILED_AFTER_HANDOFF: ${daemonReplacementErrorMessage(error)}. `
        + `Restore the daemon with: ${daemonRecoveryCommand(input.rollbackLaunchConfiguration ?? input.launchConfiguration)}`
      )
    : error;
  if (phase === "replacement-validation" && !(failure instanceof DaemonReplacementEndpointUnownedError)) {
    throw failure;
  }
  if (!input.rollbackLaunchConfiguration) throw failure;
  return await rollbackDaemonReplacement({
    lifecycle: input.lifecycle,
    replacementFailure: failure,
    beforePid,
    expectedIdentity: typeof input.rollbackExpectedIdentity === "string"
      ? input.rollbackExpectedIdentity
      : undefined,
    operationId,
    timeoutMs: input.replacementTimeoutMs,
    kind: input.kind,
    launchConfiguration: input.rollbackLaunchConfiguration,
    expectedGeneration: input.expectedGeneration
  });
}

async function probeWrongSnapshotSuccessor(
  input: CompleteDaemonReplacementInput,
  occupant: DaemonLifecycleStatus,
  operationId: string
): Promise<DaemonLifecycleStatus | undefined> {
  const status = await input.lifecycle.probeStatus(
    input.lifecycle.target,
    input.expectedGeneration ? { includeGenerationAxes: true } : undefined
  );
  const successor = status ? normalizeDaemonLifecycleStatus(status) : undefined;
  return successor
    && successor.pid !== occupant.pid
    && isWrongSnapshotOccupant(successor, input.expectedIdentity, operationId, input.upgradeRecovery)
    ? successor
    : undefined;
}

function isWrongSnapshotOccupant(
  status: DaemonLifecycleStatus,
  expectedIdentity: string | undefined,
  operationId: string,
  recovery: DaemonControlRecoveryGuidance | undefined
): boolean {
  return recovery !== undefined
    && status.schema === "daemon-status/v2"
    && typeof status.loadedIdentity === "string"
    && typeof expectedIdentity === "string"
    && status.loadedIdentity !== expectedIdentity
    && (status.activeOperationId === undefined || status.activeOperationId === operationId);
}

function withHandoffRecovery(
  status: Record<string, unknown>,
  recovery: DaemonControlRecoveryGuidance | undefined,
  attemptsUsed: number,
  attempts: ReadonlyArray<HandoffRecoveryAttempt>
): Record<string, unknown> {
  if (!recovery) return status;
  return {
    ...status,
    handoffRecovery: {
      maxAttempts: upgradeHandoffMaxAttempts,
      attemptsUsed,
      retryCount: attempts.length,
      attempts
    }
  };
}

function recoveryError(
  message: string,
  maxAttempts: number,
  attemptsUsed: number,
  attempts: ReadonlyArray<HandoffRecoveryAttempt>
): Error {
  const evidence = { maxAttempts, attemptsUsed, retryCount: attempts.length, attempts };
  return new Error(`${message}. Handoff recovery evidence: ${JSON.stringify(evidence)}`);
}

function lifecycleStatusRecord(status: DaemonLifecycleStatus): Record<string, unknown> {
  return { ...status };
}

function daemonReplacementErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
