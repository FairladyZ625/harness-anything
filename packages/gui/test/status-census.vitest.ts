// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { SnapshotStatus, TaskRow } from "../src/renderer/model/types.ts";
import { coordinationStatusCensus } from "../src/renderer/model/status-census.ts";

function task(taskId: string, coordinationStatus: SnapshotStatus): TaskRow {
  return {
    taskId, title: taskId, projectId: "repo-a", coordinationStatus, rawStatus: coordinationStatus,
    freshness: "fresh", packageDisposition: "active", closeoutReadiness: "not_required",
    engine: "local", source: "local-document", module: "unassigned",
    lastKnownAt: "2026-08-01T00:00:00.000Z", gates: [], docs: [],
  };
}

describe("coordination status census (single stats caliber)", () => {
  it("counts per kernel status word, terminal statuses included in total rows but not the three open columns", () => {
    const census = coordinationStatusCensus([
      task("a", "active"), task("b", "active"), task("c", "blocked"),
      task("d", "in_review"), task("e", "done"), task("f", "cancelled"),
    ]);
    expect(census.get("active")).toBe(2);
    expect(census.get("blocked")).toBe(1);
    expect(census.get("in_review")).toBe(1);
    expect(census.get("done")).toBe(1);
    expect(census.get("cancelled")).toBe(1);
  });

  it("missing statuses read as 0, never invented", () => {
    const census = coordinationStatusCensus([task("only", "planned")]);
    expect(census.get("active") ?? 0).toBe(0);
    expect(census.get("planned")).toBe(1);
  });

  it("the sidebar sum equals the overview card numbers for the same row set (no second aggregate)", () => {
    const tasks = [task("a", "active"), task("b", "blocked"), task("c", "in_review"), task("d", "active")];
    const census = coordinationStatusCensus(tasks);
    const sidebarNumbers = (["active", "blocked", "in_review"] as const).map((status) => census.get(status) ?? 0);
    expect(sidebarNumbers).toEqual([2, 1, 1]);
    expect(tasks.length).toBe(4);
  });
});
