import { afterEach, describe, expect, it } from "vitest";
import {
  daemonRepoRows,
  readDaemonStatus,
} from "../src/renderer/model/daemon-status.ts";
import {
  DAEMON_STATUS_ACTIVE_CONTROL_RAW,
  DAEMON_STATUS_HEALTHY_TWO_REPO_RAW,
  DAEMON_STATUS_STALE_UNAVAILABLE_RAW,
  DaemonStatusUnreachableError,
  loadDaemonStatusFixture,
  setDaemonStatusFixtureKind,
} from "../src/renderer/model/daemon-status-fixture.ts";

afterEach(() => {
  setDaemonStatusFixtureKind("healthy-two-repo");
});

describe("readDaemonStatus", () => {
  it("parses the healthy two-repo fixture", () => {
    const status = readDaemonStatus(DAEMON_STATUS_HEALTHY_TWO_REPO_RAW);
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
    const status = readDaemonStatus(DAEMON_STATUS_STALE_UNAVAILABLE_RAW);
    expect(status.service.build.stale).toBe(true);
    expect(status.service.build.loadedIdentity).not.toBe(
      status.service.build.installedIdentity,
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
    const status = readDaemonStatus(DAEMON_STATUS_ACTIVE_CONTROL_RAW);
    expect(status.service.activeControl).toEqual({
      operationId: "control_01KXN0RESTART",
      kind: "restart",
      phase: "draining",
      requestedAt: "2026-07-16T08:30:00.000Z",
    });
  });

  it("ignores extra lock-owner identity fields on the wire without modeling them", () => {
    const withOwner = {
      ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW,
      requestedRepo: {
        ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.requestedRepo,
        lock: {
          path: ".harness/journal/global.lock",
          // Wire may carry owner identity; reader must ignore without naming it.
          ownerId: "lock-canonical",
        },
      },
      repos: DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.repos.map((repo) => ({
        ...repo,
        lock: {
          path: repo.lock.path,
          ownerId: "lock-ignored",
        },
      })),
    };
    const status = readDaemonStatus(withOwner);
    expect(status.requestedRepo.lock).toEqual({ path: ".harness/journal/global.lock" });
    expect(status.repos[0]?.lock).toEqual({ path: ".harness/journal/global.lock" });
    // Ensure the modeled lock object only has path.
    expect(Object.keys(status.requestedRepo.lock)).toEqual(["path"]);
  });

  it("throws on malformed input", () => {
    expect(() => readDaemonStatus(null)).toThrow(/not an object/i);
    expect(() => readDaemonStatus({ schema: "wrong" })).toThrow(/schema/i);
    expect(() => readDaemonStatus({ schema: "daemon-status/v1" })).toThrow(/schema/i);
    expect(() =>
      readDaemonStatus({
        schema: "daemon-status/v2",
        // missing service
        requestedRepo: DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.requestedRepo,
        repos: [],
      }),
    ).toThrow(/service/i);
    expect(() =>
      readDaemonStatus({
        ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW,
        service: {
          ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.service,
          queue: {
            interactive: -1,
            normal: 0,
            background: 0,
            maintenance: 0,
            running: false,
            depth: 0,
          },
        },
      }),
    ).toThrow(/queue/i);
    expect(() =>
      readDaemonStatus({
        ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW,
        service: {
          ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.service,
          queue: {
            interactive: 0,
            normal: 0,
            background: 0,
            maintenance: 0,
            running: false,
            depth: -3,
          },
        },
      }),
    ).toThrow(/depth/i);
    expect(() =>
      readDaemonStatus({
        ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW,
        repos: [{ repoId: 1 }],
      }),
    ).toThrow(/repos\[0\]/i);
    expect(() =>
      readDaemonStatus({
        ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW,
        repos: [
          {
            ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.repos[0],
            state: "ready",
          },
        ],
      }),
    ).toThrow(/state/i);
  });
});

describe("daemonRepoRows", () => {
  it("returns repos[] from the status payload", () => {
    const status = readDaemonStatus(DAEMON_STATUS_HEALTHY_TWO_REPO_RAW);
    const rows = daemonRepoRows(status);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.repoId)).toEqual(["canonical", "experiment"]);
    expect(rows[0]?.queue.depth).toBe(1);
    expect(rows[1]?.queue.depth).toBe(0);
  });

  it("surfaces unavailable rows from the stale fixture", () => {
    const status = readDaemonStatus(DAEMON_STATUS_STALE_UNAVAILABLE_RAW);
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
      DaemonStatusUnreachableError,
    );
  });
});
