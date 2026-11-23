// harness-test-tier: contract
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDaemonHostLifecycleApi,
  instrumentTrackedRepoMaps,
} from "../src/daemon-host/daemon-host-lifecycle-api.ts";
import { fleetEdgeConfigPath } from "../src/daemon-host/client/fleet-edge-config.ts";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";
import { openRepoCellProxy } from "../src/daemon-host/repo-cell-proxy.ts";
import { resolveDaemonMetricsConfig } from "../src/daemon-host/metrics-http-server.ts";
import { startDaemon } from "../src/daemon-host/runtime.ts";
import type { RepoCell, RepoCellStatus } from "../src/daemon-host/repo-cell-types.ts";
import { recordReplicaHealth } from "../src/fleet-sync/fleet/replica-health.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function makeAttachedStatus(repoId: string, queueDepth: number, lag = 0): RepoCellStatus {
  return {
    repoId,
    rootDir: `/virtual/${repoId}`,
    mode: "local",
    state: "attached",
    generation: 1,
    queueDepth,
    projectionWatermark: 1000 - lag,
    ledgerRevision: 1000,
    lastError: null,
    causeClass: null,
    recoveryMs: 0,
    materialization: null,
  };
}

test("F-G7-46: instrumentTrackedRepoMaps performs strict O(1) single-entry updates with zero array copies across 10/100/1000 repos", () => {
  for (const repoCount of [10, 100, 1000]) {
    let copiedRepoRefs = 0;
    const origSlice = Array.prototype.slice;
    Array.prototype.slice = function (...args: unknown[]) {
      const first = (this as unknown[])[0];
      if (
        first &&
        typeof first === "object" &&
        "repoId" in first &&
        typeof (first as { repoId?: unknown }).repoId === "string" &&
        (first as { repoId: string }).repoId.startsWith("repo-")
      ) {
        copiedRepoRefs += this.length;
      }
      return origSlice.apply(this, args as [number?, number?]);
    };

    try {
      const cells = new Map<string, RepoCell>();
      const warming = new Map<string, RepoCellStatus>();
      const unavailable = new Map<string, RepoCellStatus>();
      const tracker = instrumentTrackedRepoMaps({ cells, warming, unavailable });

      for (let index = 0; index < repoCount; index += 1) {
        const repoId = `repo-${String(index).padStart(4, "0")}`;
        const initial = makeAttachedStatus(repoId, 0, index % 5);
        cells.set(repoId, {
          publishedStatus: () => initial,
          status: () => initial,
        } as unknown as RepoCell);
      }
      assert.equal(
        copiedRepoRefs,
        0,
        `initializing ${repoCount} repos must copy 0 array references (no O(R^2) copy-on-write)`,
      );

      // Update a single repo's queue depth and max lag (up and down) -> strict O(1), 0 array copies, 0 full scans
      tracker.publishRepoStatus("repo-0000", makeAttachedStatus("repo-0000", 5, 500));
      tracker.publishRepoStatus("repo-0000", makeAttachedStatus("repo-0000", 1, 0));
      assert.equal(
        copiedRepoRefs,
        0,
        `updating one repo among ${repoCount} repos must copy 0 array references on the writer hot path`,
      );

      const snapshot = tracker.snapshot();
      assert.equal(snapshot.repos.length, repoCount);
      assert.equal(snapshot.aggregates.stateCounts.attached, repoCount);
      assert.equal(snapshot.aggregates.totalQueueDepth, 1);
      assert.equal(snapshot.aggregates.maxProjectionLag, 4);
      assert.equal(snapshot.repos[0]?.repoId, "repo-0000");
      assert.equal(snapshot.repos[0]?.queueDepth, 1);
    } finally {
      Array.prototype.slice = origSlice;
    }
  }
});

test("F-G7-46 & F-G7-48(a): health-only mode (HARNESS_DAEMON_METRICS_EXPOSED=0) keeps /healthz & /readyz active while disabling /metrics and metrics instrumentation", async () => {
  const parsed = resolveDaemonMetricsConfig({
    HARNESS_DAEMON_METRICS_PORT: "9090",
    HARNESS_DAEMON_METRICS_BIND: "0.0.0.0",
    HARNESS_DAEMON_METRICS_EXPOSED: "0",
  });
  assert.deepEqual(parsed, {
    bind: "0.0.0.0",
    port: 9090,
    path: "/metrics",
    bearerToken: null,
    exposeMetrics: false,
  });

  // F-G7-46: When metrics are disabled (or exposeMetrics=false), openDaemonHost must NOT pass onMetricsStatus to openCell
  const probeRoot = mkdtempSync(path.join(tmpdir(), "ha-metrics-disabled-gate-"));
  const repoDir = path.join(probeRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(
    path.join(probeRoot, "registry.json"),
    JSON.stringify({
      schema: "harness-daemon-registry/v2",
      connections: [{ id: "local", kind: "local", displayName: "Local daemon", state: "enabled" }],
      repos: [
        {
          repoId: "disabled-metrics-repo",
          canonicalRoot: repoDir,
          displayName: "disabled-metrics-repo",
          authoredBranch: null,
          mode: "local",
          connectionId: "local",
          state: "enabled",
          registeredAt: "2026-11-21T00:00:00.000Z",
        },
      ],
    }),
  );
  const observedOnMetricsStatus = Promise.withResolvers<unknown>();
  const disabledDaemon = await startDaemon({
    userRoot: probeRoot,
    daemonId: "metrics-disabled-gate",
    endpoint: localUserDaemonEndpoint(probeRoot, "metrics-disabled-gate"),
    buildSupersessionEnabled: false,
    metrics: null,
    openCell: async (cellInput) => {
      observedOnMetricsStatus.resolve(cellInput.onMetricsStatus);
      return {
        status: () => makeAttachedStatus("disabled-metrics-repo", 0),
        publishedStatus: () => makeAttachedStatus("disabled-metrics-repo", 0),
        statusCuts: () => ({ projectionWatermark: 1000, ledgerRevision: 1000 }),
        run: async () => ({ outcome: "ok", schedules: [] }),
        read: async () => ({ schedules: [] }),
        close: async () => undefined,
      } as unknown as RepoCell;
    },
  });
  try {
    assert.ok("stop" in disabledDaemon);
    assert.equal(
      await observedOnMetricsStatus.promise,
      undefined,
      "openDaemonHost must not wire onMetricsStatus hot-path callbacks when metrics are disabled",
    );
  } finally {
    if ("stop" in disabledDaemon) await disabledDaemon.stop();
    removeTempRepository(probeRoot);
  }

  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-health-only-daemon-"));
  const daemonId = "health-only-test";
  const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
  const running = await startDaemon({
    userRoot,
    daemonId,
    endpoint,
    buildSupersessionEnabled: false,
    requireIdentityReady: true,
    metrics: { bind: "127.0.0.1", port: 0, path: "/metrics", bearerToken: null, exposeMetrics: false },
  });
  try {
    assert.ok("stop" in running, "daemon should acquire singleton");
    assert.equal(running.metricsEndpoint, undefined, "metricsEndpoint must be omitted when exposeMetrics=false");
    assert.ok(running.probeEndpoint, "probeEndpoint must remain active when exposeMetrics=false");

    const origin = new URL(running.probeEndpoint).origin;
    const healthz = await fetch(`${origin}/healthz`);
    assert.equal(healthz.status, 200);
    assert.equal(((await healthz.json()) as { status: string }).status, "live");

    // Required identity is unconfigured, so /readyz MUST stay 503 even with metrics scraping disabled!
    const readyz = await fetch(`${origin}/readyz`);
    assert.equal(readyz.status, 503);
    const readyBody = (await readyz.json()) as { ok: boolean; reasons?: string[] };
    assert.equal(readyBody.ok, false);
    assert.ok(readyBody.reasons?.includes("identity_not_configured"));

    // /metrics endpoint must return 404 when exposeMetrics=false
    const metricsRes = await fetch(`${origin}/metrics`);
    assert.equal(metricsRes.status, 404);
  } finally {
    if ("stop" in running) await running.stop();
    removeTempRepository(userRoot);
  }
});

test("F-G7-47: replica-only Edge publishes bidirectional unavailable <-> ready transitions to tracked metrics & /readyz without daemon.status RPC or scrape disk reads", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-edge-bidirectional-"));
  const userRoot = path.join(sandbox, "user");
  const repoRoot = path.join(sandbox, "repo");
  const viewRoot = path.join(sandbox, "views");
  const repoId = "edge-live-repo";
  const nodeId = "edge-node-live";
  const viewDir = path.join(viewRoot, "repos", repoId, "views", nodeId);
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(viewDir, { recursive: true });

  const edgeCfgPath = fleetEdgeConfigPath(userRoot, repoId);
  mkdirSync(path.dirname(edgeCfgPath), { recursive: true });
  writeFileSync(
    edgeCfgPath,
    JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId,
      host: "127.0.0.1",
      port: 7545,
      nodeId,
      credential: "dummy-cred",
      caPath: path.join(sandbox, "ca.pem"),
      viewRoot,
      quotaBytes: 1024 * 1024,
    }),
  );

  const cells = new Map<string, RepoCell>();
  const warming = new Map<string, RepoCellStatus>();
  const unavailable = new Map<string, RepoCellStatus>();
  const tracker = instrumentTrackedRepoMaps({ cells, warming, unavailable });
  const lifecycle = createDaemonHostLifecycleApi({
    input: { userRoot, daemonId: "edge-bidirectional" },
    cells,
    warming,
    unavailable,
    sortedRepoIds: tracker.sortedRepoIds,
    publishRepoStatus: tracker.publishRepoStatus,
    closing: false,
    initialAttachmentsSettled: () => true,
  } as unknown as Parameters<typeof createDaemonHostLifecycleApi>[0]);

  const edgeCell = await openRepoCellProxy(
    {
      repoId,
      rootDir: repoRoot,
      userRoot,
      ownerId: "edge-bidirectional",
      mode: "remote-edge",
      onMetricsStatus: (status) => tracker.publishRepoStatus(repoId, status),
    },
    {
      createWriterWorker: () => {
        throw new Error("simulated edge writer attach failure");
      },
    },
  );
  cells.set(repoId, edgeCell);

  const assertZeroFsDuringObserve = (): {
    readonly snap: ReturnType<typeof lifecycle.observabilitySnapshot>;
    readonly probe: ReturnType<typeof lifecycle.probeSnapshot>;
  } => {
    const fsCalls: string[] = [];
    const origRead = fs.readFileSync;
    const origExists = fs.existsSync;
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      fsCalls.push(`readFileSync:${String(args[0])}`);
      return origRead(...args);
    }) as typeof fs.readFileSync;
    fs.existsSync = ((...args: Parameters<typeof fs.existsSync>) => {
      fsCalls.push(`existsSync:${String(args[0])}`);
      return origExists(...args);
    }) as typeof fs.existsSync;
    syncBuiltinESMExports();
    try {
      const snap = lifecycle.observabilitySnapshot();
      const probe = lifecycle.probeSnapshot();
      assert.deepEqual(fsCalls, [], "observabilitySnapshot and probeSnapshot must perform 0 disk reads");
      return { snap, probe };
    } finally {
      fs.readFileSync = origRead;
      fs.existsSync = origExists;
      syncBuiltinESMExports();
    }
  };

  try {
    // 1. Initial state (no replica generation installed yet): unavailable in both /metrics and /readyz
    let observed = assertZeroFsDuringObserve();
    assert.equal(observed.snap.repoAggregates.stateCounts.unavailable, 1);
    assert.equal(observed.snap.repoAggregates.stateCounts.attached, 0);
    assert.equal(observed.probe.ready, false);
    assert.ok(observed.probe.reasons.includes("repos_unavailable"));

    // 2. Replica generation installs on disk & replica sync triggers refreshReplicaStatus (no daemon.status RPC!):
    const genDir = path.join(viewDir, "generations", "gen-1");
    mkdirSync(genDir, { recursive: true });
    writeFileSync(
      path.join(viewDir, "current.json"),
      JSON.stringify({
        id: "gen-1",
        metadata: {
          schema: "fleet-basebackup/v3",
          repoId,
          ledgerGeneration: 1,
          position: { history: "h1", sequence: 10 },
          createdAt: "2026-11-21T00:00:00.000Z",
        },
      }),
    );
    assert.ok(edgeCell.refreshReplicaStatus, "replica-only cell must expose refreshReplicaStatus");
    edgeCell.refreshReplicaStatus();

    observed = assertZeroFsDuringObserve();
    assert.equal(observed.snap.repoAggregates.stateCounts.attached, 1);
    assert.equal(observed.snap.repoAggregates.stateCounts.unavailable, 0);
    assert.equal(observed.snap.repos[0]?.state, "attached");
    assert.equal(observed.probe.ready, true);

    // 3. Model becomes unreadable via recordReplicaHealth -> automatically flips back to unavailable (no daemon.status RPC!)
    recordReplicaHealth(viewDir, {
      modelFailure: { code: "replica_model_corrupt", message: "projection database unreadable" },
    });
    observed = assertZeroFsDuringObserve();
    assert.equal(observed.snap.repoAggregates.stateCounts.unavailable, 1);
    assert.equal(observed.snap.repoAggregates.stateCounts.attached, 0);
    assert.equal(observed.snap.repos[0]?.state, "unavailable");
    assert.equal(observed.probe.ready, false);
    assert.ok(observed.probe.reasons.includes("repos_unavailable"));

    // 4. Model heals -> recordReplicaHealth clears modelFailure -> automatically recovers to ready/attached!
    recordReplicaHealth(viewDir, { modelFailure: null });
    observed = assertZeroFsDuringObserve();
    assert.equal(observed.snap.repoAggregates.stateCounts.attached, 1);
    assert.equal(observed.snap.repoAggregates.stateCounts.unavailable, 0);
    assert.equal(observed.probe.ready, true);

    // 5. Replica pointer revoked + onRevoked refresh -> transitions back to unavailable!
    rmSync(path.join(viewDir, "current.json"), { force: true });
    edgeCell.refreshReplicaStatus();
    observed = assertZeroFsDuringObserve();
    assert.equal(observed.snap.repoAggregates.stateCounts.unavailable, 1);
    assert.equal(observed.snap.repoAggregates.stateCounts.attached, 0);
    assert.equal(observed.probe.ready, false);
  } finally {
    await edgeCell.close();
    removeTempRepository(sandbox);
  }
});
