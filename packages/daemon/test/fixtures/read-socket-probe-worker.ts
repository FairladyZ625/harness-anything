import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { requestDaemonJsonRpcAt } from "../../src/client/local-json-rpc-client.ts";
import { endpointIdentity } from "../../src/protocol/daemon-protocol.contract.ts";

interface ProbeInput {
  readonly endpoint: string;
  readonly repoId: string;
  readonly samples: number;
  readonly intervalMs: number;
}

const input = workerData as ProbeInput,
  endpoint = endpointIdentity(input.endpoint),
  calls = [
    ["workspaceSummary", "repo.workspace.summary.read", { repo: { repoId: input.repoId } }],
    ["guiTaskList", "repo.tasks.list", { repo: { repoId: input.repoId }, payload: { limit: 1 } }],
    [
      "legacyTaskList",
      "repo.task.read",
      { repo: { repoId: input.repoId }, payload: { action: { kind: "task-list", limit: 1 } } },
    ],
  ] as const,
  values: Record<string, number[]> = Object.fromEntries(calls.map(([name]) => [name, []]));

parentPort!.postMessage({ ready: true });
try {
  for (let sample = 0; sample < input.samples; sample += 1) {
    for (const [name, method, params] of calls) {
      const startedAt = performance.now();
      await requestDaemonJsonRpcAt(endpoint, method, params, 2_000, 10_000);
      // Microsecond precision, not whole milliseconds: a sub-2ms round trip rounded to the
      // nearest millisecond turns a real ~0.5ms difference into a 100%+ swing once percentiles
      // are taken over the rounded values, which trips ratio-based latency bounds on noise
      // rather than an actual regression.
      values[name]!.push(Math.round((performance.now() - startedAt) * 1000) / 1000);
    }
    if (sample + 1 < input.samples) await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
  }
  parentPort!.postMessage({ ok: true, values });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
