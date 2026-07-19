import type { LocalDaemonTarget } from "../../../../daemon/src/index.ts";

export interface DaemonReplacementStopRuntime {
  readonly probeStatus: (target: LocalDaemonTarget) => Promise<Record<string, unknown> | undefined>;
  readonly statusPid: (status: Record<string, unknown>) => number | undefined;
  readonly processIsAlive: (pid: number) => boolean;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly wait: (ms: number) => Promise<void>;
  readonly endpointStabilityMs?: number;
}

export async function stopDaemonReplacement(
  target: LocalDaemonTarget,
  pid: number,
  timeoutMs: number,
  runtime: DaemonReplacementStopRuntime
): Promise<void> {
  if (!runtime.processIsAlive(pid)) {
    await verifyEndpointRemainsUnowned(target, runtime);
    return;
  }
  if (!await targetEndpointIsOwnedBy(target, pid, runtime)) {
    await verifyEndpointRemainsUnowned(target, runtime);
    return;
  }
  try {
    runtime.signal(pid, "SIGTERM");
  } catch (error) {
    if (replacementSignalErrorCode(error) === "ESRCH") {
      await verifyEndpointRemainsUnowned(target, runtime);
      return;
    }
    throw error;
  }
  const pollIntervalMs = 100;
  const termAttempts = Math.ceil(Math.max(1, Math.floor(timeoutMs / 2)) / pollIntervalMs) + 1;
  if (!await waitForReplacementExit(pid, termAttempts, pollIntervalMs, runtime)) {
    if (!await targetEndpointIsOwnedBy(target, pid, runtime)) {
      await verifyEndpointRemainsUnowned(target, runtime);
      return;
    }
    try {
      runtime.signal(pid, "SIGKILL");
    } catch (error) {
      if (replacementSignalErrorCode(error) !== "ESRCH") throw error;
    }
    const killAttempts = Math.ceil(Math.max(1, timeoutMs - Math.floor(timeoutMs / 2)) / pollIntervalMs) + 1;
    if (!await waitForReplacementExit(pid, killAttempts, pollIntervalMs, runtime)) {
      throw new Error(`SIGTERM and SIGKILL did not stop replacement pid ${pid}`);
    }
  }
  await verifyEndpointRemainsUnowned(target, runtime);
}

async function targetEndpointIsOwnedBy(
  target: LocalDaemonTarget,
  pid: number,
  runtime: DaemonReplacementStopRuntime
): Promise<boolean> {
  const status = await runtime.probeStatus(target);
  const observedPid = status ? runtime.statusPid(status) : undefined;
  if (observedPid === pid) return true;
  if (!runtime.processIsAlive(pid)) return false;
  if (observedPid !== undefined) {
    throw new Error(`target endpoint reports pid ${observedPid}; refusing to signal pid ${pid}`);
  }
  throw new Error(`target endpoint does not prove ownership by pid ${pid}; refusing to signal it`);
}

async function waitForReplacementExit(
  pid: number,
  attempts: number,
  pollIntervalMs: number,
  runtime: DaemonReplacementStopRuntime
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!runtime.processIsAlive(pid)) return true;
    if (attempt + 1 < attempts) await runtime.wait(pollIntervalMs);
  }
  return false;
}

async function verifyEndpointRemainsUnowned(
  target: LocalDaemonTarget,
  runtime: DaemonReplacementStopRuntime
): Promise<void> {
  const stabilityMs = runtime.endpointStabilityMs ?? 500;
  const pollIntervalMs = 100;
  const attempts = Math.ceil(stabilityMs / pollIntervalMs) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await runtime.probeStatus(target);
    if (status) {
      const observedPid = runtime.statusPid(status);
      throw new Error(
        observedPid === undefined
          ? "target endpoint remained reachable with an unrecognized daemon status"
          : `target endpoint became reachable again with pid ${observedPid}`
      );
    }
    if (attempt + 1 < attempts) await runtime.wait(pollIntervalMs);
  }
}

function replacementSignalErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}
