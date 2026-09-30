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

// 旧签名是对称 maxHop 数字;现在是一份 {up, down} 预算,等值时与旧行为同集。
const HOPS_1 = { up: 1, down: 1 };
const HOPS_2 = { up: 2, down: 2 };

/**
 * 无限画布 ego(dec_01KXBGJQFQARSZHHQW1WADFDNC)的行为契约,2026-10-01 起按视觉规范
 * §5.2 收口:节点不再有展开态,单击 = 选中 + 抽屉,双击 = 重排邻域。
 * 重点覆盖两件在 rebuild 线上出问题的事:
 *   1. claim 锚定的边(decision/<id>/C1)必须 join 回 decision/<id>,否则聚光灯全空。
 *   2. 布局只输出 chip 尺寸的节点;铺开范围只由 (焦点, 跳数预算, 筛选) 决定。
 */

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
    anchor: "fact/F-1",
    taskId: "task_a",
    category: "finding",
    text: "observation",
    at: "2026-08-01T00:00:00.000Z",
    confidence: "high",
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
  const facts = [fact({ taskId: "task_a", anchor: "fact/F-1", text: "证据" })];
  const relations: RelationEdge[] = [
    { from: "decision/dec_1/CH1", to: "task/task_a", kind: "derives", provenance: "local-document" },
    { from: "decision/dec_1/C1", to: "fact/F-1", kind: "evidenced-by", provenance: "local-document" },
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
    expect(egoFocusIdOf("fact/F-1")).toBe("fact/F-1");
  });
});

describe("claim 锚定边的 join", () => {
  it("decision/<id>/CH1 的出边挂回 decision/<id> 的邻接表", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const neighbors = egoNeighborsOf(graph, "decision/dec_1", filters.axes);
    expect(neighbors).toContain("task_a");
    expect(neighbors).toContain("fact/F-1");
    expect(neighbors).toContain("decision/dec_up");
  });

  it("聚焦 decision 时三类邻居都进画布(不是空泳道)", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShownFromFocus(graph, "decision/dec_1", HOPS_2, filters.axes);
    const layout = layoutEgoCanvas({
      focusId: "decision/dec_1",
      graph,
      relations,
      filters,
      shown,
      highlight: null,
    });
    expect(layout.neighborCount).toBe(3);
    expect(layout.edges.length).toBe(3);
    const entities = layout.nodes.map((n) => n.data.entity).sort();
    expect(entities).toEqual(["decision", "decision", "fact", "task"]);
  });

  it("悬挂端点不造节点(投影里没有的实体不伪造)", () => {
    const graph = buildEgoGraph(
      [task()],
      [],
      [],
      [{ from: "task/task_a", to: "task/task_missing", kind: "depends-on", provenance: "local-document" }],
    );
    expect(egoNeighborsOf(graph, "task_a", filters.axes)).toEqual([]);
  });
});

describe("分层分列", () => {
  it("上游归左、下游归右,焦点在原点", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShownFromFocus(graph, "decision/dec_1", HOPS_2, filters.axes);
    const layout = layoutEgoCanvas({
      focusId: "decision/dec_1",
      graph,
      relations,
      filters,
      shown,
      highlight: null,
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
      from: "task/root",
      to: `task/${id}`,
      kind: "depends-on",
      provenance: "local-document",
    }));
    const graph = buildEgoGraph(tasks, [], [], relations);
    const shown = bfsShownFromFocus(graph, "root", HOPS_2, filters.axes);
    const layout = layoutEgoCanvas({
      focusId: "root",
      graph,
      relations,
      filters,
      shown,
      highlight: null,
    });
    const children = layout.nodes.filter((n) => n.id !== "root").sort((a, b) => a.position.y - b.position.y);
    for (let i = 1; i < children.length; i += 1) {
      const prev = children[i - 1]!;
      expect(children[i]!.position.y).toBeGreaterThanOrEqual(prev.position.y + Number(prev.height ?? 0));
    }
  });
});

describe("无展开态(规范 §5.2:节点只做选中态,内容只在抽屉)", () => {
  it("没有任何节点携带 expanded 标记;焦点与邻居一律 chip 尺寸", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShownFromFocus(graph, "decision/dec_1", HOPS_2, filters.axes);
    const layout = layoutEgoCanvas({
      focusId: "decision/dec_1",
      graph,
      relations,
      filters,
      shown,
      highlight: null,
    });
    expect(layout.nodes.length).toBe(4);
    for (const node of layout.nodes) {
      expect("expanded" in node.data).toBe(false);
    }
    // 全部节点同宽同高(chip 定值)—— 焦点也不再是放大卡片。
    expect(new Set(layout.nodes.map((n) => n.width)).size).toBe(1);
    expect(new Set(layout.nodes.map((n) => n.height)).size).toBe(1);
  });

  it("铺开多少邻居只由跳数预算决定(单击不再长出下一环)", () => {
    const tasks = [task({ taskId: "a" }), task({ taskId: "b" }), task({ taskId: "c" })];
    const relations: RelationEdge[] = [
      { from: "task/a", to: "task/b", kind: "depends-on", provenance: "local-document" },
      { from: "task/b", to: "task/c", kind: "depends-on", provenance: "local-document" },
    ];
    const graph = buildEgoGraph(tasks, [], [], relations);
    // ±1 跳:c 不在画布;把预算放宽到 ±2(双击重排/步进器的纯逻辑等价)c 才进来。
    const one = bfsShownFromFocus(graph, "a", HOPS_1, filters.axes);
    expect(one.has("c")).toBe(false);
    const two = bfsShownFromFocus(graph, "a", HOPS_2, filters.axes);
    expect(two.has("c")).toBe(true);
  });

  it("chip 标注还有多少邻居没铺开", () => {
    const tasks = [task({ taskId: "a" }), task({ taskId: "b" }), task({ taskId: "c" })];
    const relations: RelationEdge[] = [
      { from: "task/a", to: "task/b", kind: "depends-on", provenance: "local-document" },
      { from: "task/b", to: "task/c", kind: "depends-on", provenance: "local-document" },
    ];
    const graph = buildEgoGraph(tasks, [], [], relations);
    const shown = bfsShownFromFocus(graph, "a", HOPS_1, filters.axes);
    const layout = layoutEgoCanvas({
      focusId: "a",
      graph,
      relations,
      filters,
      shown,
      highlight: null,
    });
    expect(layout.nodes.find((n) => n.id === "b")!.data.hiddenCount).toBe(1);
  });
});

describe("筛选与高亮", () => {
  it("类型开关关掉 fact 后 fact 不进画布,但焦点恒可见", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShownFromFocus(graph, "decision/dec_1", HOPS_2, filters.axes);
    const layout = layoutEgoCanvas({
      focusId: "decision/dec_1",
      graph,
      relations,
      filters: { ...filters, types: new Set(["decision", "task"]) },
      shown,
      highlight: null,
    });
    expect(layout.nodes.some((n) => n.data.entity === "fact")).toBe(false);
    expect(layout.nodes.some((n) => n.id === "decision/dec_1")).toBe(true);
  });

  it("单跳高亮把集合外的节点标灰(不删除)", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShownFromFocus(graph, "decision/dec_1", HOPS_2, filters.axes);
    const highlight = egoOneHopHighlight(graph, "task_a", filters.axes)!;
    const layout = layoutEgoCanvas({
      focusId: "decision/dec_1",
      graph,
      relations,
      filters,
      shown,
      highlight,
    });
    expect(layout.nodes.find((n) => n.id === "task_a")!.data.dimmed).toBe(false);
    expect(layout.nodes.find((n) => n.id === "decision/dec_up")!.data.dimmed).toBe(true);
    expect(layout.nodes).toHaveLength(4);
  });

  it("焦点不在投影里时给空布局,不抛异常", () => {
    const graph = buildEgoGraph([task()], [], [], []);
    const layout = layoutEgoCanvas({
      focusId: "decision/missing",
      graph,
      relations: [],
      filters,
      shown: new Map(),
      highlight: null,
    });
    expect(layout.nodes).toEqual([]);
    expect(layout.focusId).toBeNull();
  });
});
