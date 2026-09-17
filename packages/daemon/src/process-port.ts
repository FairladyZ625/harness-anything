import {
  execFile,
  /* @gate-identity check-sync-subprocess/sync-subprocess-008 */
  execFileSync,
  spawn,
} from "node:child_process";
import { closeDaemonOutputFd, openDaemonOutputFd } from "./lifecycle-log.ts";

/** POSIX terminal fallback declared at the process-capability boundary. */
export const posixShellFallback = "/bin/sh";

export const detachedProcessOptions = Object.freeze({ detached: true, stdio: "ignore" as const, windowsHide: true });
export function startDetachedProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  outputPath?: string,
  cwd?: string,
): void {
  const outputFd = outputPath ? openDaemonOutputFd(outputPath) : null;
  try {
    const child = spawn(command, [...args], {
      ...detachedProcessOptions,
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
export function runProcessText(
  command: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
): string {
  return (
    /* @gate-identity check-sync-subprocess/sync-subprocess-009 */
    execFileSync(command, [...args], {
      cwd,
      ...(env ? { env } : {}),
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  );
}
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

function launchProcessText(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
  input: string | undefined,
  signal: AbortSignal | undefined,
  options: {
    readonly timeoutMs?: number;
    readonly windowsVerbatimArguments?: boolean;
  },
): Promise<ProcessTextOutcome> {
  return new Promise((resolve) => {
    // execFile's own AbortSignal handling fires the callback as soon as the signal aborts,
    // while SIGTERM is still in flight — settling then would release the caller (and any
    // queue slot it holds) before the child has actually exited. Settle only once the child
    // has closed so "cancelled" always means "the process is gone".
    const child = execFile(
      command,
      [...args],
      {
        cwd,
        ...(env ? { env } : {}),
        ...(signal ? { signal } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        ...(options.windowsVerbatimArguments === undefined
          ? {}
          : { windowsVerbatimArguments: options.windowsVerbatimArguments }),
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
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
          child.once("close", settle);
          return;
        }
        settle();
      },
    );
    child.stdin?.end(input);
  });
}

export function runProcessTextAsync(
  command: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  input?: string,
  signal?: AbortSignal,
  options: {
    readonly timeoutMs?: number;
    readonly windowsVerbatimArguments?: boolean;
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
    readonly windowsVerbatimArguments?: boolean;
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
