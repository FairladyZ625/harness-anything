// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";
import { computeSpotlightLayout, laneForKind } from "../src/renderer/graph/threeLane.ts";
import { defaultAxisFilter, defaultKindFilter } from "../src/renderer/graph/relationVisual.ts";

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_a", title: "Task A", projectId: "proj",
    coordinationStatus: "active", rawStatus: "active", freshness: "fresh",
    packageDisposition: "active", closeoutReadiness: "not_required",
    engine: "local", source: "local-document", module: "kernel",
    lastKnownAt: "2026-08-01T00:00:00.000Z", gates: [], docs: [],
    ...overrides,
  };
}

function dec(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_1", title: "D1", state: "active", question: "Q?",
    chosen: [], rejected: [], claims: [],
    proposedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as DecisionRow;
}

function fact(overrides: Partial<FactRef> = {}): FactRef {
  return {
    anchor: "task_a/F-1", taskId: "task_a", category: "finding",
    text: "observation", at: "2026-08-01T00:00:00.000Z", confidence: "high",
    ...overrides,
  };
}

const baseFilters = {
  axes: defaultAxisFilter(),
  kinds: defaultKindFilter(),
  modules: new Set<string>(),
  types: new Set(["decision", "task", "fact"]),
  flowMode: "focus" as const,
};

describe("lane classification (KIND_LANE)", () => {
  it("classifies derives as execution (not authority)", () => {
    expect(laneForKind("derives")).toBe("execution");
    expect(laneForKind("refines")).toBe("authority");
    expect(laneForKind("evidenced-by")).toBe("evidence");
  });
});

describe("spotlight three-lane layout", () => {
  it("returns empty layout for null focus", () => {
    const result = computeSpotlightLayout(null, [], [], [], [], [], [], baseFilters);
    expect(result.nodes).toHaveLength(0);
    expect(result.focusEntity).toBeNull();
  });

  it("places focus decision with ego node and lane backgrounds", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1", [task()], [dec()], [], [], relations, [], baseFilters,
    );
    expect(result.focusEntity).toBe("decision");
    const laneNodes = result.nodes.filter((n) => n.type === "laneBackground");
    expect(laneNodes).toHaveLength(3);
    const entityNodes = result.nodes.filter((n) => n.type !== "laneBackground");
    expect(entityNodes.length).toBeGreaterThanOrEqual(2);
  });

  it("assigns derives to execution lane (REQ-GUI-04: 派生 = derives → task)", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1", [task()], [dec()], [], [], relations, [], baseFilters,
    );
    expect(result.laneCounts.execution).toBe(1);
    expect(result.laneCounts.authority).toBe(0);
  });

  it("assigns authority neighbors (refines) to authority lane", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_parent", to: "decision/dec_1", kind: "refines", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1", [], [dec(), dec({ decisionId: "dec_parent" })], [], [], relations, [], baseFilters,
    );
    expect(result.laneCounts.authority).toBe(1);
  });

  it("does not invent entities absent from projections", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_ghost", kind: "derives", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1", [], [dec()], [], [], relations, [], baseFilters,
    );
    const entityNodes = result.nodes.filter((n) => n.type !== "laneBackground");
    expect(entityNodes).toHaveLength(1);
  });

  it("only draws edges involving the focus node (ego graph)", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
      { from: "task/task_a", to: "fact/task_a/F-1", kind: "produces", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1", [task()], [dec()], [fact()], [], relations, [], baseFilters,
    );
    const edgeKinds = result.edges.map((e) => (e.data as any).kind);
    expect(edgeKinds).toContain("derives");
    expect(edgeKinds).not.toContain("produces");
  });

  it("respects axis filter: turning off execution hides derives neighbors", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1", [task()], [dec()], [], [], relations, [],
      { ...baseFilters, axes: { ...baseFilters.axes, execution: false } },
    );
    expect(result.laneCounts.execution).toBe(0);
  });

  it("respects types filter: turning off tasks hides task neighbors", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1", [task()], [dec()], [], [], relations, [],
      { ...baseFilters, types: new Set(["decision", "fact"]) },
    );
    expect(result.laneCounts.execution).toBe(0);
  });

  it("flowMode=all animates all focus edges", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1", [task()], [dec()], [], [], relations, [],
      { ...baseFilters, flowMode: "all" },
    );
    expect(result.edges.every((e) => e.animated)).toBe(true);
  });

  it("flowMode=off disables all animation", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1", [task()], [dec()], [], [], relations, [],
      { ...baseFilters, flowMode: "off" },
    );
    expect(result.edges.every((e) => !e.animated)).toBe(true);
  });

  it("consumes coverageRows: adds covered facts to evidence lane", () => {
    const decision = dec({
      claims: [{ id: "CH1", text: "claim text" }],
      chosen: [{ id: "CH1", text: "claim text", evidence: [] }],
    });
    const f = fact();
    const coverageRows = [{
      decisionRef: "decision/dec_1",
      claimRef: "decision/dec_1/CH1",
      status: "covered" as const,
      fulfillment: "evidenced" as const,
      coveringFactRef: `fact/${f.anchor}`,
      refutingFactRefs: [],
      relationPath: ["rel_1"],
      basisRevision: 1,
    }];
    const result = computeSpotlightLayout(
      "decision/dec_1", [task()], [decision], [f], [], [], coverageRows, baseFilters,
    );
    // The covered fact should appear in the evidence lane.
    expect(result.laneCounts.evidence).toBeGreaterThanOrEqual(1);
  });
});
