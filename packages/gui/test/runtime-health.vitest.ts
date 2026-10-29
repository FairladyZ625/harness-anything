// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import {
  DAEMON_OBSERVED_STALE_SEC,
  EMPTY_RUNTIME_HEALTH_TRANSIENT,
  TRANSIENT_GRACE_SEC,
  deriveRuntimeHealth,
  runtimeHealthAssessment,
  runtimeHealthWorst,
} from "../src/renderer/model/runtime-health.ts";

const NOW = "2026-08-21T12:00:00.000Z";
const secondsAgo = (seconds: number): string => new Date(Date.parse(NOW) - seconds * 1_000).toISOString();
const repo = {
  mode: "local" as const,
  cellState: "attached" as const,
  queueDepth: 0,
  lastError: null,
  unavailableReason: null,
};

describe("deriveRuntimeHealth (fourth grid, existing read surface only)", () => {
  it("reads responsive daemon, attached cell and zero lag as healthy", () => {
    const health = deriveRuntimeHealth({
      daemon: { ok: true, observedAt: "2026-08-21T11:59:55.000Z", uptimeMs: 3600_000 },
      repo,
      projection: { watermark: 100, sourceRevision: 100, status: "ready" },
      lastSnapshotAt: "2026-08-21T11:58:00.000Z",
      now: NOW,
    });
    expect(health.daemon.state).toBe("responsive");
    expect(health.daemon.observedAgeSec).toBe(5);
    expect(health.cell.state).toBe("attached");
    expect(health.projection.lag).toBe(0);
    expect(health.ledgerChange.ageSec).toBe(120);
    expect(runtimeHealthWorst(health)).toBe("ok");
    expect(runtimeHealthAssessment(health).cause).toBeNull();
  });

  it("flags the daemon unresponsive once the last successful observation ages past the threshold", () => {
    // 2026-08-21 daemon-freeze shape: polls hang, observedAt stops advancing.
    const staleIso = `2026-08-21T11:59:${String(60 - DAEMON_OBSERVED_STALE_SEC - 10).padStart(2, "0")}.000Z`;
    const health = deriveRuntimeHealth({
      daemon: { ok: true, observedAt: staleIso, uptimeMs: 1 },
      repo,
      projection: { watermark: 100, sourceRevision: 100, status: "ready" },
      lastSnapshotAt: null,
      now: NOW,
    });
    expect(health.daemon.state).toBe("unresponsive");
    expect(runtimeHealthWorst(health)).toBe("down");
  });

  it("marks an errored system query unresponsive even before observedAt ages out", () => {
    const health = deriveRuntimeHealth({
      daemon: { ok: false, observedAt: "2026-08-21T11:59:58.000Z", uptimeMs: null },
      repo: null,
      projection: null,
      lastSnapshotAt: null,
      now: NOW,
    });
    expect(health.daemon.state).toBe("unresponsive");
    expect(health.cell.state).toBe("unknown");
    expect(runtimeHealthWorst(health)).toBe("down");
  });

  it("keeps a just-observed projection lag in the neutral sync tier instead of calling it degraded", () => {
    // The reported defect: a sub-second write wedge (lag 1) lit the sidebar red as
    // 「降级运行」. A first snapshot with lag 1 has no history yet; it is syncing, not degraded.
    const health = deriveRuntimeHealth({
      daemon: { ok: true, observedAt: NOW, uptimeMs: 0 },
      repo,
      projection: { watermark: 96, sourceRevision: 97, status: "pending" },
      lastSnapshotAt: NOW,
      now: NOW,
    });
    expect(health.projection.lag).toBe(1);
    expect(health.transient.lagAgeSec).toBe(0);
    expect(runtimeHealthWorst(health)).toBe("syncing");
    expect(runtimeHealthAssessment(health).cause).toEqual({ kind: "projection-lag", lag: 1, ageSec: 0 });
  });

  it("degrades only after the same projection lag has survived the whole grace window", () => {
    const base = {
      daemon: { ok: true, observedAt: NOW, uptimeMs: 0 },
      repo,
      projection: { watermark: 90, sourceRevision: 97, status: "pending" as const },
      lastSnapshotAt: NOW,
      now: NOW,
    };
    const persisting = deriveRuntimeHealth({
      ...base,
      prior: { lagSince: secondsAgo(TRANSIENT_GRACE_SEC - 1), unknownSince: null },
    });
    expect(persisting.transient.lagAgeSec).toBe(TRANSIENT_GRACE_SEC - 1);
    expect(runtimeHealthWorst(persisting)).toBe("syncing");

    const sustained = deriveRuntimeHealth({
      ...base,
      prior: { lagSince: secondsAgo(TRANSIENT_GRACE_SEC), unknownSince: null },
    });
    expect(sustained.transient.lagAgeSec).toBe(TRANSIENT_GRACE_SEC);
    expect(runtimeHealthWorst(sustained)).toBe("degraded");
    expect(runtimeHealthAssessment(sustained).cause).toEqual({
      kind: "projection-lag",
      lag: 7,
      ageSec: TRANSIENT_GRACE_SEC,
    });
  });

  it("clears the persistence clock as soon as the lag resolves", () => {
    const resolved = deriveRuntimeHealth({
      daemon: { ok: true, observedAt: NOW, uptimeMs: 0 },
      repo,
      projection: { watermark: 97, sourceRevision: 97, status: "ready" },
      prior: { lagSince: secondsAgo(TRANSIENT_GRACE_SEC * 2), unknownSince: null },
      lastSnapshotAt: NOW,
      now: NOW,
    });
    expect(resolved.transient).toEqual(EMPTY_RUNTIME_HEALTH_TRANSIENT);
    expect(runtimeHealthWorst(resolved)).toBe("ok");
  });

  it("shows a warming cell as starting and carries the daemon-wide mount progress", () => {
    const health = deriveRuntimeHealth({
      daemon: { ok: true, observedAt: NOW, uptimeMs: 12_000 },
      repo: { ...repo, cellState: "warming" },
      projection: { watermark: 10, sourceRevision: 10, status: "ready" },
      mount: { attached: 14, total: 22 },
      lastSnapshotAt: NOW,
      now: NOW,
    });
    expect(health.mount).toEqual({ attached: 14, total: 22 });
    expect(runtimeHealthWorst(health)).toBe("starting");
    expect(runtimeHealthAssessment(health).cause).toEqual({ kind: "cell-warming" });
  });

  it("shows an unfinished hydration as starting even with a caught-up watermark", () => {
    const health = deriveRuntimeHealth({
      daemon: { ok: true, observedAt: NOW, uptimeMs: 12_000 },
      repo,
      projection: { watermark: 100, sourceRevision: 100, status: "pending", hydrating: true },
      lastSnapshotAt: NOW,
      now: NOW,
    });
    expect(health.projection.hydrating).toBe(true);
    expect(runtimeHealthWorst(health)).toBe("starting");
    expect(runtimeHealthAssessment(health).cause).toEqual({ kind: "projection-hydrating" });
  });

  it("keeps isolated rows degraded even while the reported lag is fresh", () => {
    // Negative control: isolation is a real completeness failure, not a transient wedge.
    const health = deriveRuntimeHealth({
      daemon: { ok: true, observedAt: NOW, uptimeMs: 0 },
      repo,
      projection: { watermark: 98, sourceRevision: 100, status: "pending", isolatedRows: 2 },
      lastSnapshotAt: NOW,
      now: NOW,
    });
    expect(runtimeHealthWorst(health)).toBe("degraded");
    expect(runtimeHealthAssessment(health).cause).toEqual({ kind: "projection-isolated", rows: 2 });
  });

  it("surfaces the repo cell problem text for unavailable cells", () => {
    const health = deriveRuntimeHealth({
      daemon: { ok: true, observedAt: NOW, uptimeMs: 0 },
      repo: {
        mode: "local",
        cellState: "unavailable",
        queueDepth: 3,
        lastError: null,
        unavailableReason: "cell crashed during scan",
      },
      projection: null,
      lastSnapshotAt: null,
      now: NOW,
    });
    expect(health.cell.problem).toBe("cell crashed during scan");
    expect(runtimeHealthWorst(health)).toBe("down");
    expect(runtimeHealthAssessment(health).cause).toEqual({
      kind: "cell-unavailable",
      problem: "cell crashed during scan",
    });
  });

  it("treats a remote-proxy not_loaded cell as an attached remote service", () => {
    const health = deriveRuntimeHealth({
      daemon: { ok: true, observedAt: NOW, uptimeMs: 1 },
      repo: {
        mode: "remote-proxy",
        cellState: "not_loaded",
        queueDepth: null,
        lastError: null,
        unavailableReason: null,
      },
      projection: { watermark: 10, sourceRevision: 10, status: "ready" },
      lastSnapshotAt: NOW,
      now: NOW,
    });
    expect(health.cell.state).toBe("attached");
    expect(health.cell.problem).toBeNull();
    expect(runtimeHealthWorst(health)).toBe("ok");
  });

  it("never invents times: missing snapshot and never-settled query stay null", () => {
    const health = deriveRuntimeHealth({ daemon: null, repo: null, projection: null, lastSnapshotAt: null, now: NOW });
    expect(health.daemon.state).toBe("unknown");
    expect(health.daemon.observedAgeSec).toBeNull();
    expect(health.ledgerChange.at).toBeNull();
    expect(health.projection.loading).toBe(false);
    // A daemon that has not answered yet is starting, not a degraded daemon.
    expect(runtimeHealthWorst(health)).toBe("starting");
    expect(runtimeHealthAssessment(health).cause).toEqual({ kind: "daemon-unknown", ageSec: 0 });
  });

  it("degrades an absent daemon only once the unknown state outlives the grace window", () => {
    const health = deriveRuntimeHealth({
      daemon: null,
      repo: null,
      projection: null,
      prior: { lagSince: null, unknownSince: secondsAgo(TRANSIENT_GRACE_SEC) },
      lastSnapshotAt: null,
      now: NOW,
    });
    expect(health.transient.unknownAgeSec).toBe(TRANSIENT_GRACE_SEC);
    expect(runtimeHealthWorst(health)).toBe("degraded");
    expect(runtimeHealthAssessment(health).cause).toEqual({ kind: "daemon-unknown", ageSec: TRANSIENT_GRACE_SEC });
  });

  it("distinguishes a pending first projection read from an unknown settled result", () => {
    const health = deriveRuntimeHealth({
      daemon: null,
      repo: null,
      projection: null,
      projectionLoading: true,
      lastSnapshotAt: null,
      now: NOW,
    });
    expect(health.projection).toEqual({ lag: null, loading: true, status: null, isolatedRows: null, hydrating: false });
  });
});
