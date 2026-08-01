// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";
import { DecisionsView } from "../src/renderer/views/DecisionsView.tsx";
import { GraphLegend } from "../src/renderer/views/GraphLegend.tsx";

afterEach(() => {
  cleanup();
});

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
    // Judgment-only accept requires non-empty rationale; evidence path also works
    // when no conflict. Leave evidence empty so accept opens the rationale panel.
    chosen: [{ id: "CH1", text: "three-lane", evidence: [] }],
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

const baseProps = () => {
  const d = decision();
  return {
    d,
    decisions: [d],
    tasks: [task()],
    facts: [fact()],
    relations: [] as RelationEdge[],
  };
};

/**
 * Drive the production accept → judgment-only path on DecisionsView:
 *   1. click Accept (opens rationale panel)
 *   2. type a non-empty judgment rationale
 *   3. click Confirm judgment-only
 * Returns after the click handlers have been dispatched (mutation may still
 * be settling — callers flush with act/waitFor).
 */
async function submitJudgmentOnlyAccept() {
  await act(async () => {
    fireEvent.click(screen.getByTestId("decision-accept"));
  });
  const input = await screen.findByTestId("decision-judgment-only-input");
  await act(async () => {
    fireEvent.change(input, { target: { value: "ship it based on judgment" } });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("decision-accept-judgment-only"));
  });
}

describe("task_01KXARE0RM · mutation failure must not paint success history", () => {
  it("does not write processed history when production handleDecide rejects", async () => {
    const { decisions, tasks, facts, relations } = baseProps();
    const onDecide = vi.fn(async () => {
      throw new Error("E_EVIDENCE_FLOOR: insufficient evidence");
    });

    render(
      createElement(DecisionsView, {
        decisions,
        tasks,
        relations,
        facts,
        onTraceSession: () => undefined,
        onDecide,
      }),
    );

    expect(screen.queryByTestId("decision-processed-history")).toBeNull();

    await submitJudgmentOnlyAccept();

    // Flush the microtask queue so the async handleDecide catch path settles.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith("dec_a", "accept", "ship it based on judgment");
    // Production settle-then-record: rejection leaves history empty.
    expect(screen.queryByTestId("decision-processed-history")).toBeNull();
  });

  it("writes processed history only after production handleDecide resolves", async () => {
    const { decisions, tasks, facts, relations } = baseProps();
    let resolveDecide!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveDecide = resolve;
    });
    const onDecide = vi.fn(() => pending);

    render(
      createElement(DecisionsView, {
        decisions,
        tasks,
        relations,
        facts,
        onTraceSession: () => undefined,
        onDecide,
      }),
    );

    await submitJudgmentOnlyAccept();
    expect(onDecide).toHaveBeenCalledTimes(1);
    // Still in flight — history must stay empty.
    expect(screen.queryByTestId("decision-processed-history")).toBeNull();

    await act(async () => {
      resolveDecide();
      await pending;
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("decision-processed-history")).toBeTruthy();
    });
    expect(screen.getByTestId("decision-processed-history").textContent).toMatch(/accepted/i);
  });

  it("disables rationale submit while decidePending is true (double-click guard)", async () => {
    const { decisions, tasks, facts, relations } = baseProps();
    const onDecide = vi.fn(async () => undefined);

    render(
      createElement(DecisionsView, {
        decisions,
        tasks,
        relations,
        facts,
        onTraceSession: () => undefined,
        onDecide,
        decidePending: true,
      }),
    );

    // Accept opens the panel even when parent is pending only if buttons not
    // disabled — decideBusy includes decidePending, so Accept itself is disabled.
    const acceptBtn = screen.getByTestId("decision-accept");
    expect(acceptBtn).toHaveProperty("disabled", true);
    fireEvent.click(acceptBtn);
    expect(screen.queryByTestId("decision-rationale-panel")).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
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
    expect(html).toMatch(/evidenced|有证据/);
    expect(html).toMatch(/delivered|已交付/);
    expect(html).toMatch(/standing-policy|常设政策/);
  });
});
