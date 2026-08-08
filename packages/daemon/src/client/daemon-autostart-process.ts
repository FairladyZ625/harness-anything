import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync } from "node:fs";
import path from "node:path";

export interface SpawnedDaemonAutostartProcess {
  readonly pid?: number;
  readonly launchStderrPath?: string;
}

export interface DetachedDaemonAutostartInput {
  readonly execPath: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly userRoot: string;
}

export class DaemonAutostartTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly spawnedPid?: number;

  constructor(timeoutMs: number, lastError: unknown, spawnedPid?: number) {
    const cause = errorMessage(lastError, "no ready probe completed");
    super(
      `DAEMON_AUTOSTART_TIMEOUT: readiness was not confirmed within the normal ${timeoutMs}ms startup budget; `
      + `the launched process${spawnedPid === undefined ? "" : ` pid ${spawnedPid}`} may still be starting. Last probe: ${cause}`
    );
    this.name = "DaemonAutostartTimeoutError";
    this.timeoutMs = timeoutMs;
    this.spawnedPid = spawnedPid;
  }
}

export class DaemonAutostartProcessExitedError extends Error {
  readonly spawnedPid: number;
  readonly launchStderrPath?: string;

  constructor(lastError: unknown, spawnedPid: number, launchStderrPath?: string) {
    const lastProbe = errorMessage(lastError, "no ready probe completed");
    const startupFailure = launchStderrPath ? daemonLaunchStderrFailure(launchStderrPath) : undefined;
    super(
      `DAEMON_AUTOSTART_PROCESS_EXITED: the launched process pid ${spawnedPid} exited before readiness.`
      + `${startupFailure ? ` Startup failure: ${startupFailure}.` : " No startup stderr was captured."}`
      + `${launchStderrPath ? ` Launch log: ${launchStderrPath}.` : ""}`
      + ` Last probe: ${lastProbe}`
    );
    this.name = "DaemonAutostartProcessExitedError";
    this.spawnedPid = spawnedPid;
    this.launchStderrPath = launchStderrPath;
  }
}

/**
 * PLT-Honest: raised by the autostart circuit breaker after N consecutive
 * daemon deaths on the same socket. The message is written so an operator
 * (or an agent following it verbatim) reads an honest stop condition instead
 * of being silently fed back into the resurrection chain. It deliberately
 * does NOT suggest `ha daemon restart` or `HARNESS_DAEMON_MODE=direct`,
 * because the breaker fires on the death side (not on slow start), and a
 * blind restart is the action that kept killing the user's recovering
 * daemon today.
 */
export class DaemonAutostartCircuitOpenError extends Error {
  readonly maxConsecutiveFailures: number;
  readonly consecutiveFailures: number;
  readonly retryAfterMs: number;
  readonly socketPath: string;

  constructor(
    maxConsecutiveFailures: number,
    consecutiveFailures: number,
    retryAfterMs: number,
    socketPath: string,
    lastCause: unknown
  ) {
    const cause = errorMessage(lastCause, "no probe completed");
    // Backing off is not the same state as giving up, and saying "stopped
    // autostarting" while a retry is seconds away sends the reader looking for
    // a cause that does not exist yet. Report whichever is actually true.
    const givenUp = consecutiveFailures >= maxConsecutiveFailures;
    const state = givenUp
      ? `DAEMON_AUTOSTART_CIRCUIT_OPEN: stopped autostarting after ${consecutiveFailures} consecutive daemon`
        + ` startup failures on socket ${socketPath} (limit ${maxConsecutiveFailures}). The breaker is honest`
        + ` about giving up rather than silently feeding an infinite respawn loop.`
      : `DAEMON_AUTOSTART_BACKOFF: waiting ${Math.max(1, Math.round(retryAfterMs / 1000))}s before the next`
        + ` autostart attempt on socket ${socketPath} after ${consecutiveFailures} consecutive daemon startup`
        + ` failure(s) (the breaker gives up at ${maxConsecutiveFailures}). Autostart has NOT given up; the`
        + ` backoff keeps a failing spawn from becoming a respawn loop.`;
    super(
      `${state} Last failure: ${cause}.`
      + ` Do NOT run 'ha daemon restart' — that kills whatever is recovering. Next: inspect the startup log`
      + ` (see DAEMON_AUTOSTART_PROCESS_EXITED for the launch log path) or 'ha daemon status --json'; once`
      + ` the cause is fixed, retry and the breaker resets on the first successful startup.`
      + `${retryAfterMs > 0 ? ` Autostart will retry in ${Math.max(1, Math.round(retryAfterMs / 1000))}s unless reset.` : ""}`
    );
    this.name = "DaemonAutostartCircuitOpenError";
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.consecutiveFailures = consecutiveFailures;
    this.retryAfterMs = retryAfterMs;
    this.socketPath = socketPath;
  }
}

export function spawnDetachedDaemonAutostart(
  input: DetachedDaemonAutostartInput
): SpawnedDaemonAutostartProcess {
  const launchStderrPath = daemonAutostartLaunchStderrPath(input.userRoot);
  const launchStderrFd = openSync(launchStderrPath, "a", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(input.execPath, [...input.argv], {
      detached: true,
      stdio: ["ignore", "ignore", launchStderrFd],
      env: input.env
    });
  } finally {
    closeSync(launchStderrFd);
  }
  child.unref();
  return { pid: child.pid, launchStderrPath };
}

export function daemonAutostartFailureError(
  timeoutMs: number,
  lastError: unknown,
  spawnedPid?: number,
  launchStderrPath?: string
): Error {
  return daemonAutostartProcessExitedError(lastError, spawnedPid, launchStderrPath)
    ?? new DaemonAutostartTimeoutError(timeoutMs, lastError, spawnedPid);
}

export function daemonAutostartProcessExitedError(
  lastError: unknown,
  spawnedPid?: number,
  launchStderrPath?: string
): DaemonAutostartProcessExitedError | undefined {
  return spawnedPid !== undefined && !daemonProcessIsAlive(spawnedPid)
    ? new DaemonAutostartProcessExitedError(lastError, spawnedPid, launchStderrPath)
    : undefined;
}

function daemonAutostartLaunchStderrPath(userRoot: string): string {
  const directory = path.join(path.resolve(userRoot), "logs", "daemon-startup");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(
    directory,
    `launch-${Date.now()}-autostart-${randomBytes(6).toString("hex")}.stderr.log`
  );
}

export function daemonProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return processErrorCode(error) !== "ESRCH";
  }
}

function daemonLaunchStderrFailure(launchStderrPath: string): string | undefined {
  const buffer = Buffer.alloc(64 * 1024);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(launchStderrPath, "r");
    const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u);
    const namespaceFailure = lines.find((line) => line.includes("DAEMON_SOCKET_NAMESPACE_INVALID:"));
    if (namespaceFailure) return namespaceFailure.slice(namespaceFailure.indexOf("DAEMON_SOCKET_NAMESPACE_INVALID:"));
    return lines.find((line) => /^[A-Za-z]*Error:\s+\S/u.test(line))?.trim()
      ?? lines.find((line) => line.trim().length > 0)?.trim();
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error ?? fallback);
}

function processErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}
