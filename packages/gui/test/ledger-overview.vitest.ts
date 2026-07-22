import { describe, expect, it } from "vitest";
import { buildLedgerOverview } from "../src/renderer/model/ledger-overview.ts";
import type { DecisionRow, TaskRow } from "../src/renderer/model/types.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionDetailDrawer } from "../src/renderer/components/DecisionDetailDrawer.tsx";
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
  });
});
