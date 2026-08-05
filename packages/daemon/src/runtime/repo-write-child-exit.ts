import type { ChildProcess } from "node:child_process";

export function terminateRepoWriteChildAndWait(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("repo writer child exit timeout must be a positive safe integer"));
  }
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => {
      finish(new Error(
        `Repo writer child pid ${child.pid ?? "unknown"} did not exit after ${signal}.`
      ));
    }, timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    try {
      child.kill(signal);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
