// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRpcMetricsAccumulator,
  formatPrometheusMetrics,
  PROMETHEUS_TEXT_CONTENT_TYPE,
  readDaemonRegistry,
} from "@harness-anything/kernel";
import { sqliteLedgerPath } from "@harness-anything/storage";
import { daemonPackageVersion } from "../src/daemon-host/build-identity.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { startDaemon } from "../src/daemon-host/runtime.ts";
import { readDaemonLifecycleRecords } from "../src/daemon-host/lifecycle-log.ts";
import { createDaemonHostLifecycleApi, createTrackedRepoMaps } from "../src/daemon-host/daemon-host-lifecycle-api.ts";
import { openRepoCellProxy } from "../src/daemon-host/repo-cell-proxy.ts";
import { saveFleetCenterConfig } from "../src/daemon-host/fleet-center-config.ts";
import { resolveDaemonMetricsConfig, startDaemonMetricsServer } from "../src/daemon-host/metrics-http-server.ts";
import { requestDaemonJsonRpcAt } from "../src/daemon-host/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";
import { fleetEdgeConfigPath } from "../src/daemon-host/client/fleet-edge-config.ts";
import { rawPeer } from "./fleet-tls-session.fixture.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { rosterRepo } from "./daemon-host-recovery.fixture.ts";

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

  // F-G7-13 & F-G7-23: reject reserved probe paths, traversal/dot variants, trailing slashes, non-ASCII, and percent-encoded paths
  for (const forbiddenPath of [
    "/",
    "/healthz",
    "/readyz",
    "/healthz/",
    "/readyz/",
    "//healthz",
    "/./readyz",
    "/metrics/../healthz",
    "/metrics/",
    "/指标",
    "/%6detrics",
    "/metrics%2Fsub",
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

  // F-G7-22: fail closed when bearer auth is configured with empty or whitespace token (never downgrade to anonymous)
  for (const badEnv of [
    { HARNESS_DAEMON_METRICS_PORT: "9090", HARNESS_DAEMON_METRICS_BEARER_TOKEN: "" },
    { HARNESS_DAEMON_METRICS_PORT: "9090", HARNESS_DAEMON_METRICS_BEARER_TOKEN: "   " },
    { HARNESS_DAEMON_METRICS_PORT: "9090", HARNESS_DAEMON_METRICS_REQUIRE_AUTH: "1" },
    {
      HARNESS_DAEMON_METRICS_PORT: "9090",
      HARNESS_DAEMON_METRICS_REQUIRE_AUTH: "1",
      HARNESS_DAEMON_METRICS_BEARER_TOKEN: "",
    },
  ]) {
    assert.throws(
      () => resolveDaemonMetricsConfig(badEnv),
      /bearer token/iu,
      `resolveDaemonMetricsConfig must reject invalid bearer auth env: ${JSON.stringify(badEnv)}`,
    );
  }
  for (const emptyToken of ["", "   ", "\t\n"]) {
    await assert.rejects(
      () =>
        startDaemonMetricsServer({
          config: { bind: "127.0.0.1", port: 0, path: "/metrics", bearerToken: emptyToken },
          daemonId: "empty-bearer-reject",
          collectSnapshot: () => {
            throw new Error("should not be called");
          },
          isLive: () => true,
          isReady: () => true,
        }),
      /bearer token/iu,
      `startDaemonMetricsServer must reject empty/whitespace bearerToken=${JSON.stringify(emptyToken)}`,
    );
  }

  // F-G7-23: custom ASCII metrics path normalizes RFC 3986 percent-encoded unreserved request octets while keeping %2F rejected
  const customServer = await startDaemonMetricsServer({
    config: { bind: "127.0.0.1", port: 0, path: "/custom/prom-metrics_1.0", bearerToken: null },
    daemonId: "custom-path-norm",
    collectSnapshot: () => ({
      daemonId: "custom-path-norm",
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
      repos: [],
    }),
    isLive: () => true,
    isReady: () => true,
  });
  try {
    const origin = new URL(customServer.endpoint).origin;
    assert.equal((await fetch(`${origin}/custom/prom-metrics_1.0`)).status, 200);
    // %70='p', %2D='-', %5F='_', %2E='.' (all RFC 3986 unreserved octets)
    const encodedRes = await fetch(`${origin}/custom/%70rom%2Dmetrics%5F1%2E0`);
    assert.equal(encodedRes.status, 200);
    assert.ok((await encodedRes.text()).includes("ha_daemon_up 1\n"));
    // Percent-encoded slash (%2F) is reserved and must NOT be decoded into a separator
    assert.equal((await fetch(`${origin}/custom%2Fprom-metrics_1.0`)).status, 404);
    // Percent-encoded unreserved octets on reserved probe routes still route consistently
    assert.equal((await fetch(`${origin}/%68ealthz`)).status, 200);
    assert.equal((await fetch(`${origin}/%72eadyz`)).status, 200);
  } finally {
    await customServer.close();
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
    const tracked = createTrackedRepoMaps();
    const { cells, warming, unavailable, sortedRepoIds } = tracked;
    let initialSettled = false;
    let fleetRestoreFailed = true;
    let identityState:
      | "ready"
      | "identity_not_configured"
      | "identity_verifying"
      | "identity_authority_sync_pending"
      | "identity_unavailable" = "identity_not_configured";

    const lifecycle = createDaemonHostLifecycleApi({
      input: { userRoot: "/virtual-readyz", daemonId: "readyz-transitions", requireIdentityReady: true },
      cells,
      warming,
      unavailable,
      sortedRepoIds,
      closing: false,
      initialAttachmentsSettled: () => initialSettled,
      fleetCenterRestoreFailed: () => fleetRestoreFailed,
      identityReadiness: () => identityState,
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
      identityState = "ready";
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

      const tracked = createTrackedRepoMaps();
      const { cells, warming, unavailable, sortedRepoIds, publishRepoStatus } = tracked;
      cells.set("edge-repo", edgeCell);
      let publishedStatusReadsDuringScrape = 0;
      let measuringScrape = false;
      const makeFakeCell = (repoId: string, i: number) => ({
        publishedStatus: () => {
          if (measuringScrape) publishedStatusReadsDuringScrape += 1;
          return {
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
          };
        },
        status: () => {
          throw new Error("observabilitySnapshot must read publishedStatus(), not slow status()");
        },
        statusCuts: () => {
          throw new Error("observabilitySnapshot must not invoke statusCuts()");
        },
      });
      for (let i = 0; i < 64; i += 1) {
        const repoId = `repo-${String(63 - i).padStart(3, "0")}`; // deliberately inserted in reverse order
        cells.set(repoId, makeFakeCell(repoId, i) as unknown as Parameters<typeof cells.set>[1]);
      }

      const rpc = createRpcMetricsAccumulator();
      const lifecycle = createDaemonHostLifecycleApi({
        input: { userRoot: "/nonexistent-o1-proof-root", daemonId: "o1-proof" },
        cells,
        warming,
        unavailable,
        sortedRepoIds,
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

      // Spy on Array.prototype.sort to prove ZERO sorting occurs during steady-state scrapes or hot-path status updates
      let sortCalls = 0;
      let steadyStateSortCalls = 0;
      const originalSort = Array.prototype.sort;
      Array.prototype.sort = function (compareFn) {
        sortCalls += 1;
        return originalSort.call(this, compareFn);
      };
      let snap1: ReturnType<typeof lifecycle.observabilitySnapshot>;
      let snap2: ReturnType<typeof lifecycle.observabilitySnapshot>;
      let snapAfterMutation: ReturnType<typeof lifecycle.observabilitySnapshot>;
      try {
        measuringScrape = true;
        // First scrape after membership init: zero per-repo cell.publishedStatus() calls
        snap1 = lifecycle.observabilitySnapshot();
        const sortBeforeSteady = sortCalls;
        // Second scrape (steady state): zero sorting and zero per-repo cell.publishedStatus() calls
        snap2 = lifecycle.observabilitySnapshot();
        steadyStateSortCalls += sortCalls - sortBeforeSteady;
        measuringScrape = false;
        // Attach a new repo out-of-order and detach an existing repo
        cells.set("aaa-new-repo", makeFakeCell("aaa-new-repo", 0) as unknown as Parameters<typeof cells.set>[1]);
        cells.delete("repo-032");
        // Publish an event-driven status update (queueDepth spike + lag spike -> lag drop) and verify O(1) updates
        const sortBeforePublish = sortCalls;
        publishRepoStatus("aaa-new-repo", {
          repoId: "aaa-new-repo",
          rootDir: "/virtual/aaa-new-repo",
          mode: "local",
          state: "attached",
          generation: 2,
          queueDepth: 17,
          projectionWatermark: 900,
          ledgerRevision: 1025,
          lastError: null,
          causeClass: null,
          recoveryMs: 0,
          materialization: null,
        });
        assert.equal(sortCalls, sortBeforePublish, "publishRepoStatus must never sort on the writer hot path");
        measuringScrape = true;
        snapAfterMutation = lifecycle.observabilitySnapshot();
      } finally {
        measuringScrape = false;
        Array.prototype.sort = originalSort;
      }
      assert.equal(
        steadyStateSortCalls,
        0,
        "observabilitySnapshot must never call Array.prototype.sort on steady-state scrapes",
      );
      assert.equal(
        publishedStatusReadsDuringScrape,
        0,
        "observabilitySnapshot must serve pre-maintained repo state with zero per-repo cell.publishedStatus() polling during scrapes (F-G7-44)",
      );
      assert.equal(snapAfterMutation.repoAggregates.maxProjectionLag, 125);
      assert.ok(snapAfterMutation.repoAggregates.totalQueueDepth >= 17);
      // Drop the max-lag repo's lag back to 0 and verify maxProjectionLag recomputes accurately on scrape (zero hot-path scan)
      publishRepoStatus("aaa-new-repo", {
        repoId: "aaa-new-repo",
        rootDir: "/virtual/aaa-new-repo",
        mode: "local",
        state: "attached",
        generation: 2,
        queueDepth: 0,
        projectionWatermark: 1025,
        ledgerRevision: 1025,
        lastError: null,
        causeClass: null,
        recoveryMs: 0,
        materialization: null,
      });
      measuringScrape = true;
      const snapAfterLagDrop = lifecycle.observabilitySnapshot();
      measuringScrape = false;
      assert.equal(publishedStatusReadsDuringScrape, 0);
      assert.equal(snapAfterLagDrop.repoAggregates.maxProjectionLag, 4);
      assert.equal(snap1.repos.length, 65);
      assert.deepEqual(
        snap2.repos.map((r) => r.repoId),
        [...snap2.repos.map((r) => r.repoId)].sort(),
        "observabilitySnapshot must return pre-sorted repos without requiring formatPrometheusMetrics to re-sort",
      );
      assert.equal(snap2.repos[0]?.repoId, "edge-repo");
      assert.equal(snap2.repos[0]?.state, "unavailable");
      assert.equal(snapAfterMutation.repos[0]?.repoId, "aaa-new-repo");
      assert.ok(!snapAfterMutation.repos.some((r) => r.repoId === "repo-032"));
      assert.deepEqual(
        snapAfterMutation.repos.map((r) => r.repoId),
        [...snapAfterMutation.repos.map((r) => r.repoId)].sort(),
      );

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

test(
  "cold HTTP /metrics scrape on a freshly launched node daemon performs zero existsSync/readFileSync calls before any daemon.status RPC",
  { timeout: 60_000 },
  () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-cold-scrape-"));
    const runtimeUrl = new URL("../src/daemon-host/runtime.ts", import.meta.url).href;
    const targetUrl = new URL("../src/daemon-host/client/local-daemon-target.ts", import.meta.url).href;
    const daemonPkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as {
      readonly version: string;
    };
    const childEnv = { ...process.env };
    delete childEnv.npm_package_version;
    try {
      const probeScript = `
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        import { startDaemon } from ${JSON.stringify(runtimeUrl)};
        import { localUserDaemonEndpoint } from ${JSON.stringify(targetUrl)};

        const userRoot = ${JSON.stringify(userRoot)};
        const daemonId = "cold-scrape-zero-fs";
        const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
        const running = await startDaemon({
          userRoot,
          daemonId,
          endpoint,
          buildSupersessionEnabled: false,
          metrics: { bind: "127.0.0.1", port: 0, path: "/metrics", bearerToken: null },
        });
        if (!("stop" in running) || !running.metricsEndpoint) {
          throw new Error("expected running daemon with metricsEndpoint");
        }
        const readyzUrl = new URL("/readyz", running.metricsEndpoint).href;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const probe = await fetch(readyzUrl);
          if (probe.status === 200) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const fsCalls = [];
        let memoryUsageCalls = 0;
        let memoryUsageRssCalls = 0;
        const origExistsSync = fs.existsSync;
        const origReadFileSync = fs.readFileSync;
        const origStatSync = fs.statSync;
        const origLstatSync = fs.lstatSync;
        const origReaddirSync = fs.readdirSync;
        const origMemoryUsage = process.memoryUsage;
        const origMemoryUsageRss = origMemoryUsage.rss;
        const wrappedMemoryUsage = Object.assign(
          (...args) => {
            memoryUsageCalls += 1;
            return origMemoryUsage(...args);
          },
          {
            rss: (...args) => {
              memoryUsageRssCalls += 1;
              return origMemoryUsageRss.apply(origMemoryUsage, args);
            },
          },
        );
        process.memoryUsage = wrappedMemoryUsage;
        fs.existsSync = (...args) => { fsCalls.push(["existsSync", String(args[0])]); return origExistsSync(...args); };
        fs.readFileSync = (...args) => { fsCalls.push(["readFileSync", String(args[0])]); return origReadFileSync(...args); };
        fs.statSync = (...args) => { fsCalls.push(["statSync", String(args[0])]); return origStatSync(...args); };
        fs.lstatSync = (...args) => { fsCalls.push(["lstatSync", String(args[0])]); return origLstatSync(...args); };
        fs.readdirSync = (...args) => { fsCalls.push(["readdirSync", String(args[0])]); return origReaddirSync(...args); };
        syncBuiltinESMExports();
        let body = "";
        let status = 0;
        try {
          const res = await fetch(running.metricsEndpoint);
          status = res.status;
          body = await res.text();
        } finally {
          process.memoryUsage = origMemoryUsage;
          fs.existsSync = origExistsSync;
          fs.readFileSync = origReadFileSync;
          fs.statSync = origStatSync;
          fs.lstatSync = origLstatSync;
          fs.readdirSync = origReaddirSync;
          syncBuiltinESMExports();
          await running.stop();
        }
        const rssMatch = /ha_daemon_process_resident_memory_bytes (\\d+(?:\\.\\d+)?)/u.exec(body);
        const heapMatch = /ha_daemon_process_heap_used_bytes (\\d+(?:\\.\\d+)?)/u.exec(body);
        process.stdout.write(
          JSON.stringify({
            status,
            fsCalls,
            memoryUsageCalls,
            memoryUsageRssCalls,
            rssBytes: rssMatch ? Number(rssMatch[1]) : 0,
            heapUsedBytes: heapMatch ? Number(heapMatch[1]) : 0,
            hasVersion: body.includes('version="${daemonPkg.version}"'),
            hasUp: body.includes("ha_daemon_up 1\\n"),
          }),
        );
      `;
      const probePath = path.join(userRoot, "cold-scrape-probe.mjs");
      writeFileSync(probePath, probeScript, "utf8");
      const output = execFileSync(process.execPath, [probePath], {
        env: childEnv,
        encoding: "utf8",
      });
      const parsed = JSON.parse(output) as {
        readonly status: number;
        readonly fsCalls: readonly (readonly [string, string])[];
        readonly memoryUsageCalls: number;
        readonly memoryUsageRssCalls: number;
        readonly rssBytes: number;
        readonly heapUsedBytes: number;
        readonly hasVersion: boolean;
        readonly hasUp: boolean;
      };
      assert.equal(parsed.status, 200);
      assert.equal(parsed.hasUp, true);
      assert.equal(parsed.hasVersion, true, "cold /metrics must report real installed daemon package version");
      assert.ok(parsed.rssBytes > 0, `expected positive sampled RSS bytes, got ${parsed.rssBytes}`);
      assert.ok(parsed.heapUsedBytes > 0, `expected positive sampled heapUsed bytes, got ${parsed.heapUsedBytes}`);
      assert.equal(
        parsed.memoryUsageCalls,
        0,
        "HTTP /metrics scrape must NEVER invoke synchronous process.memoryUsage() page-table walk (F-G7-44)",
      );
      assert.equal(
        parsed.memoryUsageRssCalls,
        0,
        "HTTP /metrics scrape must read bounded background memory sample instead of invoking synchronous RSS syscall on request path (F-G7-44)",
      );
      assert.deepEqual(
        parsed.fsCalls,
        [],
        `cold HTTP /metrics scrape must perform zero synchronous fs calls, observed: ${JSON.stringify(parsed.fsCalls)}`,
      );
    } finally {
      rmSync(userRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

test(
  "ha_daemon_rpc_inflight accounts for in-flight Fleet TLS RPC requests consistently with local Unix RPCs",
  { timeout: 60_000 },
  async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "ha-fleet-inflight-"));
    const userRoot = path.join(sandbox, "user");
    const repoRoot = path.join(sandbox, "repo");
    const keyPath = path.join(sandbox, "tls.key");
    const certPath = path.join(sandbox, "tls.crt");
    const repoId = "fleet-inflight";
    const daemonId = "fleet-inflight-daemon";
    const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
    const closers: Array<() => unknown> = [];
    let running: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      rosterRepo(repoRoot, repoId);
      registerBootstrappedDaemonRepo({ canonicalRoot: repoRoot, repoId, userRoot, createConvenienceLinks: false });
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-subj",
          "/CN=localhost",
          "-days",
          "1",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { stdio: "ignore" },
      );
      const probeServer = net.createServer();
      await new Promise<void>((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
      const fleetPort = (probeServer.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probeServer.close(() => resolve()));

      saveFleetCenterConfig(userRoot, daemonId, {
        port: fleetPort,
        bind: "127.0.0.1",
        repoId,
        keyPath,
        certPath,
        stateRoot: path.join(userRoot, "fleet"),
        quotaBytes: 1024 * 1024,
      });

      let signalRpcEntered!: () => void;
      const rpcEntered = new Promise<void>((resolve) => {
        signalRpcEntered = resolve;
      });
      let releaseRpc!: () => void;
      const rpcGate = new Promise<void>((resolve) => {
        releaseRpc = resolve;
      });

      const fakeOidc = {
        configured: () => true,
        centerConfigured: () => true,
        center: async () => ({
          url: "https://idp.example.invalid",
          realm: "fleet",
          accessToken: "center-tok",
          provider: {
            policyRef: "test-policy",
            authority: { url: "https://idp.example.invalid", realm: "fleet" },
            deniedReasonCode: "authorization_denied",
            authenticateNode: async () => true,
            readNode: async () => ({ state: "active", revocation: "complete", personId: "person-owner" }),
            validateUserAccessToken: async () => true,
            authorize: async () => ({ outcome: "allowed", reasonCode: "allowed" }),
            authorizePerson: async () => ({ outcome: "allowed", reasonCode: "allowed" }),
          },
        }),
        bind: async <T extends Record<string, unknown>>(auth: T) => ({
          ...auth,
          oidcPrincipal: {
            personId: "person-owner",
            accessToken: "human-tok",
            azp: "harness-cli",
            authority: { url: "https://idp.example.invalid", realm: "fleet" },
            provider: {
              policyRef: "test-policy",
              authority: { url: "https://idp.example.invalid", realm: "fleet" },
              deniedReasonCode: "authorization_denied",
              validateUserAccessToken: async () => true,
              authorize: async () => ({ outcome: "allowed", reasonCode: "allowed" }),
              authorizePerson: async () => ({ outcome: "allowed", reasonCode: "allowed" }),
            },
          },
        }),
        discovery: () => null,
        status: async () => ({ ok: true }),
        bindingHealth: async () => ({ ok: true }),
        logout: async () => ({ ok: true }),
        bootstrapStatus: async () => ({ ok: true, required: false }),
        interactiveAuthority: async () => ({ url: "https://idp.example.invalid", realm: "fleet", clientId: "ha" }),
        begin: async () => ({}),
        complete: async () => ({}),
        beginDevice: async () => ({}),
        deviceApproval: async () => ({}),
        pollDevice: async () => ({}),
        requireAccessManagement: async () => {
          throw new Error("not used");
        },
        requireSession: async () => {
          throw new Error("not used");
        },
        serialize: async <T>(op: () => Promise<T>) => op(),
        configureAuthority: async <T>(op: () => Promise<T>) => op(),
        bootstrapAdmin: async () => ({ ok: true }),
        invite: async () => ({ ok: true }),
      };

      running = await startDaemon({
        userRoot,
        daemonId,
        endpoint,
        buildSupersessionEnabled: false,
        oidc: fakeOidc as unknown as Parameters<typeof startDaemon>[0]["oidc"],
        openCell: async (cellInput) => {
          const status = {
            repoId: cellInput.repoId,
            rootDir: cellInput.rootDir,
            mode: cellInput.mode,
            state: "attached" as const,
            generation: 1,
            queueDepth: 0,
            projectionWatermark: 1,
            ledgerRevision: 1,
            lastError: null,
            causeClass: null,
            recoveryMs: 0,
            materialization: null,
          };
          return {
            status: () => status,
            publishedStatus: () => status,
            statusCuts: () => null,
            read: async () => {
              signalRpcEntered();
              await rpcGate;
              return {
                ok: true,
                status: "ready",
                taskId: "task_demo",
                dispatches: [],
                outcome: "succeeded",
                exitCode: 0,
                watermark: 1,
                sourceRevision: 1,
              };
            },
            run: async () => ({ ok: true, schedules: [] }),
            settlePendingMaterialization: async () => undefined,
            close: async () => undefined,
          } as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof startDaemon>[0]["openCell"]>>>;
        },
        metrics: { bind: "127.0.0.1", port: 0, path: "/metrics", bearerToken: null },
      });
      assert.ok("stop" in running && running.metricsEndpoint);

      const peer = await rawPeer(
        (fn) => closers.push(fn),
        fleetPort,
        readFileSync(certPath),
        "edge-node-1",
        "machine-secret",
      );

      // Start one Fleet RPC and hold it in flight while scraping /metrics
      const inFlightPromise = peer.request({
        schema: "fleet.operational.read/v1",
        messageId: "inflight-read-1",
        repoId,
        method: "repo.task.dispatches",
        payload: { taskId: "task_demo" },
      });

      await rpcEntered;
      const whileInFlight = await (await fetch(running.metricsEndpoint)).text();
      assert.ok(
        whileInFlight.includes("ha_daemon_rpc_inflight 1\n"),
        `expected ha_daemon_rpc_inflight 1 while Fleet RPC is in flight, got:\n${whileInFlight}`,
      );

      releaseRpc();
      const response = await inFlightPromise;
      assert.equal(response.schema, "fleet.operational.read.result/v1");

      const afterSettled = await (await fetch(running.metricsEndpoint)).text();
      assert.ok(
        afterSettled.includes("ha_daemon_rpc_inflight 0\n"),
        `expected ha_daemon_rpc_inflight 0 after Fleet RPC settles, got:\n${afterSettled}`,
      );
      const okMatch = /ha_daemon_rpc_requests_total\{outcome="ok"\}\s+(\d+)/u.exec(afterSettled);
      assert.ok(okMatch && Number(okMatch[1]) >= 1, `expected ok RPC counter >= 1, got:\n${afterSettled}`);
    } finally {
      for (const close of closers.splice(0)) await close();
      if (running && "stop" in running) await running.stop();
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

test("probeSnapshot and /readyz report projections_unreadable when an attached RepoCell has projectionReadable=false, while /healthz stays live (F-G7-32)", async () => {
  let projectionReadable = false;
  let causeClass: "projection" | null = "projection";
  const maps = createTrackedRepoMaps();
  const fakeCell = {
    publishedStatus: () => ({
      repoId: "repo-proj",
      rootDir: "/tmp/repo-proj",
      mode: "local" as const,
      state: "attached" as const,
      projectionReadable,
      generation: 3,
      queueDepth: 0,
      projectionWatermark: 10,
      ledgerRevision: 10,
      recoveryMs: 0,
      materialization: null,
      lastError: projectionReadable ? null : "ProjectionIdentityMismatchError",
      causeClass,
    }),
    status: () => {
      throw new Error("probeSnapshot must read publishedStatus() without touching cell.status()");
    },
  };
  maps.cells.set("repo-proj", fakeCell as unknown as Parameters<typeof maps.cells.set>[1]);

  const lifecycle = createDaemonHostLifecycleApi({
    input: { daemonId: "proj-ready-test", userRoot: "/tmp/unused" },
    cells: maps.cells,
    warming: maps.warming,
    unavailable: maps.unavailable,
    sortedRepoIds: maps.sortedRepoIds,
    closing: false,
    initialAttachmentsSettled: () => true,
    fleetCenterRestoreFailed: () => false,
  } as unknown as Parameters<typeof createDaemonHostLifecycleApi>[0]);

  const server = await startDaemonMetricsServer({
    config: { bind: "127.0.0.1", port: 0, path: "/metrics", bearerToken: null },
    daemonId: "proj-ready-test",
    collectSnapshot: () => ({
      daemonId: "proj-ready-test",
      version: daemonPackageVersion({}),
      commit: "test",
      uptimeSeconds: 1,
      processResidentMemoryBytes: 1_000,
      processHeapUsedBytes: 500,
      activeRuntimeSessions: 0,
      rpc: createRpcMetricsAccumulator().snapshot(0),
      fleet: lifecycle.observabilitySnapshot().fleet,
      repos: lifecycle.observabilitySnapshot().repos,
    }),
    isLive: () => true,
    isReady: () => lifecycle.probeSnapshot(),
  });
  const origin = new URL(server.endpoint).origin;
  try {
    // Attached but projectionReadable === false -> /readyz 503 projections_unreadable, /healthz 200 live
    const unreadableReady = await fetch(`${origin}/readyz`);
    assert.equal(unreadableReady.status, 503);
    const unreadableBody = (await unreadableReady.json()) as { readonly ok: boolean; readonly reasons?: string[] };
    assert.equal(unreadableBody.ok, false);
    assert.deepEqual(unreadableBody.reasons, ["projections_unreadable"]);

    const liveRes = await fetch(`${origin}/healthz`);
    assert.equal(liveRes.status, 200);
    assert.equal(((await liveRes.json()) as { readonly status: string }).status, "live");

    // Once projection recovers (projectionReadable === true) -> /readyz returns 200 ready
    projectionReadable = true;
    causeClass = null;
    const recoveredReady = await fetch(`${origin}/readyz`);
    assert.equal(recoveredReady.status, 200);
    assert.equal(((await recoveredReady.json()) as { readonly status: string }).status, "ready");
  } finally {
    await server.close();
  }
});

test(
  "requiredStorageBackend=postgres rejects runtime repo register, init, and update missing PG config before writing SQLite while keeping local SQLite default (F-G7-30)",
  { timeout: 60_000 },
  async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "ha-pg-enforce-"));
    const pgUserRoot = path.join(sandbox, "pg-user");
    const defaultUserRoot = path.join(sandbox, "default-user");
    const repoB = path.join(sandbox, "repo-b");
    const repoInit = path.join(sandbox, "repo-init");
    const repoLocal = path.join(sandbox, "repo-local");
    mkdirSync(pgUserRoot, { recursive: true });
    mkdirSync(defaultUserRoot, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    mkdirSync(repoInit, { recursive: true });
    mkdirSync(repoLocal, { recursive: true });

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    };
    const initGitRepo = (dir: string) => {
      writeFileSync(path.join(dir, "README.md"), "# test\n");
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: gitEnv });
      execFileSync("git", ["add", "."], { cwd: dir, env: gitEnv });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: gitEnv });
    };
    initGitRepo(repoB);
    initGitRepo(repoInit);
    rosterRepo(repoLocal, "repo-local");

    let openCellCalls = 0;
    const pgHost = await openDaemonHost({
      daemonId: "pg-enforce-daemon",
      userRoot: pgUserRoot,
      requiredStorageBackend: "postgres",
      storage: {
        "repo-a": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
      },
      openCell: async () => {
        openCellCalls += 1;
        throw new Error("openCell must not be invoked for repositories lacking postgres storage config");
      },
    });
    const localHost = await openDaemonHost({
      daemonId: "local-default-daemon",
      userRoot: defaultUserRoot,
    });
    const localOwnerAuth = {
      transportKind: "unix-socket" as const,
      unixSocketOwnerBoundary: {
        ownerUid: process.getuid?.() ?? 0,
        source: "unix-socket-filesystem-owner-boundary" as const,
      },
    };
    try {
      // 1. daemon.repo.register for repo-b (missing from storage map) must fail BEFORE writing registry.json or opening SQLite
      await assert.rejects(
        () => pgHost.admin({ kind: "register", repoId: "repo-b", rootDir: repoB, mode: "local" }, localOwnerAuth),
        /requires a valid postgres entry in daemon-storage\.json/u,
      );
      assert.equal(openCellCalls, 0, "rejected register must never invoke openCell");
      assert.equal(
        readDaemonRegistry({ userRoot: pgUserRoot }).repos.some((r) => r.repoId === "repo-b"),
        false,
        "rejected register must not persist repo-b into registry.json",
      );
      assert.equal(existsSync(sqliteLedgerPath(repoB)), false, "rejected register must not create a SQLite ledger");

      // 2. init/bootstrap for repo-init (missing from storage map) must fail BEFORE opening SQLite or registering
      await assert.rejects(
        () =>
          pgHost.bootstrap({ rootDir: repoInit, repoId: "repo-init", displayName: "Center Operator" }, localOwnerAuth),
        /requires a valid postgres entry in daemon-storage\.json/u,
      );
      assert.equal(openCellCalls, 0, "rejected bootstrap must never invoke openCell");
      assert.equal(existsSync(sqliteLedgerPath(repoInit)), false, "rejected bootstrap must not create a SQLite ledger");

      // 3. remote-proxy register is still allowed under postgres enforcement, but switching it to local via update fails closed!
      const proxyReg = await pgHost.admin(
        { kind: "register", repoId: "repo-proxy", mode: "remote-proxy", endpoint: "tcp://127.0.0.1:7545" },
        localOwnerAuth,
      );
      assert.equal(proxyReg.ok, true);
      await assert.rejects(
        () => pgHost.admin({ kind: "update", repoId: "repo-proxy", mode: "local", rootDir: repoB }, localOwnerAuth),
        /requires a valid postgres entry in daemon-storage\.json/u,
      );

      // 4. Ordinary local daemon (no requiredStorageBackend) preserves default SQLite registration & attachment
      const localReg = await localHost.admin(
        { kind: "register", repoId: "repo-local", rootDir: repoLocal, mode: "local" },
        localOwnerAuth,
      );
      assert.equal(localReg.ok, true);
      assert.ok(
        localHost.observabilitySnapshot().repos.some((r) => r.repoId === "repo-local" && r.state === "attached"),
        "default local daemon without requiredStorageBackend must still attach SQLite repos normally",
      );
    } finally {
      await pgHost.close();
      await localHost.close();
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

test(
  "in-flight Fleet RPC metrics stay decoupled from local activeRequests so build_superseded drains once fleetDrainDeadlineMs expires (F-G7-39)",
  { timeout: 60_000 },
  async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "ha-fleet-drain-decouple-"));
    const userRoot = path.join(sandbox, "user");
    const repoRoot = path.join(sandbox, "repo");
    const keyPath = path.join(sandbox, "tls.key");
    const certPath = path.join(sandbox, "tls.crt");
    const repoId = "fleet-drain-repo";
    const daemonId = "fleet-drain-daemon";
    const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
    const closers: Array<() => unknown> = [];
    let running: Awaited<ReturnType<typeof startDaemon>> | undefined;
    let releaseRpc!: () => void;
    try {
      rosterRepo(repoRoot, repoId);
      registerBootstrappedDaemonRepo({ canonicalRoot: repoRoot, repoId, userRoot, createConvenienceLinks: false });
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-subj",
          "/CN=localhost",
          "-days",
          "1",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { stdio: "ignore" },
      );
      const probeServer = net.createServer();
      await new Promise<void>((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
      const fleetPort = (probeServer.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probeServer.close(() => resolve()));

      saveFleetCenterConfig(userRoot, daemonId, {
        port: fleetPort,
        bind: "127.0.0.1",
        repoId,
        keyPath,
        certPath,
        stateRoot: path.join(userRoot, "fleet"),
        quotaBytes: 1024 * 1024,
      });

      let drifted = false;
      const buildObserver = {
        status: () => ({
          entry: "runtime",
          startedBuildId: "build-a",
          diskBuildId: drifted ? "build-b" : "build-a",
          drifted,
          changedFiles: drifted ? ["runtime.js"] : [],
          commit: "test-commit",
        }),
      };

      const rpcEntered = Promise.withResolvers<void>();
      const rpcGate = Promise.withResolvers<void>();
      releaseRpc = rpcGate.resolve;
      const supersededExited = Promise.withResolvers<void>();

      const fakeOidc = {
        configured: () => true,
        centerConfigured: () => true,
        center: async () => ({
          url: "https://idp.example.invalid",
          realm: "fleet",
          accessToken: "center-tok",
          provider: {
            policyRef: "test-policy",
            authority: { url: "https://idp.example.invalid", realm: "fleet" },
            deniedReasonCode: "authorization_denied",
            authenticateNode: async () => true,
            readNode: async () => ({ state: "active", revocation: "complete", personId: "person-owner" }),
            validateUserAccessToken: async () => true,
            authorize: async () => ({ outcome: "allowed", reasonCode: "allowed" }),
            authorizePerson: async () => ({ outcome: "allowed", reasonCode: "allowed" }),
          },
        }),
        bind: async <T extends Record<string, unknown>>(auth: T) => ({
          ...auth,
          oidcPrincipal: {
            personId: "person-owner",
            accessToken: "human-tok",
            azp: "harness-cli",
            authority: { url: "https://idp.example.invalid", realm: "fleet" },
            provider: {
              policyRef: "test-policy",
              authority: { url: "https://idp.example.invalid", realm: "fleet" },
              deniedReasonCode: "authorization_denied",
              validateUserAccessToken: async () => true,
              authorize: async () => ({ outcome: "allowed", reasonCode: "allowed" }),
              authorizePerson: async () => ({ outcome: "allowed", reasonCode: "allowed" }),
            },
          },
        }),
        discovery: () => null,
        status: async () => ({ ok: true }),
        bindingHealth: async () => ({ ok: true }),
        logout: async () => ({ ok: true }),
        bootstrapStatus: async () => ({ ok: true, required: false }),
        interactiveAuthority: async () => ({ url: "https://idp.example.invalid", realm: "fleet", clientId: "ha" }),
        begin: async () => ({}),
        complete: async () => ({}),
        beginDevice: async () => ({}),
        deviceApproval: async () => ({}),
        pollDevice: async () => ({}),
        requireAccessManagement: async () => {
          throw new Error("not used");
        },
        requireSession: async () => {
          throw new Error("not used");
        },
        serialize: async <T>(op: () => Promise<T>) => op(),
        configureAuthority: async <T>(op: () => Promise<T>) => op(),
        bootstrapAdmin: async () => ({ ok: true }),
        invite: async () => ({ ok: true }),
      };

      running = await startDaemon({
        userRoot,
        daemonId,
        endpoint,
        buildObserver: buildObserver as unknown as Parameters<typeof startDaemon>[0]["buildObserver"],
        buildSupersessionEnabled: true,
        fleetDrainDeadlineMs: 150,
        onSupersededExit: () => {
          supersededExited.resolve();
        },
        oidc: fakeOidc as unknown as Parameters<typeof startDaemon>[0]["oidc"],
        openCell: async (cellInput) => {
          const status = {
            repoId: cellInput.repoId,
            rootDir: cellInput.rootDir,
            mode: cellInput.mode,
            state: "attached" as const,
            generation: 1,
            queueDepth: 0,
            projectionWatermark: 1,
            ledgerRevision: 1,
            lastError: null,
            causeClass: null,
            recoveryMs: 0,
            materialization: null,
          };
          return {
            status: () => status,
            publishedStatus: () => status,
            statusCuts: () => null,
            read: async () => {
              rpcEntered.resolve();
              await rpcGate.promise;
              return {
                ok: true,
                status: "ready",
                taskId: "task_stuck",
                dispatches: [],
                outcome: "succeeded",
                exitCode: 0,
                watermark: 1,
                sourceRevision: 1,
              };
            },
            run: async () => ({ ok: true, schedules: [] }),
            settlePendingMaterialization: async () => undefined,
            close: async () => undefined,
          } as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof startDaemon>[0]["openCell"]>>>;
        },
        metrics: { bind: "127.0.0.1", port: 0, path: "/metrics", bearerToken: null },
      });
      assert.ok("stop" in running && running.metricsEndpoint);

      const peer = await rawPeer(
        (fn) => closers.push(fn),
        fleetPort,
        readFileSync(certPath),
        "edge-node-stuck",
        "machine-secret",
      );
      const stuckFleetPromise = peer
        .request({
          schema: "fleet.operational.read/v1",
          messageId: "stuck-read-1",
          repoId,
          method: "repo.task.dispatches",
          payload: { taskId: "task_stuck" },
        })
        .catch(() => undefined);

      await rpcEntered.promise;
      const metricsWhileStuck = await (await fetch(running.metricsEndpoint)).text();
      assert.ok(
        metricsWhileStuck.includes("ha_daemon_rpc_inflight 1\n"),
        `expected ha_daemon_rpc_inflight 1 while Fleet RPC is stuck, got:\n${metricsWhileStuck}`,
      );

      // Observe build drift via a fast local Unix JSON-RPC call -> local activeRequests returns to 0,
      // pendingWrites=0, attachingRepositories=0, while the Fleet RPC remains stuck indefinitely!
      drifted = true;
      await requestDaemonJsonRpcAt(endpoint, "daemon.status", {});

      // Must supersede and exit promptly once fleetDrainDeadlineMs (150ms) elapses despite stuck Fleet RPC!
      await supersededExited.promise;
      await peer.closed;
      const records = readDaemonLifecycleRecords(userRoot, daemonId);
      assert.ok(
        records.some((entry) => entry.event === "process_exit" && entry.outcome === "build_superseded"),
        `expected build_superseded process_exit record, got ${JSON.stringify(records)}`,
      );
      releaseRpc();
      void stuckFleetPromise;
    } finally {
      releaseRpc?.();
      for (const close of closers.splice(0)) await close();
      if (running && "stop" in running) await running.stop();
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

test(
  "PVC-mounted Fleet center preserves resumable upload state.json and staged claim across Pod A -> Pod B replacement (F-G7-35)",
  { timeout: 60_000 },
  async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "ha-fleet-pvc-pod-replace-"));
    const pvcRoot = path.join(sandbox, "pvc-daemon-state");
    const pvcAuthorityRepo = path.join(pvcRoot, "authority-repo");
    const pod1Ephemeral = path.join(sandbox, "pod-1-rootfs");
    const keyPath = path.join(sandbox, "tls.key");
    const certPath = path.join(sandbox, "tls.crt");
    const repoId = "pvc-fleet-center";
    const daemonId = "center";
    const closers: Array<() => unknown> = [];
    mkdirSync(pvcRoot, { recursive: true });
    mkdirSync(pvcAuthorityRepo, { recursive: true });
    mkdirSync(pod1Ephemeral, { recursive: true });
    try {
      rosterRepo(pvcAuthorityRepo, repoId);
      registerBootstrappedDaemonRepo({
        canonicalRoot: pvcAuthorityRepo,
        repoId,
        userRoot: pvcRoot,
        createConvenienceLinks: false,
      });
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-subj",
          "/CN=localhost",
          "-days",
          "1",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { stdio: "ignore" },
      );
      const allocPort = async (): Promise<number> => {
        const probeServer = net.createServer();
        await new Promise<void>((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
        const port = (probeServer.address() as net.AddressInfo).port;
        await new Promise<void>((resolve) => probeServer.close(() => resolve()));
        return port;
      };
      const fakeOidc = {
        configured: () => true,
        centerConfigured: () => true,
        center: async () => ({
          url: "https://idp.example.invalid",
          realm: "fleet",
          accessToken: "center-tok",
          provider: {
            policyRef: "test-policy",
            authority: { url: "https://idp.example.invalid", realm: "fleet" },
            deniedReasonCode: "authorization_denied",
            authenticateNode: async () => true,
            readNode: async () => ({ state: "active", revocation: "complete", personId: "person-owner" }),
            validateUserAccessToken: async () => true,
            authorize: async () => ({ outcome: "allowed", reasonCode: "allowed" }),
            authorizePerson: async () => ({ outcome: "allowed", reasonCode: "allowed" }),
          },
        }),
        bind: async <T extends Record<string, unknown>>(auth: T) => ({
          ...auth,
          oidcPrincipal: {
            personId: "person-owner",
            accessToken: "human-tok",
            azp: "harness-cli",
            authority: { url: "https://idp.example.invalid", realm: "fleet" },
            provider: {
              policyRef: "test-policy",
              authority: { url: "https://idp.example.invalid", realm: "fleet" },
              deniedReasonCode: "authorization_denied",
              validateUserAccessToken: async () => true,
              authorize: async () => ({ outcome: "allowed", reasonCode: "allowed" }),
              authorizePerson: async () => ({ outcome: "allowed", reasonCode: "allowed" }),
            },
          },
        }),
        discovery: () => null,
        status: async () => ({ ok: true }),
        bindingHealth: async () => ({ ok: true }),
        logout: async () => ({ ok: true }),
        bootstrapStatus: async () => ({ ok: true, required: false }),
        interactiveAuthority: async () => ({ url: "https://idp.example.invalid", realm: "fleet", clientId: "ha" }),
        begin: async () => ({}),
        complete: async () => ({}),
        beginDevice: async () => ({}),
        deviceApproval: async () => ({}),
        pollDevice: async () => ({}),
        requireAccessManagement: async () => {
          throw new Error("not used");
        },
        requireSession: async () => {
          throw new Error("not used");
        },
        serialize: async <T>(op: () => Promise<T>) => op(),
        configureAuthority: async <T>(op: () => Promise<T>) => op(),
        bootstrapAdmin: async () => ({ ok: true }),
        invite: async () => ({ ok: true }),
      };

      const fullPayload = Buffer.from("pod-a-prefix-bytes|pod-b-suffix-bytes\n", "utf8");
      const firstHalf = fullPayload.subarray(0, 19);
      const secondHalf = fullPayload.subarray(19);
      const payloadSha256 = createHash("sha256").update(fullPayload).digest("hex");

      const openAttachedCell: NonNullable<Parameters<typeof startDaemon>[0]["openCell"]> = async (cellInput) => {
        const status = {
          repoId: cellInput.repoId,
          rootDir: cellInput.rootDir,
          mode: cellInput.mode,
          state: "attached" as const,
          generation: 1,
          queueDepth: 0,
          projectionWatermark: 1,
          ledgerRevision: 1,
          lastError: null,
          causeClass: null,
          recoveryMs: 0,
          materialization: null,
        };
        return {
          status: () => status,
          publishedStatus: () => status,
          statusCuts: () => null,
          read: async () => ({ ok: true }),
          run: async () => ({ ok: true, schedules: [] }),
          settlePendingMaterialization: async () => undefined,
          close: async () => undefined,
        } as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof startDaemon>[0]["openCell"]>>>;
      };

      // Pod A: boots on PVC root (daemon.userRoot) + authority-repo subPath, starts upload and persists chunk 1
      const portA = await allocPort();
      saveFleetCenterConfig(pvcRoot, daemonId, {
        port: portA,
        bind: "127.0.0.1",
        repoId,
        keyPath,
        certPath,
        stateRoot: path.join(pvcRoot, "fleet"),
        quotaBytes: 1024 * 1024,
      });
      const podA = await startDaemon({
        userRoot: pvcRoot,
        daemonId,
        endpoint: localUserDaemonEndpoint(pvcRoot, daemonId),
        buildSupersessionEnabled: false,
        oidc: fakeOidc as unknown as Parameters<typeof startDaemon>[0]["oidc"],
        openCell: openAttachedCell,
        metrics: null,
      });
      assert.ok("stop" in podA);
      let uploadId = "";
      try {
        const peerA = await rawPeer(
          (fn) => closers.push(fn),
          portA,
          readFileSync(certPath),
          "edge-pod-replace",
          "machine-secret",
        );
        const beginRes = await peerA.request({
          schema: "fleet.upload.begin/v1",
          messageId: "upload-begin-1",
          repoId,
          opId: "op-pod-replace-upload-1",
          content: { sha256: payloadSha256, size: fullPayload.byteLength, mediaType: "text/plain" },
        });
        assert.equal(
          beginRes.schema,
          "fleet.upload.ready/v1",
          `unexpected begin response: ${JSON.stringify(beginRes)}`,
        );
        uploadId = String(beginRes.uploadId ?? "");
        assert.ok(uploadId.length > 0);
        const chunk1Res = await peerA.request({
          schema: "fleet.upload.chunk/v1",
          messageId: "upload-chunk-1",
          opId: "op-pod-replace-upload-1",
          uploadId,
          offset: 0,
          dataBase64: firstHalf.toString("base64"),
        });
        assert.equal(chunk1Res.schema, "fleet.upload.ready/v1");
        assert.equal(chunk1Res.resumeOffset, firstHalf.byteLength);
      } finally {
        for (const close of closers.splice(0)) await close();
        await podA.stop();
      }

      // Destroy Pod A ephemeral rootfs; Pod B mounts ONLY the same PVC (pvcRoot + pvcRoot/authority-repo)
      rmSync(pod1Ephemeral, { recursive: true, force: true });
      assert.equal(
        existsSync(path.join(pvcRoot, "fleet", "state.json")),
        true,
        "PVC root must persist <userRoot>/fleet/state.json across Pod replacement",
      );

      const portB = await allocPort();
      saveFleetCenterConfig(pvcRoot, daemonId, {
        port: portB,
        bind: "127.0.0.1",
        repoId,
        keyPath,
        certPath,
        stateRoot: path.join(pvcRoot, "fleet"),
        quotaBytes: 1024 * 1024,
      });
      const podB = await startDaemon({
        userRoot: pvcRoot,
        daemonId,
        endpoint: localUserDaemonEndpoint(pvcRoot, daemonId),
        buildSupersessionEnabled: false,
        oidc: fakeOidc as unknown as Parameters<typeof startDaemon>[0]["oidc"],
        openCell: openAttachedCell,
        metrics: null,
      });
      assert.ok("stop" in podB);
      try {
        const peerB = await rawPeer(
          (fn) => closers.push(fn),
          portB,
          readFileSync(certPath),
          "edge-pod-replace",
          "machine-secret",
        );
        // Resume on Pod B: must report exact resumeOffset from Pod A's durable prefix!
        const resumeRes = await peerB.request({
          schema: "fleet.upload.begin/v1",
          messageId: "upload-begin-resume",
          repoId,
          opId: "op-pod-replace-upload-1",
          content: { sha256: payloadSha256, size: fullPayload.byteLength, mediaType: "text/plain" },
        });
        assert.equal(
          resumeRes.schema,
          "fleet.upload.ready/v1",
          `unexpected resume response: ${JSON.stringify(resumeRes)}`,
        );
        assert.equal(resumeRes.uploadId, uploadId);
        assert.equal(
          resumeRes.resumeOffset,
          firstHalf.byteLength,
          "Pod B must resume from Pod A's persisted upload prefix",
        );
        const chunk2Res = await peerB.request({
          schema: "fleet.upload.chunk/v1",
          messageId: "upload-chunk-2",
          opId: "op-pod-replace-upload-1",
          uploadId,
          offset: firstHalf.byteLength,
          dataBase64: secondHalf.toString("base64"),
        });
        assert.equal(chunk2Res.schema, "fleet.upload.ready/v1");
        assert.equal(chunk2Res.resumeOffset, fullPayload.byteLength);
        const finishRes = await peerB.request({
          schema: "fleet.upload.finish/v1",
          messageId: "upload-finish-1",
          opId: "op-pod-replace-upload-1",
          uploadId,
        });
        assert.equal(
          finishRes.schema,
          "fleet.upload.result/v1",
          `Pod B must stage upload initiated on Pod A (not upload_unknown), got ${JSON.stringify(finishRes)}`,
        );
        assert.equal(finishRes.status, "staged");
        assert.equal((finishRes.descriptor as { readonly sha256?: string } | undefined)?.sha256, payloadSha256);
        assert.equal(
          existsSync(path.join(pvcAuthorityRepo, ".harness", "doc-sync-claims", uploadId)),
          true,
          "staged upload claim must be persisted inside PVC authority-repo subPath",
        );
      } finally {
        for (const close of closers.splice(0)) await close();
        await podB.stop();
      }
    } finally {
      for (const close of closers.splice(0)) await close();
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);
