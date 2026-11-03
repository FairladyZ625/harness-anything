// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonDiagnostics } from "../src/daemon-diagnostics.ts";
import { withDaemonObservation } from "../src/daemon-operation.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { daemonDiagnosticsEndpoint, localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import type { DaemonHost } from "../src/daemon-host.ts";

async function until<T>(read: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (performance.now() >= deadline) assert.fail("condition was not reached before the deadline");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test(
  "diagnostics worker aggregates per-method latency, nodes and writer queue depth",
  { timeout: 20_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-diag-trace-")),
      endpoint = localUserDaemonEndpoint(root, "diagnostics-trace");
    try {
      const diagnostics = await openDaemonDiagnostics({
        userRoot: root,
        daemonId: "diagnostics-trace",
        endpoint,
        heartbeatMs: 20,
        metricsIntervalMs: 50,
        writeQueues: () => [{ repoId: "repo-a", queueDepth: 3 }],
      });
      const transport = createUnixSocketTransportServer({
        daemonId: "diagnostics-trace",
        socketPath: endpoint,
        createProtocolServer: (authContext, emit) =>
          createJsonRpcProtocolServer({
            operationObserver: diagnostics.observer,
            host: {
              status: () => ({ daemonId: "diagnostics-trace", pid: process.pid, repos: [], summary: "fixture" }),
            } as unknown as DaemonHost,
            build: { loadedBuildId: null, commit: null, builtAt: null },
            authContext,
            emit,
          }),
      });
      await withDaemonObservation(diagnostics.observer, () => transport.start());
      try {
        for (let index = 0; index < 3; index += 1)
          await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 500, 2_000);
        const snapshot = await until(() => {
          return requestDaemonJsonRpcAt(daemonDiagnosticsEndpoint(endpoint), "daemon.status", {}, 500, 2_000).then(
            (value) => {
              const trace = value.trace as Record<string, unknown> | undefined;
              const byMethod = Array.isArray(trace?.byMethod) ? (trace!.byMethod as Record<string, unknown>[]) : [];
              return byMethod.some((row) => row.method === "daemon.status" && Number(row.count) >= 3) ? value : null;
            },
          );
        });
        const trace = snapshot.trace as Record<string, unknown>;
        const method = (trace.byMethod as Record<string, unknown>[]).find((row) => row.method === "daemon.status")!;
        assert.ok(Number(method.p99Ms) >= 0);
        const nodes = trace.byNode as Record<string, unknown>[];
        assert.equal(nodes[0]!.nodeId, "local");
        assert.ok(Number(nodes[0]!.requests) >= 3);
        const queues = trace.writeQueues as Record<string, unknown>[];
        assert.equal(queues[0]!.repoId, "repo-a");
        assert.equal(queues[0]!.queueDepth, 3);
        assert.ok(Number(queues[0]!.ageMs) >= 0);
        assert.equal(trace.slowThresholdMs, 1_000);
        assert.ok(Number((trace.requestsPerSecond as Record<string, unknown>).last60s) >= 0);
        assert.deepEqual(snapshot.inFlight, []);
        const stall = await until(async () => {
          const started = performance.now();
          while (performance.now() - started < 60) {
            /* deliberate main-thread block */
          }
          const value = diagnostics.takeEventLoopStallMs();
          return value >= 20 ? value : null;
        });
        assert.ok(stall >= 20, `measured stall ${stall}ms`);
      } finally {
        await transport.stop();
        await diagnostics.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);
