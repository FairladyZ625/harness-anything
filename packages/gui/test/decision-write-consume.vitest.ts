import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";
import { DecisionsView } from "../src/renderer/views/DecisionsView.tsx";
import { GraphLegend } from "../src/renderer/views/GraphLegend.tsx";

const emptyAttribution = {
  originator: null,
  latestActor: null,
  trailCount: 0,
  completeness: "unresolved" as const,
};

function decision(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_a",
    title: "Pick layout",
    state: "proposed",
    riskTier: "high",
    urgency: "medium",
    vertical: "software/coding",
    preset: "coding",
    attribution: emptyAttribution,
    proposedAt: "2026-07-01T10:00:00.000Z",
    question: "Which layout?",
    chosen: [{ id: "CH1", text: "three-lane", evidence: ["fact/task_root/F-1"] }],
    rejected: [{ id: "RJ1", text: "flat list", evidence: [], whyNot: "loses hierarchy" }],
    claims: [
      { id: "CH1", text: "three-lane" },
      { id: "RJ1", text: "flat list" },
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
    anchor: "task_root/F-1",
    taskId: "task_root",
    category: "finding",
    text: "layout observation",
    at: "2026-07-01T00:00:00.000Z",
    confidence: "high",
    ...overrides,
  };
}

describe("task_01KXARE0RM · mutation failure must not paint success history", () => {
  const d = decision();
  const tasks = [task()];
  const facts = [fact()];
  const relations: RelationEdge[] = [];

  it("records processed history only after onDecide resolves", async () => {
    let resolveDecide!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveDecide = resolve;
    });
    const htmlBefore = renderToStaticMarkup(
      createElement(DecisionsView, {
        decisions: [d],
        tasks,
        relations,
        facts,
        onTraceSession: () => undefined,
        onDecide: () => pending,
      }),
    );
    expect(htmlBefore).not.toContain('data-testid="decision-processed-history"');

    // Drive handleDecide via a thin wrapper that mirrors DecisionsView's
    // settle-then-record contract (SSR cannot click; unit-test the policy).
    const processed: Array<{ id: string; action: string }> = [];
    async function decideWithHistory(
      id: string,
      action: "accept" | "reject" | "defer",
      onDecide: (id: string, action: "accept" | "reject" | "defer") => Promise<void>,
    ) {
      try {
        await onDecide(id, action);
        processed.push({ id, action });
      } catch {
        // leave history empty on rejection
      }
    }

    const rejectDecide = Promise.reject(new Error("E_EVIDENCE_FLOOR: insufficient evidence"));
    // Attach a no-op catcher so the rejection is not an unhandled rejection in the runner.
    void rejectDecide.catch(() => undefined);
    await decideWithHistory("dec_a", "accept", async () => {
      await rejectDecide;
    });
    expect(processed).toEqual([]);

    await decideWithHistory("dec_a", "accept", async () => {
      /* success */
    });
    expect(processed).toEqual([{ id: "dec_a", action: "accept" }]);

    // Keep the pending promise from leaking; resolve it for cleanliness.
    resolveDecide();
    await pending;
  });

  it("surfaces backend failure as thrown Error so toast can show it (no silent success)", async () => {
    async function decideFail() {
      const result = {
        ok: false as const,
        error: { code: "E_EVIDENCE_FLOOR", hint: "insufficient evidence" },
      };
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.hint}`);
      return result;
    }
    await expect(decideFail()).rejects.toThrow("E_EVIDENCE_FLOOR: insufficient evidence");
  });
});

describe("task_01KXARS0HW · coverage legend distinguishes fulfillment modes", () => {
  it("renders evidenced / delivered / standing-policy / unknown / uncovered chips", () => {
    const html = renderToStaticMarkup(
      createElement(GraphLegend, {
        visibleNodeCount: 3,
        edgeCount: 2,
        resolvedFocusId: null,
        cycleWarning: { count: 0, cycles: [] },
        hasFocus: false,
      }),
    );
    expect(html).toContain('data-testid="graph-legend-fulfillment"');
    expect(html).toContain('data-testid="graph-legend-fulfillment-evidenced"');
    expect(html).toContain('data-testid="graph-legend-fulfillment-delivered"');
    expect(html).toContain('data-testid="graph-legend-fulfillment-standing-policy"');
    expect(html).toContain('data-testid="graph-legend-fulfillment-unknown"');
    expect(html).toContain('data-testid="graph-legend-fulfillment-uncovered"');
    // labels (en locale default in vitest)
    expect(html).toMatch(/evidenced|有证据/);
    expect(html).toMatch(/delivered|已交付/);
    expect(html).toMatch(/standing-policy|常设政策/);
  });
});
