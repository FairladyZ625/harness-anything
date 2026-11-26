/**
 * Cross-platform (POSIX + Windows) process-tree runner with hard deadline kill
 * and stdout/stderr byte-cap protection.
 *
 * Implements dec_D8EECF29C93D0C300252060A10/CH2:
 * - POSIX: spawns child as session/process-group leader (`detached: true`) and kills
 *   the whole group via `process.kill(-pid, "SIGTERM")` -> `SIGKILL`.
 * - Windows: spawns with `windowsHide: true` and kills the entire process tree via
 *   `taskkill /PID <pid> /T /F`.
 * - Deadline / byte-cap locks the result immediately so closing pipes during cleanup
 *   can never turn a timed-out or overflowed child into a valid success.
 */
import { execFile, execFileSync, spawn as startChildProcess } from "node:child_process";
import process from "node:process";

export const DEFAULT_CASE_WAIT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const TERM_SETTLE_MS = 150;
const MAX_TIMER_MS = 2 ** 31 - 1;
const TASKKILL_NOT_FOUND_CODE = 128;

const activePidRegistry = {};
let hooksInstalled = false;

function registerActivePid(pid, platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  activePidRegistry[String(pid)] = platform;
  if (!hooksInstalled) {
    hooksInstalled = true;
    process.once("exit", () => {
      for (const [key, plat] of Object.entries(activePidRegistry)) {
        const numericPid = Number(key);
        Reflect.deleteProperty(activePidRegistry, key);
        try {
          killProcessTreeSync(numericPid, { platform: plat });
        } catch {
          // Best-effort process-exit cleanup; process is already terminating.
          return;
        }
      }
    });
  }
}

function unregisterActivePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  Reflect.deleteProperty(activePidRegistry, String(pid));
}

/** Probe whether a PID currently exists (returns true if alive or EPERM, false on ESRCH). */
export function probeProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function sendPosixGroupSignal(pid, signal, killFn) {
  try {
    killFn(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

/** Synchronous whole-tree kill for process exit hooks. */
export function killProcessTreeSync(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { ok: false, killed: false, method: "none" };
  }
  const platform = options.platform ?? process.platform;
  const killFn = options.killFn ?? process.kill;
  if (platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      return { ok: true, killed: true, method: "taskkill" };
    } catch (error) {
      if (error?.status === TASKKILL_NOT_FOUND_CODE || error?.code === "ESRCH") {
        return { ok: true, killed: false, method: "taskkill" };
      }
      return {
        ok: false,
        killed: false,
        method: "taskkill",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const signaled = sendPosixGroupSignal(pid, "SIGKILL", killFn);
  return { ok: true, killed: signaled, method: "posix-group" };
}

/**
 * Asynchronous cross-platform process-tree kill.
 * On Windows runs `taskkill /PID <pid> /T /F`; on POSIX sends SIGTERM to `-pid`
 * and escalates to SIGKILL after `settleMs` if the process group is still alive.
 */
export function killProcessTree(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve({ ok: false, killed: false, method: "none" });
  }
  const platform = options.platform ?? process.platform;
  const settleMs = options.settleMs ?? TERM_SETTLE_MS;
  const killFn = options.killFn ?? process.kill;
  const execFileFn = options.execFileFn ?? execFile;

  if (platform === "win32") {
    return new Promise((resolve) => {
      execFileFn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, killed: true, method: "taskkill", stdout: String(stdout ?? "").trim() });
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : null;
        if (exitCode === TASKKILL_NOT_FOUND_CODE) {
          resolve({ ok: true, killed: false, method: "taskkill", detail: String(stderr ?? "").trim() });
          return;
        }
        // Fallback: try direct PID kill if taskkill itself returned an unexpected error.
        let fallbackKilled = false;
        try {
          killFn(pid, "SIGKILL");
          fallbackKilled = true;
        } catch (fallbackErr) {
          if (fallbackErr?.code !== "ESRCH") {
            resolve({
              ok: false,
              killed: false,
              method: "taskkill",
              error: `${error.message}; fallback: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
            });
            return;
          }
        }
        resolve({
          ok: true,
          killed: fallbackKilled,
          method: fallbackKilled ? "win32-direct-fallback" : "taskkill",
          detail: String(stderr ?? error.message).trim(),
        });
      });
    });
  }

  return new Promise((resolve, reject) => {
    let sentTerm;
    try {
      sentTerm = sendPosixGroupSignal(pid, "SIGTERM", killFn);
    } catch (error) {
      reject(error);
      return;
    }
    if (!sentTerm) {
      resolve({ ok: true, killed: false, method: "posix-group" });
      return;
    }
    const timer = setTimeout(() => {
      try {
        const sentKill = sendPosixGroupSignal(pid, "SIGKILL", killFn);
        resolve({ ok: true, killed: true, escalatedToSigkill: sentKill, method: "posix-group" });
      } catch (error) {
        reject(error);
      }
    }, settleMs);
    timer.unref?.();
  });
}

function buildShellSpec(command, platform) {
  if (platform === "win32") {
    const comSpec = process.env.ComSpec || "cmd.exe";
    // `cmd.exe /s /c` strips the outer pair of quotes; passing `windowsVerbatimArguments: true`
    // preserves inner quotes around paths with spaces (e.g. "C:\Program Files\nodejs\node.exe").
    return {
      executable: comSpec,
      args: ["/d", "/s", "/c", `"${command}"`],
      detached: false,
      windowsVerbatimArguments: true,
    };
  }
  return { executable: "/bin/sh", args: ["-c", command], detached: true, windowsVerbatimArguments: false };
}

/**
 * Execute a shell command string (or explicit `{ executable, args }`) with stdin payload,
 * strict wall-clock wait bound, output byte ceiling, and guaranteed whole-tree cleanup.
 */
export function execIsolatedCommand(options) {
  const {
    command,
    executable,
    args = [],
    stdinText = "",
    cwd = process.cwd(),
    env = process.env,
    waitMs = DEFAULT_CASE_WAIT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    settleMs = TERM_SETTLE_MS,
    platform = process.platform,
    killFn,
    execFileFn,
  } = options ?? {};

  if (!Number.isSafeInteger(waitMs) || waitMs <= 0 || waitMs > MAX_TIMER_MS) {
    return Promise.reject(
      new RangeError(`waitMs must be a positive integer <= ${MAX_TIMER_MS} (got ${String(waitMs)})`),
    );
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new RangeError(`maxOutputBytes must be a positive integer (got ${String(maxOutputBytes)})`));
  }

  const launchSpec =
    typeof executable === "string" && executable.length > 0
      ? {
          executable,
          args: Array.isArray(args) ? args : [],
          detached: platform !== "win32",
          windowsVerbatimArguments: false,
        }
      : typeof command === "string" && command.trim().length > 0
        ? buildShellSpec(command, platform)
        : null;

  if (!launchSpec) {
    return Promise.reject(new TypeError("execIsolatedCommand requires a non-empty command or executable"));
  }

  return new Promise((resolve) => {
    const startedAt = performance.now();
    const elapsedMs = () => Math.round(performance.now() - startedAt);

    let child;
    try {
      child = startChildProcess(launchSpec.executable, launchSpec.args, {
        cwd,
        env,
        detached: launchSpec.detached,
        windowsHide: platform === "win32",
        windowsVerbatimArguments: launchSpec.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (spawnError) {
      resolve({
        status: "errored",
        error: spawnError instanceof Error ? spawnError.message : String(spawnError),
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        latencyMs: elapsedMs(),
        pid: null,
        killMethod: null,
      });
      return;
    }

    const childPid = child.pid ?? null;
    if (childPid !== null) registerActivePid(childPid, platform);

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lockedResult = null;
    let settled = false;
    let stdinError = null;

    function finalize(result) {
      if (settled) return;
      settled = true;
      clearTimeout(waitTimer);
      if (childPid !== null) unregisterActivePid(childPid);
      resolve(result);
    }

    function stopWithLock(status, errorMessage) {
      if (lockedResult) return;
      lockedResult = {
        status,
        error: errorMessage,
        stdout: "",
        stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
        exitCode: null,
        signal: null,
        latencyMs: elapsedMs(),
        pid: childPid,
        killMethod: null,
      };
      clearTimeout(waitTimer);
      const pidToKill = childPid;
      killProcessTree(pidToKill, { platform, settleMs, killFn, execFileFn })
        .then((killOutcome) => {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref?.();
          finalize({ ...lockedResult, killMethod: killOutcome.method });
        })
        .catch((killErr) => {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref?.();
          finalize({
            ...lockedResult,
            error: `${errorMessage}; tree kill failed: ${killErr instanceof Error ? killErr.message : String(killErr)}`,
          });
        });
    }

    const onWaitElapsed = () => stopWithLock("timedOut", `timed out after ${waitMs}ms`);
    const waitTimer = setTimeout(onWaitElapsed, waitMs);

    child.stdout.on("data", (chunk) => {
      if (lockedResult) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        stopWithLock("errored", `process stdout exceeded ${maxOutputBytes} bytes`);
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      if (lockedResult) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        stopWithLock("errored", `process stderr exceeded ${maxOutputBytes} bytes`);
        return;
      }
      stderrChunks.push(chunk);
    });

    child.stdin.on("error", (error) => {
      // EPIPE can happen if child exits before reading stdin; only surface if exit failed.
      if (error?.code !== "EPIPE") {
        stdinError = error.message;
      }
    });

    child.once("error", (error) => {
      if (!lockedResult) {
        finalize({
          status: "errored",
          error: error instanceof Error ? error.message : String(error),
          stdout: "",
          stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
          exitCode: null,
          signal: null,
          latencyMs: elapsedMs(),
          pid: childPid,
          killMethod: null,
        });
      }
    });

    child.once("close", (code, signal) => {
      if (lockedResult) return;
      const latencyMs = elapsedMs();
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0 || stdinError) {
        finalize({
          status: "errored",
          error: stderrText || stdinError || `process exited with ${signal ?? code}`,
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: code,
          signal,
          latencyMs,
          pid: childPid,
          killMethod: null,
        });
        return;
      }
      finalize({
        status: "ok",
        error: null,
        stdout: stdoutText,
        stderr: stderrText,
        exitCode: 0,
        signal: null,
        latencyMs,
        pid: childPid,
        killMethod: null,
      });
    });

    child.stdin.end(stdinText);
  });
}
