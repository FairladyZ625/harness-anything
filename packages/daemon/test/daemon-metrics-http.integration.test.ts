// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRpcMetricsAccumulator, PROMETHEUS_TEXT_CONTENT_TYPE } from "@harness-anything/kernel";
import { daemonPackageVersion } from "../src/daemon-host/build-identity.ts";
import { startDaemon } from "../src/daemon-host/runtime.ts";
import { createDaemonHostLifecycleApi } from "../src/daemon-host/daemon-host-lifecycle-api.ts";
import { resolveDaemonMetricsConfig, startDaemonMetricsServer } from "../src/daemon-host/metrics-http-server.ts";
import { requestDaemonJsonRpcAt } from "../src/daemon-host/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";

test("resolveDaemonMetricsConfig defaults to disabled and enforces safe validation", () => {
  assert.equal(resolveDaemonMetricsConfig({}), null);
  assert.equal(resolveDaemonMetricsConfig({ HARNESS_DAEMON_METRICS_PORT: "" }), null);

  const loopbackDefault = resolveDaemonMetricsConfig({ HARNESS_DAEMON_METRICS_PORT: "9090" });
  assert.deepEqual(loopbackDefault, {
    bind: "127.0.0.1",
    port: 9090,
    path: "/metrics",
    bearerToken: null,
  });

  const explicit = resolveDaemonMetricsConfig({
    HARNESS_DAEMON_METRICS_PORT: "9100",
    HARNESS_DAEMON_METRICS_BIND: "0.0.0.0",
    HARNESS_DAEMON_METRICS_PATH: "/custom/metrics",
    HARNESS_DAEMON_METRICS_BEARER_TOKEN: "secret-scrape-token",
  });
  assert.deepEqual(explicit, {
    bind: "0.0.0.0",
    port: 9100,
    path: "/custom/metrics",
    bearerToken: "secret-scrape-token",
  });

  assert.throws(() => resolveDaemonMetricsConfig({ HARNESS_DAEMON_METRICS_PORT: "not-a-port" }), /port/iu);
  assert.throws(() => resolveDaemonMetricsConfig({ HARNESS_DAEMON_METRICS_PORT: "70000" }), /port/iu);
  assert.throws(
    () => resolveDaemonMetricsConfig({ HARNESS_DAEMON_METRICS_PORT: "9090", HARNESS_DAEMON_METRICS_PATH: "metrics" }),
    /path/iu,
  );
});

test(
  "startDaemon exposes controlled read-only Prometheus /metrics, /healthz, /readyz and tracks live RPC traffic",
  { timeout: 60_000 },
  async () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-prom-daemon-"));
    const daemonId = "prom-test";
    const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
    let running: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      running = await startDaemon({
        userRoot,
        daemonId,
        endpoint,
        buildSupersessionEnabled: false,
        metrics: {
          bind: "127.0.0.1",
          port: 0,
          path: "/metrics",
          bearerToken: "scrape-secret-123",
        },
      });
      assert.ok("stop" in running, "daemon should acquire singleton");
      assert.ok(running.metricsEndpoint, "metricsEndpoint should be published when enabled");

      const metricsUrl = new URL(running.metricsEndpoint);
      const origin = metricsUrl.origin;

      // /healthz and /readyz stay probe-friendly without leaking metrics
      const healthz = await fetch(`${origin}/healthz`);
      assert.equal(healthz.status, 200);
      const healthBody = (await healthz.json()) as { ok: boolean; status: string; daemonId: string; pid: number };
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.status, "live");
      assert.equal(healthBody.daemonId, daemonId);
      assert.equal(healthBody.pid, process.pid);

      const readyz = await fetch(`${origin}/readyz`);
      assert.equal(readyz.status, 200);
      const readyBody = (await readyz.json()) as { ok: boolean; status: string };
      assert.equal(readyBody.ok, true);
      assert.equal(readyBody.status, "ready");

      // Bearer token guard on /metrics (RFC 6750 WWW-Authenticate without provider-specific realm)
      const unauth = await fetch(running.metricsEndpoint);
      assert.equal(unauth.status, 401);
      assert.equal(unauth.headers.get("www-authenticate"), "Bearer");
      const wrongAuth = await fetch(running.metricsEndpoint, {
        headers: { authorization: "Bearer wrong-token" },
      });
      assert.equal(wrongAuth.status, 401);
      assert.equal(wrongAuth.headers.get("www-authenticate"), "Bearer");

      // Non-GET/HEAD rejected with 405
      const postRes = await fetch(running.metricsEndpoint, {
        method: "POST",
        headers: { authorization: "Bearer scrape-secret-123" },
      });
      assert.equal(postRes.status, 405);
      assert.equal(postRes.headers.get("allow"), "GET, HEAD");

      // Unknown route rejected with 404
      const notFound = await fetch(`${origin}/unknown`);
      assert.equal(notFound.status, 404);

      // Trigger live RPC calls through the daemon JSON-RPC transport
      await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 15_000);
      await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 15_000);

      // Authorized scrape returns Prometheus 0.0.4 payload with live RPC counts
      const scraped = await fetch(running.metricsEndpoint, {
        headers: { authorization: "Bearer scrape-secret-123" },
      });
      assert.equal(scraped.status, 200);
      assert.equal(scraped.headers.get("content-type"), PROMETHEUS_TEXT_CONTENT_TYPE);
      assert.equal(scraped.headers.get("x-content-type-options"), "nosniff");
      assert.equal(scraped.headers.get("cache-control"), "no-store");

      const text = await scraped.text();
      const daemonPkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as {
        readonly version: string;
      };
      assert.ok(text.includes("ha_daemon_up 1\n"));
      assert.ok(text.includes(`daemon_id="${daemonId}"`));
      assert.ok(
        text.includes(`version="${process.env.npm_package_version?.trim() || daemonPkg.version}"`),
        `expected build_info version label to match package version, got:\n${text}`,
      );
      assert.ok(!text.includes('version="0.0.0"'), "ha_daemon_build_info must not report fallback version 0.0.0");
      assert.ok(text.includes("ha_daemon_write_queue_depth_total 0\n"));
      assert.ok(text.includes("ha_daemon_runtime_sessions_active 0\n"));
      assert.ok(text.includes("ha_daemon_fleet_connections_active 0\n"));
      assert.ok(text.includes("ha_daemon_projection_lag_revisions_max 0\n"));

      const okMatch = /ha_daemon_rpc_requests_total\{outcome="ok"\}\s+(\d+)/u.exec(text);
      assert.ok(okMatch, "expected ok RPC counter");
      assert.ok(Number(okMatch[1]) >= 2, `expected >= 2 ok RPCs, got ${okMatch[1]}`);

      const countMatch = /ha_daemon_rpc_duration_seconds_count\s+(\d+)/u.exec(text);
      assert.ok(countMatch && Number(countMatch[1]) >= 2, "expected histogram count >= 2");

      // HEAD /metrics succeeds with empty body
      const headRes = await fetch(running.metricsEndpoint, {
        method: "HEAD",
        headers: { authorization: "Bearer scrape-secret-123" },
      });
      assert.equal(headRes.status, 200);
      assert.equal(await headRes.text(), "");
    } finally {
      if (running && "stop" in running) await running.stop();
      rmSync(userRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

test("metrics scrape executes in O(1) bounded work independent of historical RPC volume and with zero disk/DB scans", async () => {
  const rpc = createRpcMetricsAccumulator();
  let snapshotCalls = 0;
  let cellStatusReads = 0;
  let fleetConnectionMetricReads = 0;
  let forbiddenSlowPathCalls = 0;

  // Build a minimal DaemonHostApiContext where any disk/DB slow path (statusCuts, fleet.status)
  // throws immediately, proving observabilitySnapshot() reads strictly in-memory O(1) headers.
  const cells = new Map(
    Array.from({ length: 8 }, (_, index) => {
      const repoId = `repo-${index}`;
      return [
        repoId,
        {
          status: () => {
            cellStatusReads += 1;
            return {
              repoId,
              rootDir: `/virtual/${repoId}`,
              mode: "local" as const,
              state: "attached" as const,
              generation: 1,
              queueDepth: index % 3,
              projectionWatermark: 1000 - index,
              ledgerRevision: 1000,
              lastError: null,
              causeClass: null,
              recoveryMs: 0,
              materialization: null,
            };
          },
          statusCuts: () => {
            forbiddenSlowPathCalls += 1;
            throw new Error("observabilitySnapshot must not invoke statusCuts slow path");
          },
        },
      ];
    }),
  );

  const lifecycle = createDaemonHostLifecycleApi({
    // Non-existent userRoot proves observabilitySnapshot never reads registry.json from disk.
    input: { userRoot: "/nonexistent-o1-proof-root", daemonId: "o1-proof" },
    cells,
    warming: new Map(),
    unavailable: new Map(),
    fleetCenter: {
      connectionMetrics: () => {
        fleetConnectionMetricReads += 1;
        return {
          activeConnections: 3,
          authenticatedNodes: 2,
          replicationStreams: 2,
          pendingDeliveries: 1,
        };
      },
      status: () => {
        forbiddenSlowPathCalls += 1;
        throw new Error("observabilitySnapshot must not invoke fleetCenter.status() DB slot scan");
      },
      pendingDeliveries: () => 1,
    },
  } as unknown as Parameters<typeof createDaemonHostLifecycleApi>[0]);

  const server = await startDaemonMetricsServer({
    config: { bind: "127.0.0.1", port: 0, path: "/metrics", bearerToken: null },
    daemonId: "o1-proof",
    collectSnapshot: () => {
      snapshotCalls += 1;
      const observed = lifecycle.observabilitySnapshot();
      return {
        daemonId: "o1-proof",
        version: "0.1.0",
        commit: "test",
        uptimeSeconds: 10,
        processResidentMemoryBytes: 1_000_000,
        processHeapUsedBytes: 500_000,
        activeRuntimeSessions: 2,
        rpc: rpc.snapshot(0),
        fleet: observed.fleet,
        repos: observed.repos,
      };
    },
    isReady: () => true,
    isLive: () => true,
  });

  try {
    for (let i = 0; i < 10; i += 1) rpc.observeDuration(0.015, true);
    const smallBody = await (await fetch(server.endpoint)).text();
    const smallLines = smallBody.split("\n").filter((line) => line.startsWith("ha_daemon_rpc_")).length;

    for (let i = 0; i < 10_000; i += 1) rpc.observeDuration((i % 100) / 1000, i % 20 !== 0);
    const largeBody = await (await fetch(server.endpoint)).text();
    const largeLines = largeBody.split("\n").filter((line) => line.startsWith("ha_daemon_rpc_")).length;

    assert.equal(snapshotCalls, 2, "each scrape invokes snapshot collector once");
    assert.equal(cellStatusReads, 16, "each scrape reads each loaded cell status exactly once");
    assert.equal(fleetConnectionMetricReads, 2, "each scrape reads O(1) fleet connection metrics once");
    assert.equal(forbiddenSlowPathCalls, 0, "scrape performs zero disk or DB scans");
    assert.equal(
      largeLines,
      smallLines,
      "RPC metric line cardinality stays constant O(1) after 10,000 additional RPCs",
    );
    assert.ok(largeBody.includes("ha_daemon_rpc_duration_seconds_count 10010\n"));
    assert.ok(largeBody.includes("ha_daemon_fleet_connections_active 3\n"));
    assert.ok(largeBody.includes("ha_daemon_projection_lag_revisions_max 7\n"));
  } finally {
    await server.close();
  }
});

test("daemonPackageVersion resolves installed package.json version when npm_package_version is unset", () => {
  const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as {
    readonly version: string;
  };
  assert.notEqual(pkg.version, "0.0.0");
  assert.equal(daemonPackageVersion({}), pkg.version);
  assert.equal(daemonPackageVersion({ npm_package_version: "   " }), pkg.version);
  assert.equal(daemonPackageVersion({ npm_package_version: "2.3.4" }), "2.3.4");
});

test("metrics HTTP server isolates throwing collectSnapshot/isReady/isLive callbacks and keeps serving", async () => {
  let failMetrics = true;
  let failReady = true;
  let failLive = true;
  const reported: Array<{ readonly pathname: string; readonly message: string }> = [];

  const server = await startDaemonMetricsServer({
    config: { bind: "127.0.0.1", port: 0, path: "/metrics", bearerToken: null },
    daemonId: "fault-isolation",
    collectSnapshot: () => {
      if (failMetrics) throw new Error("SQLITE_BUSY: projection read failed");
      return {
        daemonId: "fault-isolation",
        version: daemonPackageVersion({}),
        commit: "test",
        uptimeSeconds: 1,
        processResidentMemoryBytes: 1_000,
        processHeapUsedBytes: 500,
        activeRuntimeSessions: 0,
        rpc: createRpcMetricsAccumulator().snapshot(0),
        fleet: {
          centerEnabled: false,
          activeConnections: 0,
          authenticatedNodes: 0,
          replicationStreams: 0,
          pendingDeliveries: 0,
        },
        repos: [],
      };
    },
    isReady: () => {
      if (failReady) throw new Error("EIO: status cut unavailable");
      return true;
    },
    isLive: () => {
      if (failLive) throw new Error("liveness check failed");
      return true;
    },
    onError: (error, context) => {
      reported.push({
        pathname: context.pathname,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const origin = new URL(server.endpoint).origin;
  try {
    const failedMetrics = await fetch(server.endpoint);
    assert.equal(failedMetrics.status, 500);
    const failedMetricsBody = await failedMetrics.text();
    assert.equal(failedMetricsBody, "Internal Server Error\n");
    assert.ok(!failedMetricsBody.includes("SQLITE_BUSY"), "internal error details must not leak over HTTP");

    const failedReady = await fetch(`${origin}/readyz`);
    assert.equal(failedReady.status, 503);
    assert.deepEqual(await failedReady.json(), {
      ok: false,
      status: "error",
      daemonId: "fault-isolation",
      pid: process.pid,
    });

    const failedLive = await fetch(`${origin}/healthz`);
    assert.equal(failedLive.status, 503);
    assert.deepEqual(await failedLive.json(), {
      ok: false,
      status: "error",
      daemonId: "fault-isolation",
      pid: process.pid,
    });

    assert.equal(reported.length, 3);
    assert.equal(reported[0]?.pathname, "/metrics");
    assert.match(reported[0]?.message ?? "", /SQLITE_BUSY/u);
    assert.equal(reported[1]?.pathname, "/readyz");
    assert.equal(reported[2]?.pathname, "/healthz");

    // Once faults clear, the same server continues serving cleanly without restarting
    failMetrics = false;
    failReady = false;
    failLive = false;

    const recoveredMetrics = await fetch(server.endpoint);
    assert.equal(recoveredMetrics.status, 200);
    assert.ok((await recoveredMetrics.text()).includes("ha_daemon_up 1\n"));

    const recoveredReady = await fetch(`${origin}/readyz`);
    assert.equal(recoveredReady.status, 200);
    assert.equal(((await recoveredReady.json()) as { status: string }).status, "ready");

    const recoveredLive = await fetch(`${origin}/healthz`);
    assert.equal(recoveredLive.status, 200);
    assert.equal(((await recoveredLive.json()) as { status: string }).status, "live");
  } finally {
    await server.close();
  }
});
