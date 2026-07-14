import { describe, expect, it } from "vitest";
import {
  buildOverviewIndex,
  countStatus,
  windowDimensionRows,
  OVERVIEW_DIMENSION_PAGE_SIZE,
} from "../src/renderer/model/overview-selectors.ts";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";

function task(partial: Partial<TaskRow> & Pick<TaskRow, "taskId" | "title">): TaskRow {
  return {
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "mod-a",
    lastKnownAt: "2026-07-14T00:00:00.000Z",
    gates: [],
    docs: [],
    attribution: { originator: null, latestActor: null, trailCount: 0, completeness: "unresolved" },
    rootTaskId: partial.taskId,
    rootTitle: partial.title,
    ...partial,
  };
}

function decision(partial: Partial<DecisionRow> & Pick<DecisionRow, "decisionId" | "title">): DecisionRow {
  return {
    state: "proposed",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "architecture-decision",
    attribution: { originator: null, latestActor: null, trailCount: 0, completeness: "unresolved" },
    proposedAt: "2026-07-14T00:00:00.000Z",
    decidedAt: undefined,
    question: "Q?",
    chosen: [],
    rejected: [],
    claims: [],
    provenance: [],
    lastChangedAt: "2026-07-14T00:00:00.000Z",
    ...partial,
  };
}

describe("buildOverviewIndex", () => {
  it("indexes status and dimension cells in a single linear pass", () => {
    const tasks = [
      task({ taskId: "t1", title: "Root A", coordinationStatus: "active", rootTaskId: "t1", rootTitle: "Root A" }),
      task({ taskId: "t2", title: "Child A", coordinationStatus: "blocked", rootTaskId: "t1", rootTitle: "Root A", module: "mod-a" }),
      task({ taskId: "t3", title: "Root B", coordinationStatus: "in_review", rootTaskId: "t3", rootTitle: "Root B", module: "mod-b", closeoutReadiness: "ready", lastKnownAt: "2026-07-13T00:00:00.000Z" }),
      task({ taskId: "t4", title: "Stale", coordinationStatus: "planned", rootTaskId: "t4", rootTitle: "Root C", freshness: "stale-but-usable" }),
    ];
    const decisions = [
      decision({ decisionId: "dec_a", title: "Decide A", state: "proposed", urgency: "high" }),
      decision({ decisionId: "dec_b", title: "Decide B", state: "active" }),
    ];
    const facts: FactRef[] = [
      { anchor: "t1/F-1", taskId: "t1", category: "progress", text: "ok", at: "2026-07-14T00:00:00.000Z", confidence: "low", source: "test", provenance: [], invalidated: false },
      { anchor: "t1/F-2", taskId: "t1", category: "progress", text: "bad", at: "2026-07-14T00:00:00.000Z", confidence: "low", source: "test", provenance: [], invalidated: true },
    ];
    const relations: RelationEdge[] = [
      { from: "task/t1", to: "fact/t1/F-1", kind: "produces", provenance: "local-document" },
      { from: "task/missing", to: "fact/t1/F-1", kind: "produces", provenance: "local-document" },
    ];

    const index = buildOverviewIndex({ tasks, decisions, facts, relations, dimension: "root" });

    expect(countStatus(index, "active")).toBe(1);
    expect(countStatus(index, "blocked")).toBe(1);
    expect(countStatus(index, "in_review")).toBe(1);
    expect(index.staleCount).toBe(1);
    expect(index.invalidatedFactCount).toBe(1);
    expect(index.danglingRelationCount).toBe(1);
    expect(index.proposedTop.map((d) => d.decisionId)).toEqual(["dec_a"]);
    expect(index.blockers.map((t) => t.taskId).sort()).toEqual(["t2", "t3"]);
    // t1 and t2 share root t1 → one dimension row with active+blocked
    const rootA = index.dimensionRows.find((row) => row.key === "t1");
    expect(rootA?.counts.active).toBe(1);
    expect(rootA?.counts.blocked).toBe(1);
    expect(index.dimensionRows).toHaveLength(3);
  });

  it("does not re-scan the full task list per dimension cell (O(N) contract)", () => {
    const tasks = Array.from({ length: 200 }, (_, i) =>
      task({
        taskId: `t${i}`,
        title: `Task ${i}`,
        rootTaskId: `root-${i % 50}`,
        rootTitle: `Root ${i % 50}`,
        coordinationStatus: i % 3 === 0 ? "blocked" : "active",
        module: `mod-${i % 10}`,
      }),
    );
    const index = buildOverviewIndex({
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      dimension: "root",
    });
    // 50 roots, each cell lookup is map access — total counts sum to N
    const summed = index.dimensionRows.reduce(
      (sum, row) => sum + Object.values(row.counts).reduce((a, b) => a + b, 0),
      0,
    );
    expect(summed).toBe(200);
    expect(index.dimensionRows).toHaveLength(50);
    expect(countStatus(index, "blocked")).toBe(67); // i % 3 === 0 for i in 0..199
  });
});

describe("windowDimensionRows", () => {
  it("windows roots without silent truncation — full total remains reachable", () => {
    const rows = Array.from({ length: OVERVIEW_DIMENSION_PAGE_SIZE + 15 }, (_, i) => ({
      key: `k${i}`,
      label: `L${i}`,
      counts: {
        planned: 0,
        active: 1,
        blocked: 0,
        in_review: 0,
        done: 0,
        cancelled: 0,
        unknown: 0,
      },
    }));
    const page0 = windowDimensionRows(rows, 0);
    const page1 = windowDimensionRows(rows, 1);
    expect(page0.visible).toHaveLength(OVERVIEW_DIMENSION_PAGE_SIZE);
    expect(page1.visible).toHaveLength(15);
    expect(page0.total).toBe(rows.length);
    expect(page1.pageCount).toBe(2);
    // every key reachable across pages
    const seen = new Set([...page0.visible, ...page1.visible].map((r) => r.key));
    expect(seen.size).toBe(rows.length);
  });
});
