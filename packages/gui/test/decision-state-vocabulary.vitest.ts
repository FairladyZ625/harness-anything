// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { buildTriadicRendererData } from "../src/renderer/triadic-data.ts";
import { DECISION_STATE_FILTER_OPTIONS } from "../src/renderer/graph/entityStatusFilter.ts";
import zhComponents from "../src/renderer/i18n/locales/zh-CN/components.json";
import enComponents from "../src/renderer/i18n/locales/en-US/components.json";
import type { DecisionProjectionRow } from "../src/api/renderer-dto.ts";
import type { DecisionState } from "../src/renderer/model/types.ts";

const emptyGraph = {
  ok: true as const,
  edges: [],
  coverageRows: [],
  factAnchors: [],
  facts: [],
  warnings: []
};

function decisionRow(state: string): DecisionProjectionRow {
  return {
    schema: "decision-row/v1",
    decisionId: "dec_test",
    path: "decisions/decision-dec_test/decision.md",
    state: state as DecisionProjectionRow["state"],
    title: "T",
    question: "Q",
    riskTier: "low",
    urgency: "low",
    vertical: "v",
    preset: "p",
    decisionClass: "ordinary",
    appliesTo: { modules: [], productLines: [] },
    proposer: { principal: { personId: "person_zeyu" }, executor: null },
    arbiter: null,
    proposedAt: "2026-08-18T00:00:00.000Z",
    decidedAt: null,
    workspaceRevision: 1,
    chosen: [],
    rejected: [],
    claims: [],
    judgmentConsents: [],
    body: null
  } as DecisionProjectionRow;
}

function adaptedState(state: string): DecisionState {
  return buildTriadicRendererData({ graph: emptyGraph, decisions: { ok: true, decisions: [decisionRow(state)], warnings: [] } }).decisions[0]!.state;
}

describe("decision state vocabulary (ADR-0020 D1 · blueprint 铁律四)", () => {
  it("renders a superseded decision as superseded, not as awaiting approval", () => {
    // The deleted defect: decisionState() only knew five words and fell back to
    // "proposed", so a superseded decision displayed as pending approval.
    expect(adaptedState("superseded")).toBe("superseded");
    expect(adaptedState("superseded")).not.toBe("proposed");
  });

  it("renders an unrecognised state as unknown, never as a plausible neighbour", () => {
    expect(adaptedState("bogus_future_state")).toBe("unknown");
    expect(adaptedState("")).toBe("unknown");
  });

  it("passes every kernel decision state through unchanged", () => {
    for (const state of ["proposed", "active", "rejected", "deferred", "superseded", "retired"]) {
      expect(adaptedState(state)).toBe(state);
    }
  });

  it("keeps superseded addressable in the graph filter and badge labels in both locales", () => {
    // The badge meta is an exhaustive Record<DecisionState, ...> (compile-checked);
    // here we pin the visible surface: the filter option and localized labels exist.
    expect(DECISION_STATE_FILTER_OPTIONS).toContain("superseded");
    expect(zhComponents["components.badges.superseded"]).toBe("已取代");
    expect(enComponents["components.badges.superseded"]).toBe("Superseded");
    expect(zhComponents["components.badges.unknown"]).toBeTruthy();
    expect(enComponents["components.badges.unknown"]).toBeTruthy();
  });
});
