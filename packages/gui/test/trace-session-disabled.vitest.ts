// @vitest-environment jsdom
//
// task_01KX812C0R · onTraceSession no-op disposal — declarative disable.
//
// The trace-session button in VerdictCard (decisions-verdict.tsx) used to be
// wired to a no-op callback from ViewSwitch (ViewSwitch.tsx:302-305). The
// underlying coordinator conversation-mining export (E47) is not exposed via
// IPC, and opening a new IPC surface is out of scope for this task
// (task_plan §Checkpoint: "onTraceSession 若接通需要新开 IPC(E47) → 停并上报").
//
// Per task_plan §Goal 3, the default path is "explicitly disabled", mirroring
// the declarative disable form used by archiveTask/openShell in
// preload/allowlist.ts. This test pins the renderer-side disable so the
// button can never regress to a silent no-op that swallows clicks.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";
import { DecisionsView } from "../src/renderer/views/DecisionsView.tsx";

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
    chosen: [{ id: "CH1", text: "three-lane", evidence: [] }],
    rejected: [{ id: "RJ1", text: "flat list", evidence: [], whyNot: "loses hierarchy" }],
    claims: [
      { id: "CH1", text: "three-lane" },
      { id: "RJ1", text: "flat list" },
    ],
    provenance: [
      { runtime: "claude-code", sessionId: "sess-traceable-aaaa", boundAt: "2026-07-01T10:00:00.000Z" },
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

describe("task_01KX812C0R · onTraceSession declarative disable", () => {
  it("renders the trace button disabled and surfaces the deferral reason in its title", () => {
    const d = decision();
    const onTraceSession = vi.fn();

    render(
      createElement(DecisionsView, {
        decisions: [d],
        tasks: [task()],
        relations: [] as RelationEdge[],
        facts: [fact()],
        onTraceSession,
        onDecide: () => undefined,
        traceSessionDisabled: true,
      }),
    );

    const traceButton = screen.getByTestId("decision-trace-session");
    expect(traceButton).toBeTruthy();
    // Hard-disable at the DOM level — not just a silent handler.
    expect((traceButton as HTMLButtonElement).disabled).toBe(true);
    // Title surfaces the deferral reason (declarative disable form).
    const title = (traceButton as HTMLButtonElement).title ?? "";
    expect(title).toMatch(/E47|deferred|not yet|disabled/i);
  });

  it("does not invoke onTraceSession when the disabled button is clicked", () => {
    const d = decision();
    const onTraceSession = vi.fn();

    render(
      createElement(DecisionsView, {
        decisions: [d],
        tasks: [task()],
        relations: [] as RelationEdge[],
        facts: [fact()],
        onTraceSession,
        onDecide: () => undefined,
        traceSessionDisabled: true,
      }),
    );

    const traceButton = screen.getByTestId("decision-trace-session");
    fireEvent.click(traceButton);
    expect(onTraceSession).not.toHaveBeenCalled();
  });
});
