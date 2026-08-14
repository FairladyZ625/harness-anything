// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow, DecisionRow, RelationEdge } from "../src/renderer/model/types.ts";
import {
  buildEgoGraph,
  bfsShownFromFocus,
  layoutEgoCanvas,
  type EgoFilters,
} from "../src/renderer/graph/egoCanvas.ts";
import { defaultAxisFilter, defaultKindFilter } from "../src/renderer/graph/relationVisual.ts";

/**
 * 实体解析的诚实性回归:fact 锚点可以成节点,但正文绝不编造。
 * (原挂在 computeSpotlightLayout 上,随三泳道布局一起迁到无限画布 ego。)
 */

function task(): TaskRow {
  return {
    taskId: "task_a", title: "Task A", projectId: "proj",
    coordinationStatus: "active", rawStatus: "active", freshness: "fresh",
    packageDisposition: "active", closeoutReadiness: "not_required",
    engine: "local", source: "local-document", module: "kernel",
    lastKnownAt: "2026-08-01T00:00:00.000Z", gates: [], docs: [],
  };
}

function dec(): DecisionRow {
  return {
    decisionId: "dec_1", title: "D1", state: "active", question: "Q?",
    chosen: [{ id: "CH1", text: "c", evidence: [] }], rejected: [],
    claims: [{ id: "CH1", text: "c" }], proposedAt: "2026-08-01T00:00:00.000Z",
  } as DecisionRow;
}

const filters: EgoFilters = {
  axes: defaultAxisFilter(),
  kinds: defaultKindFilter(),
  types: new Set(["decision", "task", "fact"]),
  flowMode: "focus",
};

function layoutFrom(
  relations: RelationEdge[],
  factAnchors: Array<{ factRef: string; taskId: string; factId: string }>,
) {
  const graph = buildEgoGraph([task()], [dec()], [], relations, factAnchors);
  const shown = bfsShownFromFocus(graph, "decision/dec_1", 2, filters.axes);
  return layoutEgoCanvas({
    focusId: "decision/dec_1", graph, relations, filters,
    shown, expanded: new Set(["decision/dec_1"]), highlight: null,
  });
}

describe("graph entity resolution (fact anchors without inventing bodies)", () => {
  it("renders task/decision/fact nodes from real relations", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
      { from: "task/task_a", to: "fact/task_a/F-001", kind: "produces", provenance: "local-document" },
      { from: "decision/dec_1/CH1", to: "fact/task_a/F-001", kind: "evidenced-by", provenance: "local-document" },
    ];
    const result = layoutFrom(relations, [
      { factRef: "fact/task_a/F-001", taskId: "task_a", factId: "F-001" },
    ]);
    const entities = result.nodes.map((n) => (n.data as any).entity);
    expect(entities.filter((e) => e === "decision")).toHaveLength(1);
    expect(entities.filter((e) => e === "task")).toHaveLength(1);
    expect(entities.filter((e) => e === "fact")).toHaveLength(1);
  });

  it("keeps an anchor-only fact visible but leaves its body empty", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1/CH1", to: "fact/task_a/F-001", kind: "evidenced-by", provenance: "local-document" },
    ];
    const result = layoutFrom(relations, [
      { factRef: "fact/task_a/F-001", taskId: "task_a", factId: "F-001" },
    ]);
    const factNode = result.nodes.find((n) => n.id === "fact/task_a/F-001");
    expect(factNode).toBeDefined();
    // 标签退回锚点,正文为空 —— 不拿别处文字冒充观察。
    expect((factNode!.data as any).raw.text).toBe("");
    expect((factNode!.data as any).label).toBe("task_a/F-001");
  });

  it("does not invent fact nodes for refs absent from both facts and anchors", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
      { from: "decision/dec_1/CH1", to: "fact/task_a/F-ghost", kind: "evidenced-by", provenance: "local-document" },
    ];
    const result = layoutFrom(relations, []);
    expect(result.nodes.find((n) => n.id === "fact/task_a/F-ghost")).toBeUndefined();
  });
});
