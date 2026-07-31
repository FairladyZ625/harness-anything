import { execFileSync } from "node:child_process";

const DEFAULT_CHILD_EXIT_TIMEOUT_MS = 5_000;

export function waitForChildExit(child, options = {}) {
  return observeChildExit(child, undefined, options);
}

export function terminateChildAndWait(child, terminate, options = {}) {
  if (typeof terminate !== "function") throw new Error("terminateChildAndWait requires a termination function");
  return observeChildExit(child, terminate, options);
}

export function forceTerminateChildAndWait(child, options = {}) {
  const timeoutMs = positiveTimeout(options.timeoutMs);
  return terminateChildAndWait(child, (target) => {
    if (process.platform === "win32") {
      if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
        throw new Error(`${options.label ?? "child process"} has no process id`);
      }
      try {
        execFileSync("taskkill.exe", ["/pid", String(target.pid), "/t", "/f"], {
          stdio: "ignore",
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          windowsHide: true
        });
      } catch {
        // The child may have exited after the pre-termination state check.
        // The already-installed observer below decides that race or times out.
      }
      return;
    }
    target.kill("SIGKILL");
  }, { ...options, timeoutMs });
}

function observeChildExit(child, terminate, options) {
  const timeoutMs = positiveTimeout(options.timeoutMs);
  const label = options.label ?? `child process ${child.pid ?? "unknown"}`;
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(result);
    };
    const onExit = (code, signal) => finish(undefined, { code, signal });
    const onError = (error) => finish(error);
    const timer = setTimeout(() => {
      finish(new Error(`${label} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);

    if (child.exitCode !== null || child.signalCode !== null) {
      finish(undefined, { code: child.exitCode, signal: child.signalCode });
      return;
    }
    if (terminate !== undefined) {
      try {
        terminate(child);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}

function positiveTimeout(value) {
  const timeoutMs = value ?? DEFAULT_CHILD_EXIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("child exit timeout must be a positive integer");
  }
  return timeoutMs;
}
