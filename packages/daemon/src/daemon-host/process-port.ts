import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { cmdShellInvocation } from "@harness-anything/storage/cmd-command-line";
import { runProcessText } from "../runtime-engine/process-text.ts";
import { statSync } from "node:fs";
import { execFile, spawn, type ChildProcess, type ExecFileException } from "node:child_process";
import { terminateRuntimePid } from "../runtime-engine/runtime-process-signals.ts";
import { closeDaemonOutputFd, openDaemonOutputFd } from "./lifecycle-log.ts";
import { classifyRemoteGitInvocation, writePortExternalObservation } from "./write-port-external-observation.ts";

/** POSIX terminal fallback declared at the process-capability boundary. */
export const posixShellFallback = "/bin/sh";

export const detachedProcessOptions = Object.freeze({ detached: true, stdio: "ignore" as const, windowsHide: true });
// The child is returned (not awaited) because fire-and-forget callers such as the `ha gui`
// launcher read its pid synchronously to fill their launch receipt.
export function startDetachedProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  outputPath?: string,
  cwd?: string,
  windowsHide: boolean = detachedProcessOptions.windowsHide,
): ChildProcess {
  const outputFd = outputPath ? openDaemonOutputFd(outputPath) : null;
  try {
    const child = spawn(command, [...args], {
      ...detachedProcessOptions,
      windowsHide,
      ...(outputFd === null ? {} : { stdio: ["ignore", outputFd, outputFd] }),
      ...(cwd ? { cwd } : {}),
      env,
    });
    child.once("spawn", () => {
      if (outputFd !== null) closeDaemonOutputFd(outputFd);
    });
    child.once("error", () => {
      if (outputFd !== null) closeDaemonOutputFd(outputFd);
    });
    child.unref();
    return child;
  } catch (error) {
    if (outputFd !== null) closeDaemonOutputFd(outputFd);
    throw error;
  }
}
// Fire-and-forget spawn cannot tell the caller why the child never came up; this
// variant resolves once the process exists and rejects with the OS error (ENOENT,
// EACCES, ...) so autostart callers can classify launcher-level failures.
export function startDetachedProcessChecked(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  outputPath?: string,
  cwd?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const outputFd = outputPath ? openDaemonOutputFd(outputPath) : null;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        ...detachedProcessOptions,
        ...(outputFd === null ? {} : { stdio: ["ignore", outputFd, outputFd] }),
        ...(cwd ? { cwd } : {}),
        env,
      });
    } catch (error) {
      if (outputFd !== null) closeDaemonOutputFd(outputFd);
      throw error;
    }
    const closeParentFd = () => {
      if (outputFd !== null) closeDaemonOutputFd(outputFd);
    };
    const onSpawn = () => {
      child.removeListener("error", onError);
      closeParentFd();
      child.unref();
      resolve();
    };
    const onError = (error: Error) => {
      closeParentFd();
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}
export function terminateProcess(pid: number): void {
  process.kill(pid, "SIGTERM");
}
// Long synchronous stretches (workspace replay, batch migration) cannot run
// signal handlers; yielding one macrotask turn between bounded segments lets a
// pending SIGTERM reach its handler at the next safe point.
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
export { runProcessText } from "../runtime-engine/process-text.ts";
interface ProcessTextOutcome {
  readonly error:
    | (Error & {
        code?: number | string | null;
        status?: number;
        killed?: boolean;
        signal?: string | null;
        stdout: string;
        stderr: string;
      })
    | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A bounded command may need a protocol exchange before its stdin can close. */
export type ProcessInput = string | ((child: ChildProcess) => Promise<void>);

function launchProcessText(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
  input: ProcessInput | undefined,
  signal: AbortSignal | undefined,
  options: {
    readonly timeoutMs?: number;
    readonly timeoutSignal?: "SIGTERM" | "SIGKILL";
    readonly windowsVerbatimArguments?: boolean;
    readonly maxBuffer?: number;
  },
): Promise<ProcessTextOutcome> {
  if (writePortExternalObservation.currentDepth() > 0 && classifyRemoteGitInvocation(command, args, cwd))
    writePortExternalObservation.noteRemoteChildProcess();
  return new Promise((resolve) => {
    let interactionError: Error | null = null;
    let timedOut = false;
    const childRef: { current?: ChildProcess } = {};
    const isWin32 = process.platform === "win32",
      timeoutSignal = options.timeoutSignal ?? "SIGTERM",
      useWindowsTreeTimeout = isWin32 && options.timeoutMs !== undefined,
      treeKillEnabled = isWin32 || options.timeoutMs !== undefined,
      invocation =
        isWin32 && /\.(?:cmd|bat)$/iu.test(command) ? cmdShellInvocation(command, args, env ?? process.env) : null,
      executable = invocation?.command ?? command,
      executableArgs = invocation?.args ?? [...args],
      windowsVerbatimArguments = invocation?.windowsVerbatimArguments ?? options.windowsVerbatimArguments;
    // Register before execFile so EventTarget runs our tree kill before Node's abort handler
    // terminates cmd.exe alone (which would orphan .cmd grandchildren holding stdio pipes open).
    const onAbort = () => {
      const current = childRef.current;
      if (current?.pid === undefined || current.exitCode !== null || current.signalCode !== null) return;
      if (treeKillEnabled) terminateRuntimePid(current.pid, timeoutSignal);
    };
    if (signal && !signal.aborted) signal.addEventListener("abort", onAbort, { once: true });
    // execFile's own AbortSignal handling fires the callback as soon as the signal aborts,
    // while SIGTERM is still in flight — settling then would release the caller (and any
    // queue slot it holds) before the child has actually exited. Settle only once the child
    // has closed so "cancelled" always means "the process is gone".
    const child = execFile(
      executable,
      executableArgs,
      {
        cwd,
        ...(env ? { env } : {}),
        ...(signal ? { signal } : {}),
        ...(options.timeoutMs === undefined || useWindowsTreeTimeout
          ? {}
          : { timeout: options.timeoutMs, killSignal: timeoutSignal }),
        ...(windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments }),
        ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
        // Provider commands may launch helpers that inherit stdout/stderr. Put the
        // process in its own group so a timeout can terminate the whole tree and
        // release the pipe on which the caller waits for `close`.
        ...(options.timeoutMs === undefined || process.platform === "win32" ? {} : { detached: true }),
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (timedOut && !interactionError) {
          if (!error)
            error = new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`) as ExecFileException;
          error.killed = true;
          error.signal = error.signal ?? timeoutSignal;
        }
        error = interactionError ?? error;
        const cleanup = () => {
          if (timeout !== null) clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
        };
        const settle = () =>
          resolve({
            error: error
              ? Object.assign(error, {
                  stdout,
                  stderr,
                  ...(typeof error.code === "number" ? { status: error.code } : {}),
                })
              : null,
            stdout,
            stderr,
          });
        if (error && child.exitCode === null && child.signalCode === null) {
          child.once("close", () => {
            cleanup();
            settle();
          });
          return;
        }
        cleanup();
        settle();
      },
    );
    childRef.current = child;
    const timeout =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            if (useWindowsTreeTimeout) timedOut = true;
            if (child.pid === undefined) return;
            terminateRuntimePid(child.pid, timeoutSignal);
          }, options.timeoutMs);
    timeout?.unref();
    if (typeof input === "function")
      void Promise.resolve()
        .then(() => input(child))
        .then(
          () => child.stdin?.end(),
          (error: unknown) => {
            interactionError = error instanceof Error ? error : new Error(String(error));
            if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
              // Kill the process tree first on Windows so cmd.exe cannot exit before taskkill walks it.
              if (treeKillEnabled) terminateRuntimePid(child.pid);
              // An opening callback can fail before the child has established its group.
              child.kill("SIGTERM");
            }
          },
        );
    else child.stdin?.end(input);
  });
}

export function runProcessTextAsync(
  command: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  input?: ProcessInput,
  signal?: AbortSignal,
  options: {
    readonly timeoutMs?: number;
    readonly windowsVerbatimArguments?: boolean;
    readonly maxBuffer?: number;
  } = {},
): Promise<string> {
  return launchProcessText(command, args, cwd, env, input, signal, options).then((outcome) => {
    if (outcome.error) throw outcome.error;
    return outcome.stdout;
  });
}

export interface ProcessExitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The verdict-carrying variant of runProcessTextAsync: a child that exits normally — whatever the
 * code — resolves with it. Spawn failure, signal, timeout, and abort produce no verdict and
 * still reject.
 */
export function runProcessExitAsync(
  command: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  input?: string,
  signal?: AbortSignal,
  options: {
    readonly timeoutMs?: number;
    readonly timeoutSignal?: "SIGTERM" | "SIGKILL";
    readonly windowsVerbatimArguments?: boolean;
    readonly maxBuffer?: number;
  } = {},
): Promise<ProcessExitResult> {
  return launchProcessText(command, args, cwd, env, input, signal, options).then((outcome) => {
    const error = outcome.error;
    // A child that handles the timeout/abort kill signal and exits itself still reports a
    // numeric error.code; killed/signal are what separate a real verdict from a termination.
    if (error && (typeof error.code !== "number" || error.killed === true || error.signal != null)) throw error;
    return {
      exitCode: typeof error?.code === "number" ? error.code : 0,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    };
  });
}
export function makeGitReadinessSource() {
  return {
    run: (rootDir: string, args: readonly string[], allowNoMatch = false) => {
      try {
        return { ok: true, stdout: runProcessText("git", args, rootDir).trim() };
      } catch (error) {
        const status = typeof error === "object" && error && "status" in error ? Number(error.status) : null;
        return { ok: allowNoMatch && status === 1, stdout: "" };
      }
    },
  };
}

export type GitHistoryLogResult =
  | { readonly ok: true; readonly stdout: string }
  | {
      readonly ok: false;
      /** Process exit status; null when git never ran or was killed (see errorCode). */
      readonly exitCode: number | null;
      /** System error code such as ENOENT or ETIMEDOUT; null for an ordinary non-zero exit. */
      readonly errorCode: string | null;
      readonly stderr: string;
    };

export type AsyncGitHistoryLogRunner = (
  rootDir: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<GitHistoryLogResult>;

const GIT_HISTORY_STDERR_BYTES = 512;

function boundedGitHistoryStderr(stderr: unknown): string {
  return Buffer.from(String(stderr ?? "").trim(), "utf8")
    .subarray(0, GIT_HISTORY_STDERR_BYTES)
    .toString("utf8");
}

/**
 * Read-only Git history and status for reverse code-path trace (dec_9979850C7CE87C17271D78E4D1 CH1). Unlike
 * makeGitReadinessSource it keeps the exit status, system error code and a bounded stderr digest, so
 * callers can tell "no history" from "git failed". Host read and dispatch entries only; the writer
 * plane never imports this module.
 */
export function runGitHistoryLog(
  rootDir: string,
  args: readonly string[],
  timeoutMs: number = daemonRuntimePolicy.defaultValue.runtime.currentWorktreeHeadTimeoutMs,
): GitHistoryLogResult {
  try {
    return {
      ok: true,
      stdout: runProcessText("git", args, rootDir, { ...process.env, LC_ALL: "C" }, timeoutMs),
    };
  } catch (error) {
    const failure = (typeof error === "object" && error !== null ? error : {}) as {
      readonly status?: unknown;
      readonly code?: unknown;
      readonly stderr?: unknown;
    };
    return {
      ok: false,
      exitCode: typeof failure.status === "number" ? failure.status : null,
      errorCode: typeof failure.code === "string" ? failure.code : null,
      stderr: boundedGitHistoryStderr(failure.stderr),
    };
  }
}

/**
 * Asynchronous read-only Git history and status runner for pre-queue dispatch collection
 * (dec_9979850C7CE87C17271D78E4D1 CH1): preserves exit status, system error code, and bounded
 * stderr without blocking the daemon event loop or the RepoCell single-writer slot.
 */
export async function runGitHistoryLogAsync(
  rootDir: string,
  args: readonly string[],
  timeoutMs: number = daemonRuntimePolicy.defaultValue.runtime.currentWorktreeHeadTimeoutMs,
): Promise<GitHistoryLogResult> {
  const outcome = await launchProcessText("git", args, rootDir, { ...process.env, LC_ALL: "C" }, undefined, undefined, {
    timeoutMs,
  });
  if (!outcome.error) return { ok: true, stdout: outcome.stdout };
  const error = outcome.error,
    terminated = error.killed === true || error.signal != null,
    exitCode = !terminated && typeof error.status === "number" ? error.status : null,
    errorCode =
      typeof error.code === "string"
        ? error.code
        : terminated
          ? typeof error.signal === "string"
            ? error.signal
            : "ETIMEDOUT"
          : null;
  return {
    ok: false,
    exitCode,
    errorCode,
    stderr: boundedGitHistoryStderr(outcome.stderr || error.stderr),
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
    return code === "EPERM";
  }
}

/** ESRCH proves death; only Windows also checks creation time against the lock's write time.
 * Query failures propagate to the caller and cannot authorize lock recovery. */
export function processLockHolderDead(lockPath: string, pid: number): boolean {
  if (!processExists(pid)) return true;
  if (process.platform !== "win32") return false;
  const output = runProcessText(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'; (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
    ],
    undefined,
    undefined,
    daemonRuntimePolicy.defaultValue.process.lockHolderProbeTimeoutMs,
  ).trim();
  if (!/^[0-9]+$/u.test(output) || BigInt(output) <= 0n)
    throw new Error(`Cannot determine Windows process creation time for PID ${pid}`);
  // Round down to milliseconds: insufficient precision must retain the incumbent.
  const startedAtMs = Number(BigInt(output) / 10_000n - 11_644_473_600_000n);
  return startedAtMs > statSync(lockPath).mtimeMs;
}
