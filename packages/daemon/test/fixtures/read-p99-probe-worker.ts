import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { requestDaemonJsonRpcAt } from "../../src/client/local-json-rpc-client.ts";
import { currentDaemonProtocolVersion } from "../../src/protocol/version.ts";
const { endpoint, repoId, samples } = workerData as { endpoint: string; repoId: string; samples: number };
const barrier = new Int32Array(workerData.barrier as SharedArrayBuffer);
const measurements: Record<string, number[]> = { status: [], hello: [], write: [] };
parentPort!.postMessage({ type: "ready" });
for (let sequence = 1; sequence <= samples; sequence++) {
  while (Atomics.load(barrier, 1) < sequence) Atomics.wait(barrier, 1, sequence - 1);
  await Promise.all(
    [
      ["status", "daemon.status", {}],
      ["hello", "protocol.hello", { protocolVersion: currentDaemonProtocolVersion }],
      [
        "write",
        "repo.task.create",
        { repo: { repoId }, payload: { title: `Concurrent write ${sequence}`, presetId: "standard-task" } },
      ],
    ].map(async ([name, method, params]) => {
      const started = performance.now();
      const result = (await requestDaemonJsonRpcAt(
        endpoint,
        method as string,
        params as Record<string, unknown>,
        5_000,
        20_000,
      )) as Record<string, unknown>;
      if (name === "write" && result.outcome !== "applied") throw new Error(JSON.stringify(result));
      measurements[name as string]!.push(performance.now() - started);
    }),
  );
  Atomics.store(barrier, 2, sequence);
  Atomics.notify(barrier, 2);
  Atomics.store(barrier, 3, sequence);
  Atomics.notify(barrier, 3);
}
parentPort!.postMessage({ type: "result", measurements });
