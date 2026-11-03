// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonDiagnostics } from "../src/daemon-diagnostics.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import type { DaemonHost } from "../src/daemon-host.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

const authContext: DaemonAuthenticationContext = {
  transportKind: "unix-socket",
  unixSocketOwnerBoundary: { ownerUid: 501, source: "unix-socket-filesystem-owner-boundary" },
};
function protocol(observer?: Awaited<ReturnType<typeof openDaemonDiagnostics>>["observer"]) {
  return createJsonRpcProtocolServer({
    ...(observer ? { operationObserver: observer } : {}),
    host: {
      status: () => ({ daemonId: "overhead", pid: process.pid, repos: [], summary: "fixture" }),
    } as unknown as DaemonHost,
    build: { loadedBuildId: null, commit: null, builtAt: null },
    authContext,
    emit: async () => undefined,
  });
}
async function measure(server: ReturnType<typeof protocol>, requests: number, concurrency: number) {
  await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  });
  const cpu = process.cpuUsage(),
    started = performance.now();
  let sent = 0;
  while (sent < requests) {
    const size = Math.min(concurrency, requests - sent);
    await Promise.all(
      Array.from({ length: size }, (_, index) =>
        server.handle({ jsonrpc: "2.0", id: sent + index + 2, method: "daemon.status", params: {} }),
      ),
    );
    sent += size;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const usage = process.cpuUsage(cpu),
    elapsedMs = performance.now() - started,
    cpuMs = (usage.user + usage.system) / 1_000;
  return { cpuMs, elapsedMs, cpuMsPerRequest: cpuMs / requests, requestsPerSecond: (requests * 1_000) / elapsedMs };
}

test(
  "tracing on this build stays under two percent of one CPU at ten thousand requests per second",
  { timeout: 180_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-tracing-overhead-")),
      endpoint = localUserDaemonEndpoint(root, "tracing-overhead"),
      diagnostics = await openDaemonDiagnostics({
        userRoot: root,
        daemonId: "tracing-overhead",
        endpoint,
        heartbeatMs: 50,
        metricsIntervalMs: 60_000,
      });
    try {
      const requests = 50_000,
        concurrency = 100,
        rounds = 3,
        nullObserver = {
          begin: () => ({ update: () => undefined, end: () => undefined }),
        },
        baselineServer = protocol(),
        tracedServer = protocol(diagnostics.observer);
      // Warm both paths before the measured rounds.
      await measure(baselineServer, 2_000, concurrency);
      await measure(tracedServer, 2_000, concurrency);
      const baselineRounds = [],
        nullRounds = [],
        tracedRounds = [];
      for (let round = 0; round < rounds; round += 1) {
        baselineRounds.push(await measure(protocol(), requests, concurrency));
        nullRounds.push(await measure(protocol(nullObserver), requests, concurrency));
        tracedRounds.push(await measure(protocol(diagnostics.observer), requests, concurrency));
      }
      const median = (values: readonly { readonly cpuMsPerRequest: number }[]) =>
        [...values].sort((left, right) => left.cpuMsPerRequest - right.cpuMsPerRequest)[Math.floor(values.length / 2)]!;
      const baseline = median(baselineRounds),
        nullTrace = median(nullRounds),
        traced = median(tracedRounds),
        addedMsPerRequest = Math.max(0, traced.cpuMsPerRequest - baseline.cpuMsPerRequest),
        addedCpuPercentAt10k = addedMsPerRequest * 1_000;
      const report = {
        node: process.version,
        platform: process.platform,
        requests,
        concurrency,
        rounds,
        baseline,
        nullTrace,
        traced,
        addedMsPerRequest,
        addedCpuPercentAt10k,
        throughputRatio: traced.requestsPerSecond / baseline.requestsPerSecond,
      };
      console.log("tracing overhead measurement", JSON.stringify(report));
      assert.ok(addedCpuPercentAt10k < 2, JSON.stringify(report));
      assert.ok(report.throughputRatio > 0.5, JSON.stringify(report));
    } finally {
      await diagnostics.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);
