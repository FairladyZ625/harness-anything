// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { groupDecisions, UNASSIGNED_GROUP } from "../src/renderer/model/decision-pool-grouping.ts";
import type { DecisionRow } from "../src/renderer/model/types.ts";

function dec(id: string, patch: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: id, title: id, state: "proposed", question: "Q?",
    chosen: [], rejected: [], claims: [], proposedAt: "2026-08-01T00:00:00.000Z",
  } as DecisionRow, { ...({ decisionId: id, title: id, state: "proposed", question: "Q?", chosen: [], rejected: [], claims: [], proposedAt: "2026-08-01T00:00:00.000Z" } as DecisionRow), ...patch } as DecisionRow;
}

describe("decision pool PLT grouping (REQ-GUI-06)", () => {
  it("groups by appliesTo.productLines and counts multi-PLT rows in every group", () => {
    const rows = [
      dec("dec_1", { appliesTo: { modules: [], productLines: ["plt-a", "plt-b"] } }),
      dec("dec_2", { appliesTo: { modules: [], productLines: ["plt-a"] } }),
    ];
    const groups = groupDecisions(rows, "productLine");
    expect(groups.map((g) => g.key)).toEqual(["plt-a", "plt-b"]);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[1].rows).toHaveLength(1);
  });

  it("keeps unprojected PLT explicit and sinks it below real product lines", () => {
    const rows = [dec("dec_x"), dec("dec_y", { appliesTo: { modules: [], productLines: ["plt-a"] } })];
    const groups = groupDecisions(rows, "productLine");
    expect(groups.at(-1)?.key).toBe(UNASSIGNED_GROUP);
    expect(groups.at(-1)?.title).toBe("未投影 PLT");
    expect(groups.at(-1)?.rows).toHaveLength(1);
  });

  it("returns a single flat group when grouping is off, and groups verticals when asked", () => {
    expect(groupDecisions([dec("dec_1")], "none")).toHaveLength(1);
    const groups = groupDecisions(
      [dec("dec_1", { vertical: "coding" }), dec("dec_2")],
      "vertical",
    );
    expect(groups.map((g) => g.title)).toEqual(["coding", "未知 vertical"]);
  });
});
