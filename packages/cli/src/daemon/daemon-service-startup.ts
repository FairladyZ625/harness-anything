import { type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readDaemonSocketOwner } from "@harness-anything/daemon";
import { parsePositiveIntegerOr } from "../cli/value-utils.ts";
import { readDaemonStatusWithGenerationFallback } from "../commands/daemon/status-compatibility.ts";
import { requestLocalDaemonJsonRpc, type LocalDaemonTarget } from "./client.ts";

const defaultDaemonServiceStartupTimeoutMs = 20_000;
const maxDaemonServiceStartupTimeoutMs = 120_000;
const daemonLaunchLogLimitBytes = 64 * 1024;

interface DaemonChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

export interface BoundedLaunchStderr {
  readonly append: (chunk: Buffer | string) => void;
  readonly flush: (reason: string) => void;
  readonly discard: () => void;
}

export interface DaemonServiceLaunch {
  readonly child: ChildProcess;
  readonly launchLogPath: string;
  readonly stderr: BoundedLaunchStderr;
  readonly exit: Promise<DaemonChildExit>;
  readonly state: { value?: DaemonChildExit };
}

export class DaemonServiceStartupError extends Error {
  readonly diagnostic: {
    readonly childExitCode: number | null;
    readonly childSignal: NodeJS.Signals | null;
    readonly launchLogPath: string;
  };

  constructor(message: string, diagnostic: DaemonServiceStartupError["diagnostic"]) {
    super(
      `${message}; child exit code=${String(diagnostic.childExitCode)}`
      + `${diagnostic.childSignal ? `; child signal=${diagnostic.childSignal}` : ""}`
      + `; launch log: ${diagnostic.launchLogPath}`
    );
    this.name = "DaemonServiceStartupError";
    this.diagnostic = diagnostic;
  }
}

class DaemonServiceStartupTimeoutError extends Error {
  constructor() {
    super("daemon service did not become reachable before timeout");
    this.name = "DaemonServiceStartupTimeoutError";
  }
}

class DaemonServiceChildExitBeforeReadinessError extends Error {
  constructor() {
    super("daemon service child exited before becoming reachable");
    this.name = "DaemonServiceChildExitBeforeReadinessError";
  }
}

export async function readReachableDaemonStatus(
  target: LocalDaemonTarget,
  includeGenerationAxes = false
): Promise<Record<string, unknown> | undefined> {
  return readDaemonStatusWithGenerationFallback(includeGenerationAxes, (includeAxes) =>
    requestLocalDaemonJsonRpc(target.canonicalRoot, "repo.daemon.status", {
      repo: { repoId: target.repoId },
      ...(includeAxes ? { includeGenerationAxes: true } : {})
    }, 1_000, {
      userRoot: target.userRoot,
      daemonId: target.daemonId,
      socketPath: target.socketPath,
      allowLegacySocket: true
    })
  );
}

export async function waitForReachableStatus(
  target: LocalDaemonTarget,
  timeoutMs: number,
  launch?: DaemonServiceLaunch
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (launch?.state.value) throw new DaemonServiceChildExitBeforeReadinessError();
    const status = await readReachableDaemonStatus(target);
    if (status) return status;
    if (launch?.state.value) throw new DaemonServiceChildExitBeforeReadinessError();
    await waitDaemonPollInterval(100);
  }
  throw new DaemonServiceStartupTimeoutError();
}

export function daemonServiceStartupTimeoutMs(): number {
  return Math.min(
    maxDaemonServiceStartupTimeoutMs,
    parsePositiveIntegerOr(
      process.env.HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS,
      defaultDaemonServiceStartupTimeoutMs
    )
  );
}

export function observeDaemonServiceLaunch(child: ChildProcess, userRoot: string): DaemonServiceLaunch {
  const state: { value?: DaemonChildExit } = {};
  const launchLogPath = path.join(
    path.resolve(userRoot),
    "logs",
    "daemon-startup",
    `launch-${Date.now()}-${child.pid ?? "unknown"}-${randomBytes(6).toString("hex")}.stderr.log`
  );
  const stderr = boundedLaunchStderr(launchLogPath, child.pid);
  child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
  const unref = (child.stderr as (NodeJS.ReadableStream & { readonly unref?: () => void }) | null)?.unref;
  unref?.call(child.stderr);
  child.unref();
  let resolveExit!: (exit: DaemonChildExit) => void;
  let settled = false;
  const exit = new Promise<DaemonChildExit>((resolve) => {
    resolveExit = resolve;
  });
  const settle = (value: DaemonChildExit): void => {
    if (settled) return;
    settled = true;
    state.value = value;
    resolveExit(value);
  };
  child.once("error", (error) => settle({ code: null, signal: null, error: error.message }));
  child.once("close", (code, signal) => settle({ code, signal }));
  return { child, launchLogPath, stderr, exit, state };
}

function boundedLaunchStderr(launchLogPath: string, pid: number | undefined): BoundedLaunchStderr {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let truncated = false;
  let accepting = true;
  return {
    append: (chunk) => {
      if (!accepting) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (byteLength >= daemonLaunchLogLimitBytes) {
        truncated = true;
        return;
      }
      const remaining = daemonLaunchLogLimitBytes - byteLength;
      const bounded = bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining);
      chunks.push(bounded);
      byteLength += bounded.byteLength;
      if (bounded.byteLength !== bytes.byteLength) truncated = true;
    },
    flush: (reason) => {
      accepting = false;
      mkdirSync(path.dirname(launchLogPath), { recursive: true, mode: 0o700 });
      const header = Buffer.from([
        "schema=daemon-launch-stderr/v1",
        `pid=${pid === undefined ? "unknown" : String(pid)}`,
        `reason=${reason}`,
        "",
        ""
      ].join("\n"), "utf8");
      const suffix = truncated
        ? Buffer.from("\n[stderr truncated at 65536 bytes]\n", "utf8")
        : Buffer.alloc(0);
      writeFileSync(launchLogPath, Buffer.concat([header, ...chunks, suffix]), { mode: 0o600 });
    },
    discard: () => {
      accepting = false;
      chunks.length = 0;
    }
  };
}

export async function diagnoseDaemonServiceLaunchFailure(
  target: LocalDaemonTarget,
  launch: DaemonServiceLaunch,
  error: unknown
): Promise<DaemonServiceStartupError> {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut = error instanceof DaemonServiceStartupTimeoutError;
  if (!launch.state.value) await stopDaemonServiceLaunch(launch);
  const exit = launch.state.value ?? await waitForDaemonChildExit(launch, 1_000);
  let cleanupFailure: string | undefined;
  try {
    await waitForLaunchedEndpointStopped(target, launch.child.pid);
  } catch (cleanupError) {
    cleanupFailure = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  }
  launch.stderr.flush(timedOut ? "startup timeout" : "child exited before readiness");
  const childError = exit?.error ? `; child error=${exit.error}` : "";
  const cleanupDiagnostic = cleanupFailure ? `; cleanup=${cleanupFailure}` : "";
  const diagnostic = {
    childExitCode: exit?.code ?? null,
    childSignal: exit?.signal ?? null,
    launchLogPath: launch.launchLogPath
  } as const;
  return new DaemonServiceStartupError(`${message}${childError}${cleanupDiagnostic}`, diagnostic);
}

async function stopDaemonServiceLaunch(launch: DaemonServiceLaunch): Promise<void> {
  if (launch.state.value || launch.child.pid === undefined) return;
  signalDaemonServiceProcess(launch, "SIGTERM");
  if (await waitForDaemonChildExit(launch, 5_000)) return;
  signalDaemonServiceProcess(launch, "SIGKILL");
  await waitForDaemonChildExit(launch, 2_000);
}

async function waitForLaunchedEndpointStopped(
  target: LocalDaemonTarget,
  launchedPid: number | undefined
): Promise<void> {
  if (launchedPid === undefined) return;
  const owner = readDaemonSocketOwner(target.socketPath);
  if (owner?.pid !== launchedPid) return;
  if (!await waitForEndpointStopped(target, 5_000)) {
    throw new Error(`daemon service child pid ${launchedPid} exited but its endpoint remained reachable`);
  }
}

async function waitForDaemonChildExit(
  launch: DaemonServiceLaunch,
  timeoutMs: number
): Promise<DaemonChildExit | undefined> {
  if (launch.state.value) return launch.state.value;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    launch.exit.then((exit) => {
      clearTimeout(timer);
      resolve(exit);
    });
  });
}

function signalDaemonServiceProcess(launch: DaemonServiceLaunch, signal: NodeJS.Signals): void {
  const pid = launch.child.pid;
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if (processErrorCode(error) === "ESRCH") return;
    }
  }
  try {
    launch.child.kill(signal);
  } catch (error) {
    if (processErrorCode(error) !== "ESRCH") throw error;
  }
}

export async function waitForEndpointStopped(target: LocalDaemonTarget, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!await readReachableDaemonStatus(target)) return true;
    await waitDaemonPollInterval(100);
  }
  return !await readReachableDaemonStatus(target);
}

function waitDaemonPollInterval(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processErrorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}
