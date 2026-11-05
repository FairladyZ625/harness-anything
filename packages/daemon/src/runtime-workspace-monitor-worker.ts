import { parentPort, workerData } from "node:worker_threads";
import { observeRuntimeWorkspace } from "./runtime-workspace-monitor.ts";

const input = workerData as {
    readonly rootDir: string;
    readonly cwd: string;
    readonly lastActivity: SharedArrayBuffer;
  },
  lastActivity = new BigInt64Array(input.lastActivity);
// The watcher itself is unrefed; the port owns this thread until disposal or a terminal observation.
parentPort!.ref();
observeRuntimeWorkspace(
  input.rootDir,
  input.cwd,
  (record) => {
    if (record.kind === "workspace_removed" || record.kind === "workspace_observation_failed")
      Atomics.store(lastActivity, 1, 1n);
    parentPort!.postMessage(record);
    if (record.kind === "workspace_removed" || record.kind === "workspace_observation_failed") parentPort!.close();
  },
  (occurredAt) => Atomics.store(lastActivity, 0, BigInt(occurredAt)),
);
parentPort!.postMessage({ kind: "ready" });
