// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";
import { computeSpotlightLayout } from "../src/renderer/graph/threeLane.ts";
import { defaultAxisFilter, defaultKindFilter } from "../src/renderer/graph/relationVisual.ts";

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_a",
    title: "Task A",
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "kernel",
    lastKnownAt: "2026-08-01T00:00:00.000Z",
    gates: [],
    docs: [],
    ...overrides,
  };
}

function dec(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_1",
    title: "D1",
    state: "active",
    question: "Q?",
    chosen: [],
    rejected: [],
    claims: [],
    proposedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as DecisionRow;
}

function fact(overrides: Partial<FactRef> = {}): FactRef {
  return {
    anchor: "task_a/F-1",
    taskId: "task_a",
    category: "finding",
    text: "observation",
    at: "2026-08-01T00:00:00.000Z",
    confidence: "high",
    ...overrides,
  };
}

const baseFilters = {
  axes: defaultAxisFilter(),
  kinds: defaultKindFilter(),
  modules: new Set<string>(),
};

describe("spotlight three-lane layout", () => {
  it("returns empty layout for null focus", () => {
    const result = computeSpotlightLayout(null, [], [], [], [], [], baseFilters);
    expect(result.nodes).toHaveLength(0);
    expect(result.focusEntity).toBeNull();
  });

  it("places focus decision in the evidence lane with ego node", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1",
      [task()],
      [dec()],
      [],
      [],
      relations,
      baseFilters,
    );
    expect(result.focusEntity).toBe("decision");
    // ego + lane backgrounds (3) + task neighbor.
    const laneNodes = result.nodes.filter((n) => n.type === "laneBackground");
    expect(laneNodes).toHaveLength(3);
    const entityNodes = result.nodes.filter((n) => n.type !== "laneBackground");
    expect(entityNodes.length).toBeGreaterThanOrEqual(2);
  });

  it("assigns authority neighbors to the authority lane", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_parent", to: "decision/dec_1", kind: "refines", provenance: "local-document" },
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1",
      [task()],
      [dec(), dec({ decisionId: "dec_parent", title: "Parent" })],
      [],
      [],
      relations,
      baseFilters,
    );
    // refines(dec_parent) + derives(task_a) 都是 authority 轴。
    expect(result.laneCounts.authority).toBe(2);
  });

  it("does not invent entities absent from projections", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_ghost", kind: "derives", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1",
      [],
      [dec()],
      [],
      [],
      relations,
      baseFilters,
    );
    const entityNodes = result.nodes.filter((n) => n.type !== "laneBackground");
    // Only the ego decision; ghost task not invented.
    expect(entityNodes).toHaveLength(1);
  });

  it("only draws edges involving the focus node (ego graph)", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
      { from: "task/task_a", to: "fact/task_a/F-1", kind: "produces", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1",
      [task()],
      [dec()],
      [fact()],
      [],
      relations,
      baseFilters,
    );
    // derives edge involves focus; produces edge does not → filtered out.
    const edgeKinds = result.edges.map((e) => (e.data as any).kind);
    expect(edgeKinds).toContain("derives");
    expect(edgeKinds).not.toContain("produces");
  });

  it("respects axis filter: turning off authority hides authority neighbors", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_parent", to: "decision/dec_1", kind: "refines", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1",
      [],
      [dec(), dec({ decisionId: "dec_parent" })],
      [],
      [],
      relations,
      { ...baseFilters, axes: { ...baseFilters.axes, authority: false } },
    );
    expect(result.laneCounts.authority).toBe(0);
  });
});
