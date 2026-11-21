// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRpcMetricsAccumulator,
  formatPrometheusMetrics,
  PROMETHEUS_TEXT_CONTENT_TYPE,
} from "@harness-anything/kernel";
import { daemonPackageVersion } from "../src/daemon-host/build-identity.ts";
import { startDaemon } from "../src/daemon-host/runtime.ts";
import { createDaemonHostLifecycleApi } from "../src/daemon-host/daemon-host-lifecycle-api.ts";
import { openRepoCellProxy } from "../src/daemon-host/repo-cell-proxy.ts";
import { saveFleetCenterConfig } from "../src/daemon-host/fleet-center-config.ts";
import { resolveDaemonMetricsConfig, startDaemonMetricsServer } from "../src/daemon-host/metrics-http-server.ts";
import { requestDaemonJsonRpcAt } from "../src/daemon-host/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";
import { fleetEdgeConfigPath } from "../src/daemon-host/client/fleet-edge-config.ts";

test("resolveDaemonMetricsConfig defaults to disabled and rejects invalid ports and reserved probe paths", async () => {
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

  // F-G7-13: reject reserved probe paths and normalized/traversal variants on both config and server start
  for (const forbiddenPath of [
    "/healthz",
    "/readyz",
    "/healthz/",
    "/readyz/",
    "//healthz",
    "/./readyz",
    "/metrics/../healthz",
  ]) {
    assert.throws(
      () =>
        resolveDaemonMetricsConfig({
          HARNESS_DAEMON_METRICS_PORT: "9090",
          HARNESS_DAEMON_METRICS_PATH: forbiddenPath,
        }),
      /path/iu,
      `resolveDaemonMetricsConfig must reject ${forbiddenPath}`,
    );
    await assert.rejects(
      () =>
        startDaemonMetricsServer({
          config: { bind: "127.0.0.1", port: 0, path: forbiddenPath, bearerToken: null },
          daemonId: "reserved-path-reject",
          collectSnapshot: () => {
            throw new Error("should not be called");
          },
          isLive: () => true,
          isReady: () => true,
        }),
      /path/iu,
      `startDaemonMetricsServer must reject ${forbiddenPath}`,
    );
  }
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

test(
  "readyz distinguishes process liveness from storage unavailable, failed Fleet restore, and missing required identity, and recovers to 200",
  { timeout: 60_000 },
  async () => {
    // 1. Live startDaemon with failed Fleet restore & required identity -> /healthz 200, /readyz 503 with exact reasons
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-readyz-daemon-"));
    const daemonId = "readyz-test";
    const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
    let running: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      // Seed a center.json referencing an unregistered authority repo so openDaemonHost hits fleet_center_restore_failed
      saveFleetCenterConfig(userRoot, daemonId, {
        port: 7545,
        bind: "127.0.0.1",
        repoId: "missing-authority-repo",
        keyPath: path.join(userRoot, "missing.key"),
        certPath: path.join(userRoot, "missing.crt"),
        stateRoot: path.join(userRoot, "fleet"),
        quotaBytes: 1024 * 1024,
      });

      running = await startDaemon({
        userRoot,
        daemonId,
        endpoint,
        buildSupersessionEnabled: false,
        requireIdentityReady: true,
        metrics: {
          bind: "127.0.0.1",
          port: 0,
          path: "/metrics",
          bearerToken: null,
        },
      });
      assert.ok("stop" in running);
      assert.ok(running.metricsEndpoint);
      const origin = new URL(running.metricsEndpoint).origin;

      // Process is live (/healthz -> 200)
      const healthz = await fetch(`${origin}/healthz`);
      assert.equal(healthz.status, 200);
      assert.equal(((await healthz.json()) as { status: string }).status, "live");

      // Service is NOT ready (/readyz -> 503) because Fleet restore failed and required identity is missing
      const readyz = await fetch(`${origin}/readyz`);
      assert.equal(readyz.status, 503);
      const body = (await readyz.json()) as { ok: boolean; status: string; reasons?: string[] };
      assert.equal(body.ok, false);
      assert.equal(body.status, "not_ready");
      assert.ok(
        body.reasons?.includes("fleet_center_unavailable"),
        `expected fleet_center_unavailable in ${JSON.stringify(body)}`,
      );
      assert.ok(
        body.reasons?.includes("identity_not_configured"),
        `expected identity_not_configured in ${JSON.stringify(body)}`,
      );
    } finally {
      if (running && "stop" in running) await running.stop();
      rmSync(userRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }

    // 2. Lifecycle readiness state transitions: unavailable repo, fleet restore failure, and pending identity -> 503 -> recovery -> 200
    const cells = new Map();
    const warming = new Map();
    const unavailable = new Map();
    let initialSettled = false;
    let fleetRestoreFailed = true;
    let identityConfigured = false;

    const lifecycle = createDaemonHostLifecycleApi({
      input: { userRoot: "/virtual-readyz", daemonId: "readyz-transitions", requireIdentityReady: true },
      cells,
      warming,
      unavailable,
      closing: false,
      initialAttachmentsSettled: () => initialSettled,
      fleetCenterRestoreFailed: () => fleetRestoreFailed,
      identityReady: () => identityConfigured,
    } as unknown as Parameters<typeof createDaemonHostLifecycleApi>[0]);

    const server = await startDaemonMetricsServer({
      config: { bind: "127.0.0.1", port: 0, path: "/metrics", bearerToken: null },
      daemonId: "readyz-transitions",
      collectSnapshot: () => ({
        daemonId: "readyz-transitions",
        version: "0.1.0",
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
        repos: lifecycle.observabilitySnapshot().repos,
      }),
      isLive: () => true,
      isReady: () => lifecycle.probeSnapshot(),
    });
    const origin = new URL(server.endpoint).origin;
    try {
      // Initial attachments pending + fleet failed + identity unconfigured -> 503
      let res = await fetch(`${origin}/readyz`);
      assert.equal(res.status, 503);
      let payload = (await res.json()) as { reasons: string[] };
      assert.ok(payload.reasons.includes("initial_attachments_pending"));
      assert.ok(payload.reasons.includes("fleet_center_unavailable"));
      assert.ok(payload.reasons.includes("identity_not_configured"));

      // Storage attach fails -> repo lands in unavailable -> still 503 while /healthz stays 200
      initialSettled = true;
      fleetRestoreFailed = false;
      identityConfigured = true;
      unavailable.set("center", {
        repoId: "center",
        rootDir: "/virtual/center",
        mode: "local",
        state: "unavailable",
        generation: null,
        queueDepth: null,
        lastError: "postgres connection refused",
        causeClass: "infrastructure",
        recoveryMs: null,
        materialization: null,
      });

      assert.equal((await fetch(`${origin}/healthz`)).status, 200);
      res = await fetch(`${origin}/readyz`);
      assert.equal(res.status, 503);
      payload = (await res.json()) as { reasons: string[] };
      assert.deepEqual(payload.reasons, ["repos_unavailable"]);

      // Storage recovers -> repo moves from unavailable to attached cell -> /readyz transitions to 200
      unavailable.delete("center");
      cells.set("center", {
        publishedStatus: () => ({
          repoId: "center",
          rootDir: "/virtual/center",
          mode: "local",
          state: "attached",
          generation: 1,
          queueDepth: 0,
          projectionWatermark: 10,
          ledgerRevision: 10,
          lastError: null,
          causeClass: null,
          recoveryMs: 0,
          materialization: null,
        }),
        status: () => {
          throw new Error("readiness must read publishedStatus when available");
        },
      });
      res = await fetch(`${origin}/readyz`);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { status: string }).status, "ready");
    } finally {
      await server.close();
    }
  },
);

test(
  "metrics scrape uses pure in-memory RepoCellProxy publishedStatus (zero disk reads on remote-edge replica-only) and linear O(R) formatting",
  { timeout: 60_000 },
  async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "ha-edge-o1-scrape-"));
    const userRoot = path.join(sandbox, "user");
    const repoRoot = path.join(sandbox, "repo");
    const viewRoot = path.join(sandbox, "views");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(viewRoot, { recursive: true });

    // Seed a valid fleet-edge.json so openRepoCellProxy enters the real remote-edge replicaOnly branch
    // when its writer worker fails to open.
    const edgeCfgPath = fleetEdgeConfigPath(userRoot, "edge-repo");
    mkdirSync(path.dirname(edgeCfgPath), { recursive: true });
    writeFileSync(
      edgeCfgPath,
      JSON.stringify({
        schema: "fleet-edge-config/v1",
        repoId: "edge-repo",
        host: "127.0.0.1",
        port: 7545,
        nodeId: "edge-node-1",
        credential: "dummy-cred",
        caPath: path.join(sandbox, "ca.pem"),
        viewRoot,
        quotaBytes: 1024 * 1024,
      }),
    );

    const edgeCell = await openRepoCellProxy(
      {
        repoId: "edge-repo",
        rootDir: repoRoot,
        userRoot,
        ownerId: "o1-test",
        mode: "remote-edge",
      },
      {
        createWriterWorker: () => {
          throw new Error("simulated edge writer attach failure");
        },
      },
    );

    try {
      // Corrupt fleet-edge.json on disk AFTER open: if observabilitySnapshot() touched disk (via replicaStatus),
      // JSON.parse in readFleetEdgeConfig would throw!
      writeFileSync(edgeCfgPath, "{invalid-json-must-not-be-read-on-scrape");

      const cells = new Map();
      cells.set("edge-repo", edgeCell);
      for (let i = 0; i < 64; i += 1) {
        const repoId = `repo-${String(63 - i).padStart(3, "0")}`; // deliberately inserted in reverse order
        cells.set(repoId, {
          publishedStatus: () => ({
            repoId,
            rootDir: `/virtual/${repoId}`,
            mode: "local" as const,
            state: "attached" as const,
            generation: 1,
            queueDepth: i % 4,
            projectionWatermark: 1000 - (i % 5),
            ledgerRevision: 1000,
            lastError: null,
            causeClass: null,
            recoveryMs: 0,
            materialization: null,
          }),
          status: () => {
            throw new Error("observabilitySnapshot must read publishedStatus(), not slow status()");
          },
          statusCuts: () => {
            throw new Error("observabilitySnapshot must not invoke statusCuts()");
          },
        });
      }

      const rpc = createRpcMetricsAccumulator();
      const lifecycle = createDaemonHostLifecycleApi({
        input: { userRoot: "/nonexistent-o1-proof-root", daemonId: "o1-proof" },
        cells,
        warming: new Map(),
        unavailable: new Map(),
        fleetCenter: {
          connectionMetrics: () => ({
            activeConnections: 3,
            authenticatedNodes: 2,
            replicationStreams: 2,
            pendingDeliveries: 1,
          }),
          status: () => {
            throw new Error("observabilitySnapshot must not invoke fleetCenter.status()");
          },
          pendingDeliveries: () => 1,
        },
      } as unknown as Parameters<typeof createDaemonHostLifecycleApi>[0]);

      // First scrape populates resident sorted order; second scrape reuses cached order with zero sorting
      const snap1 = lifecycle.observabilitySnapshot();
      const snap2 = lifecycle.observabilitySnapshot();
      assert.equal(snap1.repos.length, 65);
      assert.deepEqual(
        snap2.repos.map((r) => r.repoId),
        [...snap2.repos.map((r) => r.repoId)].sort(),
        "observabilitySnapshot must return pre-sorted repos without requiring formatPrometheusMetrics to re-sort",
      );
      assert.equal(snap2.repos[0]?.repoId, "edge-repo");
      assert.equal(snap2.repos[0]?.state, "unavailable");

      // Confirm formatPrometheusMetrics formats pre-sorted repos cleanly and preserves constant RPC cardinality
      for (let i = 0; i < 10; i += 1) rpc.observeDuration(0.015, true);
      const smallText = formatPrometheusMetrics({
        daemonId: "o1-proof",
        version: "0.1.0",
        commit: "test",
        uptimeSeconds: 10,
        processResidentMemoryBytes: 1_000_000,
        processHeapUsedBytes: 500_000,
        activeRuntimeSessions: 2,
        rpc: rpc.snapshot(0),
        fleet: snap2.fleet,
        repos: snap2.repos,
      });
      const smallRpcLines = smallText.split("\n").filter((line) => line.startsWith("ha_daemon_rpc_")).length;

      for (let i = 0; i < 10_000; i += 1) rpc.observeDuration((i % 100) / 1000, i % 20 !== 0);
      const largeText = formatPrometheusMetrics({
        daemonId: "o1-proof",
        version: "0.1.0",
        commit: "test",
        uptimeSeconds: 11,
        processResidentMemoryBytes: 1_000_000,
        processHeapUsedBytes: 500_000,
        activeRuntimeSessions: 2,
        rpc: rpc.snapshot(0),
        fleet: snap2.fleet,
        repos: snap2.repos,
      });
      const largeRpcLines = largeText.split("\n").filter((line) => line.startsWith("ha_daemon_rpc_")).length;
      assert.equal(largeRpcLines, smallRpcLines, "RPC metric cardinality stays constant O(1) after 10,000 RPCs");
      assert.ok(largeText.includes("ha_daemon_rpc_duration_seconds_count 10010\n"));
      assert.ok(largeText.includes("ha_daemon_fleet_connections_active 3\n"));
      assert.ok(largeText.includes("ha_daemon_projection_lag_revisions_max 4\n"));
    } finally {
      await edgeCell.close();
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

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
