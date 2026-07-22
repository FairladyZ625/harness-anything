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
    capability?: { readonly includeGenerationAxes: true }
  ) => Promise<Record<string, unknown> | undefined>;
  readonly ownerIsAlive: (pid: number) => boolean;
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
  readonly timeoutMs: number;
  readonly kind: "restart" | "refresh";
  readonly method: "admin.daemon.restart" | "admin.daemon.refresh";
  readonly launchConfiguration: DaemonLaunchConfiguration;
  readonly expectedIdentity: string | undefined;
  readonly expectedGeneration: DaemonGenerationConvergenceExpectation | undefined;
  readonly rollbackLaunchConfiguration?: DaemonLaunchConfiguration;
  readonly upgradeRecovery?: DaemonControlRecoveryGuidance;
}

interface StartedReplacementResult {
  readonly kind: "complete" | "wrong-snapshot-occupant";
  readonly status: Record<string, unknown>;
  readonly lifecycle: DaemonLifecycleStatus;
}

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
    const result = await attemptDaemonReplacement(input, input.beforePid, input.beforeLoadedIdentity, input.operationId);
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
  beforeLoadedIdentity: string,
  operationId: string
): Promise<StartedReplacementResult> {
  const handoff = await waitForDaemonControlHandoff(
    input.lifecycle, beforePid, operationId, input.timeoutMs, input.expectedIdentity, input.expectedGeneration
  );
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
      input.timeoutMs,
      input.launchConfiguration,
      input.expectedGeneration ? { includeGenerationAxes: true } : undefined
    );
  } catch (error) {
    return await failOrRollback(input, error, beforePid, beforeLoadedIdentity, operationId, true);
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
    return await failOrRollback(input, error, beforePid, beforeLoadedIdentity, operationId, false);
  }
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
  const attempts = Math.ceil(input.timeoutMs / pollIntervalMs) + 1;
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
    await input.lifecycle.stopReplacement(input.lifecycle.target, occupant.pid, input.timeoutMs);
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
    await input.lifecycle.stopReplacement(input.lifecycle.target, replacement.pid, input.timeoutMs);
  } catch (error) {
    throw new Error(
      `daemon ${input.kind} replacement ${failure}; cleanup failed and replacement may still be serving: ${daemonReplacementErrorMessage(error)}`
    );
  }
  throw new Error(`daemon ${input.kind} replacement ${failure}; rejected replacement was stopped and endpoint remained unowned`);
}

async function failOrRollback(
  input: CompleteDaemonReplacementInput,
  error: unknown,
  beforePid: number,
  beforeLoadedIdentity: string,
  operationId: string,
  wrapReplacementStartFailure: boolean
): Promise<never> {
  const failure = wrapReplacementStartFailure
    ? new Error(
        `DAEMON_${input.kind.toUpperCase()}_REPLACEMENT_FAILED_AFTER_HANDOFF: ${daemonReplacementErrorMessage(error)}. `
        + `Restore the daemon with: ${daemonRecoveryCommand(input.rollbackLaunchConfiguration ?? input.launchConfiguration)}`
      )
    : error;
  if (!input.rollbackLaunchConfiguration) throw failure;
  return await rollbackDaemonReplacement({
    lifecycle: input.lifecycle,
    replacementFailure: failure,
    beforePid,
    beforeLoadedIdentity,
    operationId,
    timeoutMs: input.timeoutMs,
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
