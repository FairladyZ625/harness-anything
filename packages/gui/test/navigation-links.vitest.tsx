/**
 * Navigation link tests for the GUI triadic IA (task_01KYTXY0216PJ44VT4Q57KBCBQ).
 *
 * Covers the one-hop jumps added in this task:
 *  - DecisionDetailDrawer: related decisions / facts / tasks are clickable.
 *  - TaskPreviewDrawer: relation edges with entity-ref endpoints (task/{id})
 *    are resolved after the normalizeTaskId fix (previously dropped silently).
 *
 * SSR smoke only — click handlers are verified by asserting the rendered
 * button testids / titles; interactive behaviour is left to e2e.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  DecisionRow,
  EventEntry,
  FactRef,
  RelationEdge,
  TaskRow,
} from "../src/renderer/model/types.ts";
import { DecisionDetailDrawer } from "../src/renderer/components/DecisionDetailDrawer.tsx";
import { TaskPreviewDrawer } from "../src/renderer/components/TaskPreviewDrawer.tsx";

const emptyAttribution = {
  originator: null,
  latestActor: null,
  trailCount: 0,
  completeness: "unresolved" as const,
};

function decision(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_a",
    title: "Anchor decision",
    state: "proposed",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "coding",
    attribution: emptyAttribution,
    proposedAt: "2026-07-01T10:00:00.000Z",
    question: "Which layout?",
    chosen: [{ id: "CH1", text: "three-lane", evidence: [] }],
    rejected: [{ id: "RJ1", text: "flat", evidence: [], whyNot: "loses hierarchy" }],
    claims: [
      { id: "CH1", text: "three-lane" },
      { id: "RJ1", text: "flat" },
    ],
    ...overrides,
  };
}

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_leaf",
    title: "Leaf work",
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "software/coding",
    lastKnownAt: "2026-07-01T00:00:00.000Z",
    gates: [],
    docs: [],
    rootTaskId: "task_root",
    rootTitle: "Milestone Root",
    attribution: emptyAttribution,
    ...overrides,
  };
}

function fact(overrides: Partial<FactRef> = {}): FactRef {
  return {
    anchor: "task_leaf/F-1",
    taskId: "task_leaf",
    category: "finding",
    text: "layout observation",
    at: "2026-07-01T00:00:00.000Z",
    confidence: "high",
    ...overrides,
  };
}

describe("DecisionDetailDrawer · one-hop navigation links", () => {
  const decA = decision({ decisionId: "dec_a", title: "Anchor decision" });
  const decB = decision({ decisionId: "dec_b", title: "Refined by decision" });
  const taskLeaf = task({ taskId: "task_leaf", title: "Leaf work" });
  const factObs = fact({ anchor: "task_leaf/F-1", text: "layout observation" });

  const relations: RelationEdge[] = [
    { from: "decision/dec_a", to: "task/task_leaf", kind: "derives", provenance: "local-document" },
    { from: "decision/dec_a", to: "fact/task_leaf/F-1", kind: "evidenced-by", provenance: "local-document" },
    { from: "decision/dec_a", to: "decision/dec_b", kind: "refines", provenance: "local-document" },
  ];

  it("renders related tasks as clickable rows with the task title", () => {
    const html = renderToStaticMarkup(
      createElement(DecisionDetailDrawer, {
        decision: decA,
        decisions: [decA, decB],
        tasks: [taskLeaf],
        facts: [factObs],
        relations,
        onClose: () => undefined,
        onOpenTask: () => undefined,
        onOpenDecision: () => undefined,
        onOpenFact: () => undefined,
      }),
    );
    expect(html).toContain("Leaf work");
    expect(html).toContain("task_leaf");
  });

  it("renders related facts as clickable buttons keyed by anchor", () => {
    const html = renderToStaticMarkup(
      createElement(DecisionDetailDrawer, {
        decision: decA,
        decisions: [decA, decB],
        tasks: [taskLeaf],
        facts: [factObs],
        relations,
        onClose: () => undefined,
        onOpenTask: () => undefined,
        onOpenDecision: () => undefined,
        onOpenFact: () => undefined,
      }),
    );
    expect(html).toContain('data-testid="decision-drawer-fact-task_leaf/F-1"');
    expect(html).toContain("layout observation");
  });

  it("renders peer decisions (refines) as clickable buttons, excluding self", () => {
    const html = renderToStaticMarkup(
      createElement(DecisionDetailDrawer, {
        decision: decA,
        decisions: [decA, decB],
        tasks: [taskLeaf],
        facts: [factObs],
        relations,
        onClose: () => undefined,
        onOpenTask: () => undefined,
        onOpenDecision: () => undefined,
        onOpenFact: () => undefined,
      }),
    );
    expect(html).toContain('data-testid="decision-drawer-decision-dec_b"');
    expect(html).toContain("Refined by decision");
    // Self must not appear as a peer link.
    expect(html).not.toContain('data-testid="decision-drawer-decision-dec_a"');
  });

  it("falls back to non-clickable rows when navigation handlers are absent", () => {
    const html = renderToStaticMarkup(
      createElement(DecisionDetailDrawer, {
        decision: decA,
        decisions: [decA, decB],
        tasks: [taskLeaf],
        facts: [factObs],
        relations,
        onClose: () => undefined,
        onOpenTask: () => undefined,
        // onOpenDecision / onOpenFact deliberately omitted
      }),
    );
    // Facts and decisions still render their text, just without button testids.
    expect(html).toContain("layout observation");
    expect(html).toContain("Refined by decision");
    expect(html).not.toContain('data-testid="decision-drawer-fact-');
    expect(html).not.toContain('data-testid="decision-drawer-decision-');
  });

  it("renders nothing when decision is null", () => {
    const html = renderToStaticMarkup(
      createElement(DecisionDetailDrawer, {
        decision: null,
        decisions: [],
        tasks: [],
        facts: [],
        relations: [],
        onClose: () => undefined,
        onOpenTask: () => undefined,
      }),
    );
    expect(html).toBe("");
  });
});

describe("TaskPreviewDrawer · relation endpoint normalization", () => {
  const taskA = task({ taskId: "task_a", title: "Alpha task" });
  const taskB = task({ taskId: "task_b", title: "Beta task", rootTaskId: "task_root" });

  // Edges use entity-ref endpoints (task/{id}), not bare IDs.
  const relations: RelationEdge[] = [
    { from: "task/task_a", to: "task/task_b", kind: "blocks", provenance: "local-document" },
  ];
  const events: EventEntry[] = [];

  it("resolves task-to-task edges that use entity-ref endpoints", () => {
    // Before the normalizeTaskId fix, edge.from === task.taskId never matched
    // because edge.from is "task/task_a" while task.taskId is "task_a".
    const html = renderToStaticMarkup(
      createElement(TaskPreviewDrawer, {
        task: taskA,
        tasks: [taskA, taskB],
        relations,
        events,
        onClose: () => undefined,
        onOpenDetail: () => undefined,
        onPreviewTask: () => undefined,
      }),
    );
    expect(html).toContain("Beta task");
    expect(html).toContain("task_b");
  });

  it("resolves the reverse direction (to === current task)", () => {
    const html = renderToStaticMarkup(
      createElement(TaskPreviewDrawer, {
        task: taskB,
        tasks: [taskA, taskB],
        relations,
        events,
        onClose: () => undefined,
        onOpenDetail: () => undefined,
        onPreviewTask: () => undefined,
      }),
    );
    expect(html).toContain("Alpha task");
    expect(html).toContain("task_a");
  });
});
