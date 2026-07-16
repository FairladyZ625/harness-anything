import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectDaemonStatusForRenderer,
  type DaemonStatusResultV2
} from "../../application/src/index.ts";
import {
  createGuiServiceBridgeForDaemon,
  projectDaemonStatusResult
} from "../src/api/service-bridge.ts";
import { readDaemonStatusResult } from "../src/renderer/api-client.ts";
import {
  daemonRepoRows
} from "../src/renderer/model/daemon-status.ts";
import {
  DAEMON_STATUS_ACTIVE_CONTROL_RAW,
  DAEMON_STATUS_HEALTHY_TWO_REPO_RAW,
  DAEMON_STATUS_STALE_UNAVAILABLE_RAW,
  DaemonStatusUnreachableError,
  loadDaemonStatusFixture,
  setDaemonStatusFixtureKind
} from "../src/renderer/model/daemon-status-fixture.ts";

afterEach(() => {
  setDaemonStatusFixtureKind("healthy-two-repo");
});

const CANONICAL_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../daemon/fixtures/api-schemas/daemon.status-result__v2/valid.json"
);

function loadCanonicalDaemonStatus(): DaemonStatusResultV2 {
  return JSON.parse(readFileSync(CANONICAL_FIXTURE_PATH, "utf8")) as DaemonStatusResultV2;
}

describe("readDaemonStatusResult", () => {
  it("accepts the projected healthy two-repo fixture", () => {
    const status = readDaemonStatusResult(DAEMON_STATUS_HEALTHY_TWO_REPO_RAW);
    expect(status.schema).toBe("daemon-status/v2");
    expect(status.service.started).toBe(true);
    expect(status.service.daemonId).toBe("ha-user-501");
    expect(status.service.pid).toBe(41001);
    expect(status.service.queue.depth).toBe(1);
    expect(status.service.connections).toEqual({ active: 2, total: 17 });
    expect(status.service.uptimeMs).toBe(1_800_000);
    expect(status.service.build.stale).toBe(false);
    expect(status.service.build.version).toBe("0.1.0");
    expect(status.service.repoCount).toBe(2);
    expect(status.service.attachedCount).toBe(2);
    expect(status.service.unavailableCount).toBe(0);
    expect(status.service.activeControl).toBeNull();
    expect(status.service.lastReconcileError).toBeNull();
    expect(status.repos).toHaveLength(2);
    expect(status.requestedRepo.repoId).toBe("canonical");
    expect(status.repos[0]?.state).toBe("attached");
    expect(status.repos[0]?.queue.depth).toBe(1);
    expect(status.repos[0]?.lock.path).toBe(".harness/journal/global.lock");
    expect(status.repos[1]?.queue.depth).toBe(0);
  });

  it("parses the stale/unavailable fixture and surfaces build.stale + unavailable state", () => {
    const status = readDaemonStatusResult(DAEMON_STATUS_STALE_UNAVAILABLE_RAW);
    expect(status.service.build.stale).toBe(true);
    expect(status.service.build.loadedIdentity).not.toBe(
      status.service.build.installedIdentity
    );
    expect(status.service.unavailableCount).toBe(1);
    expect(status.service.attachedCount).toBe(1);
    expect(status.service.lastReconcileError?.code).toBe("repo_reconcile_failed");
    expect(status.service.lastReconcileError?.message).toMatch(/unavailable/i);
    expect(status.repos).toHaveLength(2);
    const unavailable = status.repos.find((r) => r.repoId === "experiment");
    expect(unavailable?.state).toBe("unavailable");
    expect(unavailable?.lastError).toBe("global lock already held");
    expect(unavailable?.lock.path).toBeNull();
    expect(unavailable?.queue.depth).toBe(0);
    expect(unavailable?.lastReconcileError?.message).toBe("global lock already held");
  });

  it("parses activeControl when present", () => {
    const status = readDaemonStatusResult(DAEMON_STATUS_ACTIVE_CONTROL_RAW);
    expect(status.service.activeControl).toEqual({
      operationId: "control_01KXN0RESTART",
      kind: "restart",
      phase: "draining",
      requestedAt: "2026-07-16T08:30:00.000Z"
    });
  });

  it("throws on malformed input", () => {
    expect(() => readDaemonStatusResult(null)).toThrow(/invalid result/i);
    expect(() => readDaemonStatusResult({ schema: "wrong" })).toThrow(/schema/i);
    expect(() => readDaemonStatusResult({ schema: "daemon-status/v1" })).toThrow(/schema/i);
    expect(() =>
      readDaemonStatusResult({
        schema: "daemon-status/v2",
        // missing service
        requestedRepo: DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.requestedRepo,
        repos: []
      })
    ).toThrow(/service/i);
    expect(() =>
      readDaemonStatusResult({
        schema: "daemon-status/v2",
        service: DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.service
        // missing repos
      })
    ).toThrow(/repos/i);
  });
});

describe("daemonRepoRows", () => {
  it("returns repos[] from the status payload", () => {
    const status = readDaemonStatusResult(DAEMON_STATUS_HEALTHY_TWO_REPO_RAW);
    const rows = daemonRepoRows(status);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.repoId)).toEqual(["canonical", "experiment"]);
    expect(rows[0]?.queue.depth).toBe(1);
    expect(rows[1]?.queue.depth).toBe(0);
  });

  it("surfaces unavailable rows from the stale fixture", () => {
    const status = readDaemonStatusResult(DAEMON_STATUS_STALE_UNAVAILABLE_RAW);
    const rows = daemonRepoRows(status);
    expect(rows.map((r) => r.state)).toEqual(["attached", "unavailable"]);
  });
});

describe("loadDaemonStatusFixture", () => {
  it("loads the healthy two-repo fixture by default", async () => {
    const status = await loadDaemonStatusFixture();
    expect(status.service.started).toBe(true);
    expect(status.repos).toHaveLength(2);
    expect(status.service.queue.depth).toBe(1);
  });

  it("can flip to the stale/unavailable fixture for tests", async () => {
    setDaemonStatusFixtureKind("stale-unavailable");
    const status = await loadDaemonStatusFixture();
    expect(status.service.build.stale).toBe(true);
    expect(status.service.unavailableCount).toBe(1);
  });

  it("can flip to the active-control fixture for tests", async () => {
    setDaemonStatusFixtureKind("active-control");
    const status = await loadDaemonStatusFixture();
    expect(status.service.activeControl?.kind).toBe("restart");
    expect(status.service.activeControl?.phase).toBe("draining");
  });

  it("throws on the unreachable fixture path", async () => {
    setDaemonStatusFixtureKind("unreachable");
    await expect(loadDaemonStatusFixture()).rejects.toBeInstanceOf(
      DaemonStatusUnreachableError
    );
  });
});

describe("projectDaemonStatusForRenderer", () => {
  it("strips lock-owner identity from the canonical fixture", () => {
    const canonical = loadCanonicalDaemonStatus();
    expect(canonical.requestedRepo.lock).toHaveProperty(
      // literal used only outside renderer for the negative assertion
      "ownerToken"
    );
    const projected = projectDaemonStatusForRenderer(canonical);
    expect(projected.requestedRepo.lock).toEqual({
      path: ".harness/journal/global.lock"
    });
    expect(Object.keys(projected.requestedRepo.lock)).toEqual(["path"]);
    for (const repo of projected.repos) {
      expect(Object.keys(repo.lock)).toEqual(["path"]);
    }
  });

  it("matches the renderer healthy fixture for lock paths and repo ids", () => {
    const projected = projectDaemonStatusForRenderer(loadCanonicalDaemonStatus());
    const status = readDaemonStatusResult(DAEMON_STATUS_HEALTHY_TWO_REPO_RAW);
    expect(status.repos.map((r) => r.repoId)).toEqual(
      projected.repos.map((r) => r.repoId)
    );
    expect(status.repos.map((r) => r.lock.path)).toEqual(
      projected.repos.map((r) => r.lock.path)
    );
    expect(status.service.queue.depth).toBe(projected.service.queue.depth);
  });
});

describe("bridge output carries no lock owner identity across IPC", () => {
  it("projectDaemonStatusResult serializes without owner identity", () => {
    const canonical = loadCanonicalDaemonStatus();
    // Prove the wire fixture still carries owner identity before projection.
    const wireSerialized = JSON.stringify(canonical);
    expect(wireSerialized.includes("ownerToken")).toBe(true);

    const projected = projectDaemonStatusResult(canonical);
    const serialized = JSON.stringify(projected);
    expect(serialized.includes("ownerToken")).toBe(false);
    expect(serialized).not.toMatch(/lock-canonical|lock-experiment/);
  });

  it("getDaemonStatus proxy path projects before returning across the bridge", async () => {
    const canonical = loadCanonicalDaemonStatus();
    const bridge = createGuiServiceBridgeForDaemon(async (route) => {
      expect(route.id).toBe("daemon.status");
      return {
        ok: true,
        details: { data: canonical as unknown as Record<string, unknown> }
      };
    });

    const result = await bridge.invoke("getDaemonStatus", null);
    const serialized = JSON.stringify(result);
    expect(serialized.includes("ownerToken")).toBe(false);
    expect(serialized).not.toMatch(/lock-canonical|lock-experiment/);

    const status = readDaemonStatusResult(result);
    expect(status.schema).toBe("daemon-status/v2");
    expect(status.service.queue.depth).toBe(1);
    expect(status.repos[0]?.lock).toEqual({ path: ".harness/journal/global.lock" });
    expect(Object.keys(status.repos[0]!.lock)).toEqual(["path"]);
  });
});
