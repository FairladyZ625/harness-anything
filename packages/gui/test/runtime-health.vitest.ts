// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import {
  DAEMON_OBSERVED_STALE_SEC,
  deriveRuntimeHealth,
  runtimeHealthWorst,
} from "../src/renderer/model/runtime-health.ts";

const NOW = "2026-08-21T12:00:00.000Z";
const repo = { cellState: "attached" as const, queueDepth: 0, lastError: null, unavailableReason: null };

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

  it("derives projection lag from sourceRevision − watermark and degrades instead of hiding it", () => {
    const health = deriveRuntimeHealth({
      daemon: { ok: true, observedAt: NOW, uptimeMs: 0 },
      repo,
      projection: { watermark: 90, sourceRevision: 97, status: "pending" },
      lastSnapshotAt: NOW,
      now: NOW,
    });
    expect(health.projection.lag).toBe(7);
    expect(health.projection.status).toBe("pending");
    expect(runtimeHealthWorst(health)).toBe("degraded");
  });

  it("surfaces the repo cell problem text for unavailable cells", () => {
    const health = deriveRuntimeHealth({
      daemon: { ok: true, observedAt: NOW, uptimeMs: 0 },
      repo: { cellState: "unavailable", queueDepth: 3, lastError: null, unavailableReason: "cell crashed during scan" },
      projection: null,
      lastSnapshotAt: null,
      now: NOW,
    });
    expect(health.cell.problem).toBe("cell crashed during scan");
    expect(runtimeHealthWorst(health)).toBe("down");
  });

  it("never invents times: missing snapshot and never-settled query stay null", () => {
    const health = deriveRuntimeHealth({ daemon: null, repo: null, projection: null, lastSnapshotAt: null, now: NOW });
    expect(health.daemon.state).toBe("unknown");
    expect(health.daemon.observedAgeSec).toBeNull();
    expect(health.ledgerChange.at).toBeNull();
    expect(runtimeHealthWorst(health)).toBe("degraded");
  });
});
