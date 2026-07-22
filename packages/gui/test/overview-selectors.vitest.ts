import { describe, expect, it } from "vitest";
import {
  buildOverviewIndex,
  countStatus,
  windowDimensionRows,
  OVERVIEW_DIMENSION_PAGE_SIZE,
} from "../src/renderer/model/overview-selectors.ts";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";
import { buildLedgerOverview } from "../src/renderer/model/ledger-overview.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DecisionDetailDrawer } from "../src/renderer/components/DecisionDetailDrawer.tsx";
import { OverviewView } from "../src/renderer/views/OverviewView.tsx";
import { SwimlaneBoard } from "../src/renderer/views/SwimlaneBoard.tsx";

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

    const index = buildOverviewIndex({ tasks, decisions, facts, relations });

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
    expect(index.dimensionRows).toHaveLength(2);
    expect(index.dimensionRows.find((row) => row.key === "unassigned")?.counts.planned).toBe(1);
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

describe("ledger data on overview", () => {
  it("keeps every nontrivial tree and a first-class no-PLT bucket", () => {
    const model = buildLedgerOverview([
      task({ taskId: "root", title: "PLT", rootTaskId: "root", createdAt: "2026-07-01T00:00:00.000Z" }),
      task({ taskId: "child", title: "Child", rootTaskId: "root", liveness: "stale", createdAt: "2026-07-02T00:00:00.000Z" }),
      task({ taskId: "solo", title: "Inbox", rootTaskId: "solo", liveness: "stale", createdAt: "2026-07-03T00:00:00.000Z" }),
    ], []);
    expect(model.plt).toHaveLength(1);
    expect(model.plt[0]).toMatchObject({ rootId: "root", openCount: 2, staleCount: 1 });
    expect(model.ungrouped).toMatchObject({ openCount: 1, staleCount: 1 });
  });

  it("uses ULID task creation fallback and never treats projection updatedAt as an event", () => {
    const model = buildLedgerOverview([
      task({
        taskId: "task_01KXTSMS1M0000000000000000",
        title: "Fallback task",
        lastKnownAt: "2099-01-01T00:00:00.000Z",
      }),
    ], []);

    expect(model.events).toHaveLength(1);
    expect(model.events[0]).toMatchObject({
      kind: "task_created",
      id: "task_01KXTSMS1M0000000000000000",
      title: "Fallback task",
    });
    expect(model.events[0]?.at).toMatch(/^2026-/u);
    expect(model.events.some((event) => event.at.startsWith("2099"))).toBe(false);
  });

  it("renders full decision rationale behind an opaque high-layer drawer", () => {
    const drawerDecision = decision({
      decisionId: "dec_test",
      title: "Choose path",
      state: "active",
      question: "Which complete question?",
      chosen: [{ id: "C1", text: "Chosen in full", evidence: [] }],
      rejected: [{ id: "R1", text: "Rejected in full", whyNot: "Because evidence", evidence: [] }],
      decidedAt: "2026-07-03T00:00:00.000Z",
      attribution: { originator: null, latestActor: { principal: { kind: "person", personId: "person_owner" }, executor: null }, trailCount: 1, completeness: "complete" },
    });
    const html = renderToStaticMarkup(createElement(DecisionDetailDrawer, {
      decision: drawerDecision,
      tasks: [task({ taskId: "task_related", title: "Related task" })],
      facts: [{ anchor: "task_related/F-one", taskId: "task_related", category: "finding", text: "Related fact", at: "2026-07-01T00:00:00.000Z", confidence: "high" }],
      relations: [
        { from: "decision/dec_test/C1", to: "task/task_related", kind: "derives", provenance: "local-document", rationale: "work" },
        { from: "decision/dec_test/C1", to: "fact/task_related/F-one", kind: "evidenced-by", provenance: "local-document" },
      ],
      onClose: () => undefined,
      onOpenTask: () => undefined,
    }));
    expect(html).toContain("Which complete question?");
    expect(html).toContain("Chosen in full");
    expect(html).toContain("Rejected in full");
    expect(html).toContain("person_owner");
    expect(html).toContain("Related task");
    expect(html).toContain("Related fact");
    expect(html).toContain("z-[100]");
    expect(html).toContain("bg-bg/80");
    expect(html).toContain("background-color:var(--color-surface)");
  });

  it("feeds recency and liveness into exactly the original four overview cards", () => {
    const tasks = [
      task({ taskId: "task_01KXTMS7ER0000000000000000", title: "Older in-flight task", rootTaskId: "task_01KXTMS7ER0000000000000000", rootTitle: "Fleet PLT", liveness: "in_flight" }),
      task({ taskId: "task_01KXTSMS1M0000000000000000", title: "Newer stale task", rootTaskId: "task_01KXTMS7ER0000000000000000", rootTitle: "Fleet PLT", liveness: "stale" }),
      task({ taskId: "task_01KXTT00000000000000000000", title: "No PLT task", rootTaskId: "task_01KXTT00000000000000000000", liveness: "stale" }),
      task({ taskId: "task_01KXTN00000000000000000000", title: "Terminal stale task", coordinationStatus: "done", liveness: "stale" }),
    ];
    const decisions = [
      decision({ decisionId: "dec_01KXTMS7ER0000000000000000", title: "Priority proposed", state: "proposed", question: "Approve this?", proposedAt: undefined }),
      decision({ decisionId: "dec_01KXTSMS1M0000000000000000", title: "Newer active", state: "active", question: "Already active?", proposedAt: undefined }),
    ];
    const html = renderToStaticMarkup(createElement(OverviewView, {
      project: { id: "repo", name: "Harness", path: "/repo", preset: "coding", engines: ["local"], watermarkAt: "2026-07-22T00:00:00.000Z" },
      tasks,
      decisions,
      facts: [],
      relations: [],
      onSelect: () => undefined,
      onDrill: () => undefined,
      onOpenDecision: () => undefined,
    }));

    expect(html.match(/<section/g)).toHaveLength(4);
    expect(html).not.toContain("Recent activity");
    expect(html.indexOf("Priority proposed")).toBeLessThan(html.indexOf("Newer active"));
    expect(html.indexOf("Older in-flight task")).toBeLessThan(html.indexOf("Newer stale task"));
    expect(html).toContain("in flight");
    expect(html).toContain("Newer stale task");
    expect(html).not.toContain("Terminal stale task");
    expect(html).toContain("No PLT");
    expect(html).toContain("max-h-[30rem]");
    expect(html).not.toContain("module");
  });

  it("uses the same no-PLT bucket when overview drills into the root swimlane", () => {
    const tasks = [
      task({ taskId: "root", title: "Root", rootTaskId: "root", rootTitle: "Root" }),
      task({ taskId: "child", title: "Child", rootTaskId: "root", rootTitle: "Root" }),
      task({ taskId: "solo", title: "No PLT task", rootTaskId: "solo", rootTitle: "No PLT task" }),
    ];
    const html = renderToStaticMarkup(createElement(SwimlaneBoard, {
      tasks,
      groupBy: "root",
      onSelect: () => undefined,
      drill: { lane: "unassigned", status: "active", groupBy: "root" },
      relations: [],
      favorites: new Set<string>(),
      onToggleFavorite: () => undefined,
    }));

    expect(html).toContain("No PLT");
    expect(html).toContain("No PLT task");
  });
});
