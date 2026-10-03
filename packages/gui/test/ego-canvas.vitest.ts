// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";
import {
  buildEgoGraph,
  bfsShownFromFocus,
  egoNeighborsOf,
  egoFocusIdOf,
  layoutEgoCanvas,
  type EgoFilters,
} from "../src/renderer/graph/egoCanvas.ts";
import { defaultAxisFilter, defaultKindFilter } from "../src/renderer/graph/relationVisual.ts";

// 旧签名是对称 maxHop 数字;现在是一份 {up, down} 预算,等值时与旧行为同集。
const HOPS_1 = { up: 1, down: 1 };
const HOPS_2 = { up: 2, down: 2 };

/**
 * 无限画布 ego(dec_01KXBGJQFQARSZHHQW1WADFDNC)的行为契约。图场景 2026-10-02 恢复
 * 节点原位展开(task_baca8e2b3e32c288fbd14b71f0,业主批准):单击 = 原位成卡 + 长出
 * 下一环;抽屉不再承载节点正文。重点覆盖两件在 rebuild 线上出问题的事:
 *   1. claim 锚定的边(decision/<id>/C1)必须 join 回 decision/<id>,否则聚光灯全空。
 *   2. 布局的节点尺寸随展开态变化;铺开范围由 (焦点, 跳数预算, 筛选) + 显式展开决定。
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
      expanded: new Set(),
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
      expanded: new Set(),
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
      expanded: new Set(),
    });
    const children = layout.nodes.filter((n) => n.id !== "root").sort((a, b) => a.position.y - b.position.y);
    for (let i = 1; i < children.length; i += 1) {
      const prev = children[i - 1]!;
      expect(children[i]!.position.y).toBeGreaterThanOrEqual(prev.position.y + Number(prev.height ?? 0));
    }
  });
});

describe("原位展开(图场景 2026-10-02:展开节点成卡片,尺寸随内容)", () => {
  it("相同 shown/focus 下展开不改变任何中心,全部成卡后仍无重叠", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShownFromFocus(graph, "decision/dec_1", HOPS_2, filters.axes);
    const input = { focusId: "decision/dec_1", graph, relations, filters, shown };
    const chips = layoutEgoCanvas({ ...input, expanded: new Set() });
    const cards = layoutEgoCanvas({ ...input, expanded: new Set(shown.keys()) });
    for (const node of cards.nodes) {
      const before = chips.nodes.find((other) => other.id === node.id)!;
      expect([node.position.x + Number(node.width) / 2, node.position.y + Number(node.height) / 2]).toEqual([
        before.position.x + Number(before.width) / 2,
        before.position.y + Number(before.height) / 2,
      ]);
      for (const other of cards.nodes) {
        if (node.id === other.id) continue;
        const separated =
          node.position.x + Number(node.width) <= other.position.x ||
          other.position.x + Number(other.width) <= node.position.x ||
          node.position.y + Number(node.height) <= other.position.y ||
          other.position.y + Number(other.height) <= node.position.y;
        expect(separated).toBe(true);
      }
    }
  });
  it("未展开的节点一律 chip 尺寸;展开的节点按卡片尺寸参与分列", () => {
    const { tasks, decisions, facts, relations } = claimAnchoredFixture();
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShownFromFocus(graph, "decision/dec_1", HOPS_2, filters.axes);
    const layout = layoutEgoCanvas({
      focusId: "decision/dec_1",
      graph,
      relations,
      filters,
      shown,
      expanded: new Set(),
    });
    expect(layout.nodes.length).toBe(4);
    for (const node of layout.nodes) {
      expect(node.data.expanded).toBe(false);
    }
    // 全部节点同宽同高(chip 定值)。
    expect(new Set(layout.nodes.map((n) => n.width)).size).toBe(1);
    expect(new Set(layout.nodes.map((n) => n.height)).size).toBe(1);

    // 展开 task_a:该节点成卡(更宽更高),data.expanded 翻真,其余保持 chip。
    const expandedLayout = layoutEgoCanvas({
      focusId: "decision/dec_1",
      graph,
      relations,
      filters,
      shown,
      expanded: new Set(["task_a"]),
    });
    const card = expandedLayout.nodes.find((n) => n.id === "task_a")!;
    const other = expandedLayout.nodes.find((n) => n.id === "fact/F-1")!;
    expect(card.data.expanded).toBe(true);
    expect(card.width!).toBeGreaterThan(other.width!);
    expect(card.height!).toBeGreaterThan(other.height!);
    expect(other.data.expanded).toBe(false);
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
      expanded: new Set(),
    });
    expect(layout.nodes.find((n) => n.id === "b")!.data.hiddenCount).toBe(1);
  });
});

describe("筛选", () => {
  it("类型筛选移除中间节点后仍为孤立的 shown 节点摆放有限中心", () => {
    const tasks = [task({ taskId: "root" }), task({ taskId: "leaf" })];
    const decisions = [dec()];
    const relations: RelationEdge[] = [
      { from: "task/root", to: "decision/dec_1", kind: "derives", provenance: "local-document" },
      { from: "decision/dec_1", to: "task/leaf", kind: "derives", provenance: "local-document" },
    ];
    const graph = buildEgoGraph(tasks, decisions, [], relations);
    const layout = layoutEgoCanvas({
      focusId: "root",
      graph,
      relations,
      shown: bfsShownFromFocus(graph, "root", HOPS_2, filters.axes),
      expanded: new Set(),
      filters: { ...filters, types: new Set(["task"]) },
    });
    expect(layout.nodes.map((node) => node.id)).toEqual(["root", "leaf"]);
    const leaf = layout.nodes.find((node) => node.id === "leaf")!;
    expect(Number.isFinite(leaf.position.x) && Number.isFinite(leaf.position.y)).toBe(true);
    expect(leaf.position.x).toBeGreaterThan(0);
  });
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
      expanded: new Set(),
    });
    expect(layout.nodes.some((n) => n.data.entity === "fact")).toBe(false);
    expect(layout.nodes.some((n) => n.id === "decision/dec_1")).toBe(true);
  });

  it("焦点不在投影里时给空布局,不抛异常", () => {
    const graph = buildEgoGraph([task()], [], [], []);
    const layout = layoutEgoCanvas({
      focusId: "decision/missing",
      graph,
      relations: [],
      filters,
      shown: new Map(),
      expanded: new Set(),
    });
    expect(layout.nodes).toEqual([]);
    expect(layout.focusId).toBeNull();
  });
});
