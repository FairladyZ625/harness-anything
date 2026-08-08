// PLT-Honest: the daemon autostart path used to spawn a fresh detached daemon
// on every request whose connection probe failed. When cold start is slow
// (large ledgers can need 60-90s of writer warm-up) but the 30s autostart
// budget fires, the flight is cleared and the very next request spawns a
// SIBLING daemon — producing an unbounded resurrection chain that starves
// the machine and erases the diagnostic scene.
//
// This module owns two honest invariants for a given daemon socket:
//
//   1. Live-startup tracking: if a spawned daemon process is still alive on
//      this socket (slowly starting, not dead), do not spawn another. Join it
//      by probing until it is ready or truly exits.
//   2. Consecutive-failure breaker: only count failures where the spawned
//      process actually died (or no process was produced). After N such
//      deaths, stop autostarting and surface an honest "circuit open" error
//      so an operator can diagnose instead of feeding the loop.

import {
  daemonProcessIsAlive,
  DaemonAutostartCircuitOpenError
} from "./daemon-autostart-process.ts";

export { DaemonAutostartCircuitOpenError } from "./daemon-autostart-process.ts";

export interface DaemonAutostartCircuitOptions {
  readonly maxConsecutiveFailures: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
}

export const defaultDaemonAutostartMaxConsecutiveFailures = 5;
export const defaultDaemonAutostartBackoffBaseMs = 2_000;
export const defaultDaemonAutostartBackoffCapMs = 30_000;

interface CircuitState {
  consecutiveFailures: number;
  nextAttemptAfterMs: number;
  lastCause: unknown;
  lastFailureAt: number;
}

interface LiveStartup {
  readonly pid: number;
  readonly recordedAt: number;
}

const circuits = new Map<string, CircuitState>();
const liveStartups = new Map<string, LiveStartup>();

export function resolveDaemonAutostartCircuitOptions(
  env: NodeJS.ProcessEnv = process.env
): DaemonAutostartCircuitOptions {
  return {
    maxConsecutiveFailures: positiveIntOr(
      env.HARNESS_DAEMON_AUTOSTART_MAX_FAILURES,
      defaultDaemonAutostartMaxConsecutiveFailures
    ),
    backoffBaseMs: positiveIntOr(
      env.HARNESS_DAEMON_AUTOSTART_BACKOFF_MS,
      defaultDaemonAutostartBackoffBaseMs
    ),
    backoffCapMs: positiveIntOr(
      env.HARNESS_DAEMON_AUTOSTART_BACKOFF_CAP_MS,
      defaultDaemonAutostartBackoffCapMs
    )
  };
}

/**
 * Returns the live spawned pid recorded for this socket, or undefined when no
 * live startup is in flight. A pid that has since exited is cleared and
 * reported as absent so callers never trust a stale record.
 */
export function liveDaemonStartupPid(socketPath: string, now = Date.now()): number | undefined {
  const record = liveStartups.get(socketPath);
  if (!record) return undefined;
  if (!daemonProcessIsAlive(record.pid)) {
    liveStartups.delete(socketPath);
    return undefined;
  }
  // Bound how long we trust a recorded startup so a wedged pid does not pin
  // the socket forever; the caller may then spawn (subject to the breaker).
  if (now - record.recordedAt > 5 * 60_000) {
    liveStartups.delete(socketPath);
    return undefined;
  }
  return record.pid;
}

export function recordLiveDaemonStartup(socketPath: string, pid: number | undefined): void {
  if (pid === undefined) {
    liveStartups.delete(socketPath);
    return;
  }
  if (!daemonProcessIsAlive(pid)) return;
  liveStartups.set(socketPath, { pid, recordedAt: Date.now() });
}

export function clearLiveDaemonStartup(socketPath: string, pid: number | undefined): void {
  const record = liveStartups.get(socketPath);
  if (record && pid !== undefined && record.pid === pid) {
    liveStartups.delete(socketPath);
  }
}

export interface DaemonAutostartOutcomeReport {
  readonly ok: boolean;
  readonly spawnedPid?: number;
  readonly processExited: boolean;
  readonly cause: unknown;
}

/**
 * Accounts an autostart outcome. A timeout where the spawned pid is STILL
 * ALIVE is not a failure (the daemon is honestly still starting); the pid is
 * recorded so the next caller joins it instead of respawning. A pid death
 * counts against the breaker. A spawn that produced NO pid is treated as
 * neutral (neither a death nor a live startup): in production a real spawn
 * always returns a pid, so the no-pid case is ambiguous, and silently
 * punishing it would block legitimate retries on the next attempt.
 */
export function reportDaemonAutostartOutcome(
  socketPath: string,
  outcome: DaemonAutostartOutcomeReport,
  options: DaemonAutostartCircuitOptions = resolveDaemonAutostartCircuitOptions(),
  now = Date.now()
): void {
  if (outcome.ok) {
    circuits.delete(socketPath);
    liveStartups.delete(socketPath);
    return;
  }
  if (outcome.spawnedPid !== undefined
    && daemonProcessIsAlive(outcome.spawnedPid)
    && !outcome.processExited) {
    // Honest slow start: keep the pid so siblings join it instead of respawning.
    recordLiveDaemonStartup(socketPath, outcome.spawnedPid);
    return;
  }
  if (outcome.spawnedPid === undefined) {
    // Ambiguous: no pid to attribute. Do not punish the breaker for what we
    // cannot honestly classify as a death. The next attempt may proceed.
    return;
  }
  liveStartups.delete(socketPath);
  const state = circuits.get(socketPath) ?? freshCircuit(now);
  state.consecutiveFailures += 1;
  state.lastCause = outcome.cause;
  state.lastFailureAt = now;
  state.nextAttemptAfterMs = now + backoffMs(state.consecutiveFailures, options);
  circuits.set(socketPath, state);
}

export interface DaemonAutostartCircuitDecision {
  readonly allowSpawn: boolean;
  readonly retryAfterMs: number;
  readonly consecutiveFailures: number;
  readonly lastCause: unknown;
}

/**
 * Decides whether a new autostart spawn is permitted on this socket right
 * now. When the breaker is open, returns an honest decision the caller can
 * surface verbatim instead of silently feeding the resurrection chain.
 */
export function daemonAutostartCircuitDecision(
  socketPath: string,
  options: DaemonAutostartCircuitOptions = resolveDaemonAutostartCircuitOptions(),
  now = Date.now()
): DaemonAutostartCircuitDecision {
  const state = circuits.get(socketPath);
  if (!state) {
    return { allowSpawn: true, retryAfterMs: 0, consecutiveFailures: 0, lastCause: undefined };
  }
  const retryAfterMs = Math.max(0, state.nextAttemptAfterMs - now);
  return {
    allowSpawn: retryAfterMs === 0 && state.consecutiveFailures < options.maxConsecutiveFailures,
    retryAfterMs,
    consecutiveFailures: state.consecutiveFailures,
    lastCause: state.lastCause
  };
}

export function daemonAutostartCircuitOpenError(
  socketPath: string,
  decision: DaemonAutostartCircuitDecision,
  options: DaemonAutostartCircuitOptions = resolveDaemonAutostartCircuitOptions()
): DaemonAutostartCircuitOpenError {
  return new DaemonAutostartCircuitOpenError(
    options.maxConsecutiveFailures,
    decision.consecutiveFailures,
    decision.retryAfterMs,
    socketPath,
    decision.lastCause
  );
}

export function resetDaemonAutostartCircuit(socketPath?: string): void {
  if (socketPath === undefined) {
    circuits.clear();
    liveStartups.clear();
    return;
  }
  circuits.delete(socketPath);
  liveStartups.delete(socketPath);
}

export function __daemonAutostartCircuitStateForTest(socketPath: string): {
  readonly consecutiveFailures: number;
  readonly nextAttemptAfterMs: number;
  readonly liveStartupPid: number | undefined;
} | undefined {
  const state = circuits.get(socketPath);
  return {
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    nextAttemptAfterMs: state?.nextAttemptAfterMs ?? 0,
    liveStartupPid: liveDaemonStartupPid(socketPath)
  };
}

function freshCircuit(now: number): CircuitState {
  return {
    consecutiveFailures: 0,
    nextAttemptAfterMs: now,
    lastCause: undefined,
    lastFailureAt: now
  };
}

function backoffMs(consecutiveFailures: number, options: DaemonAutostartCircuitOptions): number {
  // Exponential backoff with a deterministic base; the cap keeps a pathological
  // socket from silencing autostart for minutes at a time.
  const exp = options.backoffBaseMs * 2 ** (consecutiveFailures - 1);
  return Math.min(options.backoffCapMs, Math.max(options.backoffBaseMs, exp));
}

function positiveIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
