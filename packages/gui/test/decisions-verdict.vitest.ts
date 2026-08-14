// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { RelationCoverageRow } from "../src/api/renderer-dto.ts";
import type { DecisionRow, FactRef } from "../src/renderer/model/types.ts";
import { computeReadinessSignals } from "../src/renderer/views/decisions-verdict.tsx";

function dec(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_1", title: "D1", state: "proposed", question: "Q?",
    riskTier: "medium", urgency: "medium",
    chosen: [{ id: "CH1", text: "c", evidence: ["fact/task_1/F-live"] }], rejected: [],
    claims: [{ id: "CH1", text: "c", loadBearing: true, fulfillment: "evidenced" }],
    proposedAt: "2026-08-01T00:00:00.000Z",
    judgmentConsents: [],
    ...overrides,
  };
}

function fact(anchor: string, invalidated = false): FactRef {
  return {
    anchor,
    taskId: anchor.split("/")[0] ?? "task_1",
    category: "finding",
    text: anchor,
    at: "2026-08-01T00:00:00.000Z",
    confidence: "high",
    invalidated,
  };
}

function coverage(overrides: Partial<RelationCoverageRow> = {}): RelationCoverageRow {
  return {
    decisionRef: "decision/dec_1",
    claimRef: "decision/dec_1/CH1",
    status: "covered",
    fulfillment: "evidenced",
    coveringFactRef: "fact/task_1/F-live",
    refutingFactRefs: [],
    relationPath: ["rel_evidence"],
    basisRevision: 12,
    ...overrides,
  };
}

const signal = (
  decision: DecisionRow,
  facts: FactRef[],
  rows: RelationCoverageRow[],
  id: "evidence-liveness" | "applies-to-drift" | "coverage" | "conflict-marker",
  graphState: "ready" | "loading" | "error" = "ready",
) => computeReadinessSignals(decision, facts, rows, graphState).find((item) => item.id === id)!;

describe("decision readiness uses canonical coverage and explicit unknowns", () => {
  it("renders canonical commit-bound drift and conflict projections", () => {
    const decision = dec({
      readinessSignals: {
        appliesToDrift: { state: "drift", paths: ["packages/kernel/index.ts"], lastCommitAt: "2026-08-10T00:00:00.000Z", summary: "Canonical scope changed." },
        conflictMarker: { state: "conflict", paths: ["packages/kernel/index.ts"], summary: "Committed conflict marker." },
      },
    });

    expect(signal(decision, [], [], "applies-to-drift").color).toBe("yellow");
    expect(signal(decision, [], [], "applies-to-drift").summary).toContain("packages/kernel/index.ts");
    expect(signal(decision, [], [], "conflict-marker").color).toBe("red");
    expect(signal(decision, [], [], "conflict-marker").summary).toContain("Committed conflict marker");
  });

  it("keeps explicitly unavailable canonical readiness unknown", () => { const decision = dec({ readinessSignals: { appliesToDrift: { state: "unknown", paths: [], lastCommitAt: null, summary: "Scope unresolved." }, conflictMarker: { state: "unknown", paths: [], summary: "Scope unresolved." } } }); expect(signal(decision, [], [], "applies-to-drift").color).toBe("unknown"); expect(signal(decision, [], [], "conflict-marker").color).toBe("unknown"); });

  it("renders no load-bearing claims as gray N/A instead of green", () => {
    const decision = dec({ claims: [{ id: "CH1", text: "c", loadBearing: false, fulfillment: null }] });

    expect(signal(decision, [], [], "evidence-liveness").color).toBe("na");
    expect(signal(decision, [], [], "coverage").color).toBe("na");
  });

  it("uses coverageRows rather than guessing coverage from option evidence", () => {
    const decision = dec();
    const live = fact("task_1/F-live");

    expect(signal(decision, [live], [], "coverage").color).toBe("unknown");
    expect(signal(decision, [live], [coverage()], "coverage").color).toBe("green");
    expect(signal(decision, [live], [coverage({ status: "uncovered", coveringFactRef: undefined })], "coverage").color).toBe("red");
  });

  it("marks missing graph/fact projection unknown and invalidated evidence yellow", () => {
    const decision = dec();

    expect(signal(decision, [], [coverage()], "evidence-liveness", "loading").color).toBe("unknown");
    expect(signal(decision, [], [coverage()], "evidence-liveness").color).toBe("unknown");
    expect(signal(decision, [fact("task_1/F-live", true)], [coverage()], "evidence-liveness").color).toBe("yellow");
  });

  it("treats live covering and refuting fact references as a known liveness check", () => {
    const decision = dec();
    const row = coverage({ refutingFactRefs: ["fact/task_1/F-refute"] });
    const liveness = signal(decision, [fact("task_1/F-live"), fact("task_1/F-refute")], [row], "evidence-liveness");

    expect(liveness.color).toBe("green");
    expect(liveness.summary).toContain("basisRevision 12");
  });
});
