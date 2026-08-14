// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";
import {
  buildEgoGraph,
  bfsShownFromFocus,
  egoNeighborsOf,
  egoFocusIdOf,
  egoOneHopHighlight,
  layoutEgoCanvas,
  type EgoFilters,
} from "../src/renderer/graph/egoCanvas.ts";
import { defaultAxisFilter, defaultKindFilter } from "../src/renderer/graph/relationVisual.ts";

/**
 * 无限画布 ego(dec_01KXBGJQFQARSZHHQW1WADFDNC)的行为契约。
 * 重点覆盖两件在 rebuild 线上出问题的事:
 *   1. claim 锚定的边(decision/<id>/C1)必须 join 回 decision/<id>,否则聚光灯全空。
 *   2. 累积展开:展开只增不减,收起保留邻居,单击不重排画布。
 */

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

const filters: EgoFilters = {
  axes: defaultAxisFilter(),
  kinds: defaultKindFilter(),
  types: new Set(["decision", "task", "fact"]),
  flowMode: "focus",
};

/** 真实台账形态:decision 的出边锚在 claim 上(decision/<id>/C1),入边锚在裸 decision 上。 */
function claimAnchoredFixture() {
  const tasks = [task({ taskId: "task_a", title: "派生任务" })];
  const decisions = [dec({ decisionId: "dec_1", title: "本决策" }), dec({ decisionId: "dec_up", title: "上游决策" })];
  const facts = [fact({ taskId: "task_a", anchor: "task_a/F-1", text: "证据" })];
  const relations: RelationEdge[] = [
    { from: "decision/dec_1/CH1", to: "task/task_a", kind: "derives", provenance: "local-document" },
    { from: "decision/dec_1/C1", to: "fact/task_a/F-1", kind: "evidenced-by", provenance: "local-document" },
    { from: "decision/dec_up/CH1", to: "decision/dec_1", kind: "refines", provenance: "local-document" },
  ];
  return { tasks, decisions, facts, relations };
}

describe("ego 图入口不变量", () => {
  it("把各种 endpoint 形态归一到同一键空间", () => {
    expect(egoFocusIdOf("task/task_a")).toBe("task_a");
    expect(egoFocusIdOf("decision/dec_1")).toBe("decision/dec_1");
    // claim 锚定的 ref 收敛回 decision 本体 —— 这正是聚光灯 join 的关键。
    expect(egoFocusIdOf("decision/dec_1/C1")).toBe("decision/dec_1");
    expect(egoFocusIdOf("fact/task_a/F-1")).toBe("fact/task_a/F-1");
  });
});

describe("claim 锚定边的 join", () => {
  it("decision/<id>/CH1 的出边挂回 decision/<id> 的邻接表", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const neighbors = egoNeighborsOf(graph, "decision/dec_1", filters.axes);
    expect(neighbors).toContain("task_a");
    expect(neighbors).toContain("fact/task_a/F-1");
    expect(neighbors).toContain("decision/dec_up");
  });

  it("聚焦 decision 时三类邻居都进画布(不是空泳道)", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShownFromFocus(graph, "decision/dec_1", 2, filters.axes);
    const layout = layoutEgoCanvas({
      focusId: "decision/dec_1", graph, relations, filters,
      shown, expanded: new Set(["decision/dec_1"]), highlight: null,
    });
    expect(layout.neighborCount).toBe(3);
    expect(layout.edges.length).toBe(3);
    const entities = layout.nodes.map((n) => (n.data as any).entity).sort();
    expect(entities).toEqual(["decision", "decision", "fact", "task"]);
  });

  it("悬挂端点不造节点(投影里没有的实体不伪造)", () => {
    const graph = buildEgoGraph([task()], [], [], [
      { from: "task/task_a", to: "task/task_missing", kind: "depends-on", provenance: "local-document" },
    ]);
    expect(egoNeighborsOf(graph, "task_a", filters.axes)).toEqual([]);
  });
});

describe("分层分列", () => {
  it("上游归左、下游归右,焦点在原点", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShownFromFocus(graph, "decision/dec_1", 2, filters.axes);
    const layout = layoutEgoCanvas({
      focusId: "decision/dec_1", graph, relations, filters,
      shown, expanded: new Set(), highlight: null,
    });
    const at = (id: string) => layout.nodes.find((n) => n.id === id)!;
    // 焦点节点盒以自身中心为原点。
    expect(at("decision/dec_1").position.x).toBeLessThanOrEqual(0);
    // dec_up --refines--> dec_1:焦点的入边 → 上游 → 左(负 x)。
    expect(at("decision/dec_up").position.x).toBeLessThan(0);
    // dec_1 --derives--> task_a:出边 → 下游 → 右(正 x)。
    expect(at("task_a").position.x).toBeGreaterThan(0);
  });

  it("同列节点不重叠", () => {
    const tasks = [
      task({ taskId: "root", title: "根" }),
      task({ taskId: "c1", title: "子一" }),
      task({ taskId: "c2", title: "子二" }),
      task({ taskId: "c3", title: "子三" }),
    ];
    const relations: RelationEdge[] = ["c1", "c2", "c3"].map((id) => ({
      from: "task/root", to: `task/${id}`, kind: "depends-on", provenance: "local-document",
    }));
    const graph = buildEgoGraph(tasks, [], [], relations);
    const shown = bfsShownFromFocus(graph, "root", 2, filters.axes);
    const layout = layoutEgoCanvas({
      focusId: "root", graph, relations, filters, shown, expanded: new Set(), highlight: null,
    });
    const children = layout.nodes.filter((n) => n.id !== "root").sort((a, b) => a.position.y - b.position.y);
    for (let i = 1; i < children.length; i += 1) {
      const prev = children[i - 1]!;
      expect(children[i]!.position.y).toBeGreaterThanOrEqual(prev.position.y + Number(prev.height ?? 0));
    }
  });
});

describe("累积展开(决策 CH1:累计保留、永不重置)", () => {
  it("展开一个 chip 会把它的下一环邻居加入可见集", () => {
    const tasks = [task({ taskId: "a" }), task({ taskId: "b" }), task({ taskId: "c" })];
    const relations: RelationEdge[] = [
      { from: "task/a", to: "task/b", kind: "depends-on", provenance: "local-document" },
      { from: "task/b", to: "task/c", kind: "depends-on", provenance: "local-document" },
    ];
    const graph = buildEgoGraph(tasks, [], [], relations);
    // 只铺 1 跳:c 还没进画布。
    const shown = bfsShownFromFocus(graph, "a", 1, filters.axes);
    expect(shown.has("c")).toBe(false);
    // 展开 b = 把 b 的一跳邻居并入 shown(useEgoCanvas.expandNode 的纯逻辑等价)。
    const grown = new Map(shown);
    for (const nb of egoNeighborsOf(graph, "b", filters.axes)) {
      if (!grown.has(nb)) grown.set(nb, (grown.get("b") ?? 0) + 1);
    }
    expect(grown.has("c")).toBe(true);
    // 已有节点的跳数不被改写 —— 画布不重排。
    expect(grown.get("b")).toBe(shown.get("b"));
  });

  it("收起卡片不撤回任何已铺开的节点", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShownFromFocus(graph, "decision/dec_1", 2, filters.axes);
    const expandedLayout = layoutEgoCanvas({
      focusId: "decision/dec_1", graph, relations, filters,
      shown, expanded: new Set(["decision/dec_1", "task_a"]), highlight: null,
    });
    const collapsedLayout = layoutEgoCanvas({
      focusId: "decision/dec_1", graph, relations, filters,
      shown, expanded: new Set(["decision/dec_1"]), highlight: null,
    });
    // 收起 task_a 后节点集合不变(只是它从卡片变回 chip)。
    expect(collapsedLayout.nodes.map((n) => n.id).sort()).toEqual(expandedLayout.nodes.map((n) => n.id).sort());
    expect((collapsedLayout.nodes.find((n) => n.id === "task_a")!.data as any).expanded).toBe(false);
    expect((expandedLayout.nodes.find((n) => n.id === "task_a")!.data as any).expanded).toBe(true);
  });

  it("chip 标注还有多少邻居没铺开", () => {
    const tasks = [task({ taskId: "a" }), task({ taskId: "b" }), task({ taskId: "c" })];
    const relations: RelationEdge[] = [
      { from: "task/a", to: "task/b", kind: "depends-on", provenance: "local-document" },
      { from: "task/b", to: "task/c", kind: "depends-on", provenance: "local-document" },
    ];
    const graph = buildEgoGraph(tasks, [], [], relations);
    const shown = bfsShownFromFocus(graph, "a", 1, filters.axes);
    const layout = layoutEgoCanvas({
      focusId: "a", graph, relations, filters, shown, expanded: new Set(), highlight: null,
    });
    expect((layout.nodes.find((n) => n.id === "b")!.data as any).hiddenCount).toBe(1);
  });
});

describe("筛选与高亮", () => {
  it("类型开关关掉 fact 后 fact 不进画布,但焦点恒可见", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShownFromFocus(graph, "decision/dec_1", 2, filters.axes);
    const layout = layoutEgoCanvas({
      focusId: "decision/dec_1", graph, relations,
      filters: { ...filters, types: new Set(["decision", "task"]) },
      shown, expanded: new Set(), highlight: null,
    });
    expect(layout.nodes.some((n) => (n.data as any).entity === "fact")).toBe(false);
    expect(layout.nodes.some((n) => n.id === "decision/dec_1")).toBe(true);
  });

  it("单跳高亮把集合外的节点标灰(不删除)", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShownFromFocus(graph, "decision/dec_1", 2, filters.axes);
    const highlight = egoOneHopHighlight(graph, "task_a", filters.axes)!;
    const layout = layoutEgoCanvas({
      focusId: "decision/dec_1", graph, relations, filters, shown, expanded: new Set(), highlight,
    });
    expect((layout.nodes.find((n) => n.id === "task_a")!.data as any).dimmed).toBe(false);
    expect((layout.nodes.find((n) => n.id === "decision/dec_up")!.data as any).dimmed).toBe(true);
    expect(layout.nodes).toHaveLength(4);
  });

  it("焦点不在投影里时给空布局,不抛异常", () => {
    const graph = buildEgoGraph([task()], [], [], []);
    const layout = layoutEgoCanvas({
      focusId: "decision/missing", graph, relations: [], filters,
      shown: new Map(), expanded: new Set(), highlight: null,
    });
    expect(layout.nodes).toEqual([]);
    expect(layout.focusId).toBeNull();
  });
});
