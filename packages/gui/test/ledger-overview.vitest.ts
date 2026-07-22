import { describe, expect, it } from "vitest";
import { buildLedgerOverview } from "../src/renderer/model/ledger-overview.ts";
import type { DecisionRow, TaskRow } from "../src/renderer/model/types.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionDetailDrawer } from "../src/renderer/components/DecisionDetailDrawer.tsx";
import { OverviewLedgerSections } from "../src/renderer/components/overview/LedgerSections.tsx";
import { createElement } from "react";

function task(values: Partial<TaskRow> & Pick<TaskRow, "taskId" | "title">): TaskRow {
  return {
    projectId: "repo",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "test",
    lastKnownAt: "2099-01-01T00:00:00.000Z",
    gates: [],
    docs: [],
    attribution: { originator: null, latestActor: null, trailCount: 0, completeness: "unresolved" },
    ...values,
  };
}

describe("ledger overview", () => {
  it("keeps every nontrivial tree and a first-class no-PLT bucket", () => {
    const tasks = [
      task({ taskId: "root", title: "PLT", rootTaskId: "root", createdAt: "2026-07-01T00:00:00.000Z" }),
      task({ taskId: "child", title: "Child", rootTaskId: "root", liveness: "stale", createdAt: "2026-07-02T00:00:00.000Z" }),
      task({ taskId: "solo", title: "Inbox", rootTaskId: "solo", liveness: "stale", createdAt: "2026-07-03T00:00:00.000Z" }),
    ];
    const model = buildLedgerOverview(tasks, []);
    expect(model.plt).toHaveLength(1);
    expect(model.plt[0]).toMatchObject({ rootId: "root", openCount: 2, staleCount: 1 });
    expect(model.ungrouped).toMatchObject({ openCount: 1, staleCount: 1 });
  });

  it("sorts authored recency and never treats projection updatedAt as an event", () => {
    const tasks = [task({
      taskId: "done",
      title: "Done",
      coordinationStatus: "done",
      createdAt: "2026-07-01T00:00:00.000Z",
      terminalAt: "2026-07-02T00:00:00.000Z",
      lastKnownAt: "2099-01-01T00:00:00.000Z",
    })];
    const decisions = [{
      decisionId: "dec_01KXTSMS1M0000000000000000",
      title: "Decision",
      proposedAt: "2026-07-03T00:00:00.000Z",
    }] as DecisionRow[];
    const model = buildLedgerOverview(tasks, decisions);
    expect(model.events.map((event) => event.kind)).toEqual(["decision_created", "task_terminal", "task_created"]);
    expect(model.events.some((event) => event.at.startsWith("2099"))).toBe(false);
  });

  it("renders full decision rationale, acceptance attribution, and related entities", () => {
    const decision = {
      decisionId: "dec_test",
      title: "Choose path",
      state: "active",
      question: "Which complete question?",
      chosen: [{ id: "C1", text: "Chosen in full", evidence: [] }],
      rejected: [{ id: "R1", text: "Rejected in full", whyNot: "Because evidence", evidence: [] }],
      claims: [],
      decidedAt: "2026-07-03T00:00:00.000Z",
      attribution: { originator: null, latestActor: { principal: { kind: "person", personId: "person_owner" }, executor: null }, trailCount: 1, completeness: "complete" },
    } satisfies DecisionRow;
    const html = renderToStaticMarkup(createElement(DecisionDetailDrawer, {
      decision,
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
    expect(html).toContain("decision-drawer-overlay");
    expect(html).toContain("z-[100]");
    expect(html).toContain("bg-bg/80");
    expect(html).toContain("decision-drawer-panel");
    expect(html).toContain("background-color:var(--color-surface)");
  });

  it("renders recent activity and collapsed PLT rows in the original overview card language", () => {
    const tasks = [
      task({ taskId: "root", title: "Fleet PLT", rootTaskId: "root", createdAt: "2026-07-03T00:00:00.000Z" }),
      task({ taskId: "child", title: "Hidden stale task", rootTaskId: "root", liveness: "stale" }),
      task({ taskId: "solo", title: "Inbox task", rootTaskId: "solo", liveness: "stale" }),
    ];
    const decisions = [{
      decisionId: "dec_01KXTSMS1M0000000000000000",
      title: "Recent decision",
      proposedAt: "2026-07-04T00:00:00.000Z",
    }] as DecisionRow[];
    const html = renderToStaticMarkup(createElement(OverviewLedgerSections, {
      tasks,
      decisions,
      onOpenTask: () => undefined,
      onOpenDecision: () => undefined,
    }));

    expect(html).toContain("Recent activity");
    expect(html).toContain("Recent decision");
    expect(html).toContain("hover:border-accent/60");
    expect(html).toContain("Fleet PLT");
    expect(html).toContain("No PLT (1)");
    expect(html).toContain("1 stale");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("Hidden stale task");
    expect(html).toContain("var(--color-status-done)");
  });
});
