// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { DecisionRow } from "../src/renderer/model/types.ts";
import { sortDecisionQueue } from "../src/renderer/model/triadic.ts";

function decision(patch: Partial<DecisionRow>): DecisionRow {
  return {
    decisionId: "dec_x", title: "d", state: "proposed", question: "q",
    chosen: [], rejected: [], claims: [], judgmentConsents: [], body: null,
    ...patch,
  };
}

describe("sortDecisionQueue (overview decision stream / decisions inbox / decision pool)", () => {
  it("keeps risk as the primary key: a stale high-risk decision outranks a fresh low-risk one", () => {
    const rows = sortDecisionQueue([
      decision({ decisionId: "low-fresh", riskTier: "low", urgency: "low", proposedAt: "2026-08-21T10:00:00.000Z" }),
      decision({ decisionId: "high-stale", riskTier: "high", urgency: "low", proposedAt: "2026-08-01T10:00:00.000Z" }),
    ]);
    expect(rows.map((row) => row.decisionId)).toEqual(["high-stale", "low-fresh"]);
  });

  it("breaks risk ties by urgency high→low", () => {
    const rows = sortDecisionQueue([
      decision({ decisionId: "u-low", riskTier: "high", urgency: "low", proposedAt: "2026-08-21T10:00:00.000Z" }),
      decision({ decisionId: "u-high", riskTier: "high", urgency: "high", proposedAt: "2026-08-01T10:00:00.000Z" }),
    ]);
    expect(rows.map((row) => row.decisionId)).toEqual(["u-high", "u-low"]);
  });

  it("orders same risk/urgency band by proposedAt DESCENDING — newest first (2026-08-21 fix)", () => {
    const rows = sortDecisionQueue([
      decision({ decisionId: "oldest", riskTier: "medium", urgency: "medium", proposedAt: "2026-08-01T09:00:00.000Z" }),
      decision({ decisionId: "newest", riskTier: "medium", urgency: "medium", proposedAt: "2026-08-21T09:00:00.000Z" }),
      decision({ decisionId: "middle", riskTier: "medium", urgency: "medium", proposedAt: "2026-08-11T09:00:00.000Z" }),
    ]);
    expect(rows.map((row) => row.decisionId)).toEqual(["newest", "middle", "oldest"]);
  });

  it("treats missing proposedAt as the oldest inside its band and unknown axes after ranked ones", () => {
    const rows = sortDecisionQueue([
      decision({ decisionId: "no-time", riskTier: "medium", urgency: "medium" }),
      decision({ decisionId: "timed", riskTier: "medium", urgency: "medium", proposedAt: "2026-08-20T09:00:00.000Z" }),
      decision({ decisionId: "no-axes" }),
    ]);
    expect(rows.map((row) => row.decisionId)).toEqual(["timed", "no-time", "no-axes"]);
  });
});
