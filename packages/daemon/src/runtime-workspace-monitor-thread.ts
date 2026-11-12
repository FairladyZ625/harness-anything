import { Worker } from "node:worker_threads";
import { runtimeErrorCode, runtimeErrorMessage } from "./runtime-spawn-errors.ts";
import type { WorkspaceMonitorObservation } from "./runtime-workspace-monitor.ts";

/** Run recursive filesystem callbacks away from the repository writer event loop. */
export function openRuntimeWorkspaceMonitor(
  rootDir: string,
  cwd: string,
  append: (record: WorkspaceMonitorObservation) => void,
): { readonly ready: Promise<void>; readonly close: () => Promise<number | null> } {
  const lastActivity = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * 2)),
    extension = import.meta.url.endsWith(".js") ? ".js" : ".ts",
    worker = new Worker(new URL(`./runtime-workspace-monitor-worker${extension}`, import.meta.url), {
      name: "workspace-monitor",
      workerData: { rootDir, cwd, lastActivity: lastActivity.buffer },
    });
  let resolveReady!: () => void,
    lastRecordedAt = -Infinity,
    terminal = false,
    closing = false,
    exited = false,
    resolveExit!: () => void,
    closePromise: Promise<number | null> | null = null;
  const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    }),
    exit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
  worker.on("message", (record: WorkspaceMonitorObservation | { readonly kind: "ready" }) => {
    if (record.kind === "ready") {
      resolveReady();
      return;
    }
    if (record.kind === "workspace_activity") lastRecordedAt = Math.max(lastRecordedAt, Date.parse(record.occurredAt));
    if (record.kind === "workspace_removed" || record.kind === "workspace_observation_failed") {
      terminal = true;
      resolveReady();
    }
    append(record);
  });
  worker.on("error", (error) => {
    terminal = true;
    resolveReady();
    append({
      kind: "workspace_observation_failed",
      code: runtimeErrorCode(error),
      message: runtimeErrorMessage(error),
    });
  });
  worker.on("exit", (code) => {
    exited = true;
    if (!closing && !terminal) {
      terminal = true;
      resolveReady();
      append({
        kind: "workspace_observation_failed",
        code: "workspace_monitor_exit",
        message: `Workspace monitor exited with code ${String(code)}.`,
      });
    }
    resolveExit();
  });
  worker.unref();
  return {
    ready,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        if (!exited) worker.postMessage("close");
        await exit;
        const observedAt = Number(Atomics.load(lastActivity, 0));
        return Atomics.load(lastActivity, 1) === 0n && observedAt > lastRecordedAt && observedAt > 0
          ? observedAt
          : null;
      })();
      return closePromise;
    },
  };
}
