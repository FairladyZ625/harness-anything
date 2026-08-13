// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { DecisionRow } from "../src/renderer/model/types.ts";
import { computeReadinessSignals } from "../src/renderer/views/decisions-verdict.tsx";

function dec(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_1", title: "D1", state: "proposed", question: "Q?",
    riskTier: "medium", urgency: "medium",
    chosen: [{ id: "CH1", text: "c", evidence: [] }], rejected: [],
    claims: [{ id: "CH1", text: "c" }],
    proposedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as DecisionRow;
}

describe("readiness signal unknown state (UNKNOWN-001 验收硬项)", () => {
  it("shows applies-to-drift as unknown when readinessSignals is absent", () => {
    const signals = computeReadinessSignals(dec(), []);
    const drift = signals.find((s) => s.id === "applies-to-drift")!;
    expect(drift.color).toBe("unknown");
  });

  it("shows conflict-marker as unknown when readinessSignals is absent", () => {
    const signals = computeReadinessSignals(dec(), []);
    const conflict = signals.find((s) => s.id === "conflict-marker")!;
    expect(conflict.color).toBe("unknown");
  });

  it("shows applies-to-drift as yellow when drift is present", () => {
    const signals = computeReadinessSignals(dec({
      readinessSignals: {
        appliesToDrift: { docs: ["doc.md"], lastCommitAt: "2026-08-10" },
      },
    }), []);
    const drift = signals.find((s) => s.id === "applies-to-drift")!;
    expect(drift.color).toBe("yellow");
  });

  it("shows conflict-marker as red when conflict is present", () => {
    const signals = computeReadinessSignals(dec({
      readinessSignals: {
        conflictMarker: { summary: "merge conflict", conflictingEntity: "dec_2" },
      },
    }), []);
    const conflict = signals.find((s) => s.id === "conflict-marker")!;
    expect(conflict.color).toBe("red");
  });

  it("shows green only when readinessSignals explicitly has no drift/conflict", () => {
    const signals = computeReadinessSignals(dec({
      readinessSignals: {},
    }), []);
    const drift = signals.find((s) => s.id === "applies-to-drift")!;
    const conflict = signals.find((s) => s.id === "conflict-marker")!;
    expect(drift.color).toBe("green");
    expect(conflict.color).toBe("green");
  });

  it("unknown signals never use green/success color", () => {
    const signals = computeReadinessSignals(dec(), []);
    for (const s of signals) {
      if (s.color === "unknown") {
        expect(s.color).not.toBe("green");
      }
    }
  });
});
