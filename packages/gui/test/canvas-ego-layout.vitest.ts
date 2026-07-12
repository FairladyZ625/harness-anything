import { describe, it, expect } from "vitest";
import { layoutCanvasEgo, buildEgoGraph, bfsShown } from "../src/renderer/graph/canvasEgoLayout";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types";
import type { AxisFilter, GraphFilterInput } from "../src/renderer/graph/graphLayoutTypes";

// 精简工厂:布局器只读少数字段,其余用类型断言跳过。
const task = (id: string, extra: Partial<TaskRow> = {}): TaskRow =>
  ({ taskId: id, title: `T ${id}`, coordinationStatus: "active", module: "m", ...extra }) as unknown as TaskRow;
const decision = (id: string, extra: Partial<DecisionRow> = {}): DecisionRow =>
  ({
    decisionId: id,
    title: `D ${id}`,
    state: "active",
    question: "q",
    chosen: [],
    rejected: [],
    claims: [],
    ...extra,
  }) as unknown as DecisionRow;
const fact = (taskId: string, tail: string): FactRef =>
  ({ anchor: `${taskId}/${tail}`, taskId, category: "finding", text: `obs ${tail}`, at: "2026", confidence: "high" }) as unknown as FactRef;
const rel = (from: string, to: string, kind: RelationEdge["kind"]): RelationEdge =>
  ({ from, to, kind, provenance: "local-document" }) as RelationEdge;

const ALL_AXES: AxisFilter = { authority: true, evidence: true, execution: true, assoc: true };
const filters = (over: Partial<GraphFilterInput> = {}): GraphFilterInput => ({
  modules: new Set<string>(),
  types: new Set(["task", "decision", "fact"]),
  axes: ALL_AXES,
  ...over,
});

// 场景:焦点 dec_F。上游 dec_U refines→dec_F(dec_U 更有一个 evidence fact);
// 下游 dec_F derives→task_C;task_C 有子任务 C1/C2;C1 又有孙任务 C1a(第 3 跳)。
function scene() {
  const tasks = [
    task("task_C"),
    task("task_C1", { parentTaskId: "task_C" }),
    task("task_C2", { parentTaskId: "task_C" }),
    task("task_C1a", { parentTaskId: "task_C1" }),
  ];
  const decisions = [
    decision("dec_F", { chosen: [{ id: "CH1", text: "chosen text", evidence: [], whyNot: undefined } as any] }),
    decision("dec_U"),
  ];
  const facts = [fact("task_x", "F1")];
  const relations = [
    rel("decision/dec_U", "decision/dec_F", "refines"), // 上游(focus 是 to → in → left)
    rel("decision/dec_F/CH1", "task/task_C", "derives"), // 下游(focus 是 from → out → right)
    rel("decision/dec_U/C1", "fact/task_x/F1", "evidenced-by"), // dec_U 的证据(第 2 跳上游)
  ];
  return { tasks, decisions, facts, relations };
}

const FOCUS = "decision/dec_F";

function boxesOverlap(a: any, b: any): boolean {
  const aw = a.style.width;
  const ah = a.style.height;
  const bw = b.style.width;
  const bh = b.style.height;
  return (
    a.position.x < b.position.x + bw &&
    b.position.x < a.position.x + aw &&
    a.position.y < b.position.y + bh &&
    b.position.y < a.position.y + ah
  );
}
const centerX = (n: any) => n.position.x + n.style.width / 2;

describe("layoutCanvasEgo", () => {
  const { tasks, decisions, facts, relations } = scene();
  const graph = buildEgoGraph(tasks, decisions, facts, relations);
  const shown = bfsShown(graph, FOCUS, 2, ALL_AXES);
  const out = layoutCanvasEgo({
    focusId: FOCUS,
    tasks,
    decisions,
    facts,
    relations,
    filters: filters(),
    inLoopEdges: new Set(),
    shown,
    expanded: new Set([FOCUS]),
  });
  const byId = new Map(out.nodes.map((n) => [n.id, n]));

  it("合成 task 父子边(parentTaskId 不在 relations 里)", () => {
    // dec_F 的 ±2 跳:C1/C2 是 task_C 子任务;父子边应存在。
    expect(shown.has("task_C1")).toBe(true);
    expect(shown.has("task_C2")).toBe(true);
    expect(out.edges.some((e) => e.id === "e_child_task_C1")).toBe(true);
    expect(out.edges.some((e) => e.id === "e_child_task_C2")).toBe(true);
  });

  it("默认 ±2 跳铺开(第 3 跳 C1a 不在 shown)", () => {
    expect(shown.get(FOCUS)).toBe(0);
    expect(shown.get("decision/dec_U")).toBe(1);
    expect(shown.get("task_C")).toBe(1);
    expect(shown.get("task_C1")).toBe(2);
    expect(shown.has("task_C1a")).toBe(false); // 第 3 跳,默认不铺
  });

  it("焦点居中,上游→左 / 下游→右", () => {
    expect(centerX(byId.get(FOCUS))).toBeCloseTo(0, 0);
    expect(centerX(byId.get("decision/dec_U"))).toBeLessThan(0); // 上游左
    expect(centerX(byId.get("task_C"))).toBeGreaterThan(0); // 下游右
  });

  it("按跳级逐层外扩(第 2 跳比第 1 跳更远)", () => {
    // 下游:C1/C2(第 2 跳)在 task_C(第 1 跳)右侧更远。
    expect(centerX(byId.get("task_C1"))!).toBeGreaterThan(centerX(byId.get("task_C"))!);
    // 上游:fact(第 2 跳)在 dec_U(第 1 跳)左侧更远。
    expect(centerX(byId.get("fact/task_x/F1"))!).toBeLessThan(centerX(byId.get("decision/dec_U"))!);
  });

  it("确定性布局零重叠", () => {
    const ns = out.nodes;
    for (let i = 0; i < ns.length; i += 1) {
      for (let j = i + 1; j < ns.length; j += 1) {
        expect(boxesOverlap(ns[i], ns[j])).toBe(false);
      }
    }
  });

  it("+N 徽章:C1 有未展开的孙任务", () => {
    expect(byId.get("task_C1")!.data.hiddenCount).toBeGreaterThanOrEqual(1);
  });

  it("类型筛选:关掉 fact 后 fact 节点消失,task/decision 保留", () => {
    const out2 = layoutCanvasEgo({
      focusId: FOCUS,
      tasks,
      decisions,
      facts,
      relations,
      filters: filters({ types: new Set(["task", "decision"]) }),
      inLoopEdges: new Set(),
      shown,
      expanded: new Set([FOCUS]),
    });
    const ids = new Set(out2.nodes.map((n) => n.id));
    expect(ids.has("fact/task_x/F1")).toBe(false);
    expect(ids.has("decision/dec_U")).toBe(true);
    expect(ids.has("task_C")).toBe(true);
  });

  it("焦点渲染为卡片(expanded),其余为 chip", () => {
    expect(byId.get(FOCUS)!.data.expanded).toBe(true);
    expect(byId.get(FOCUS)!.style.width).toBe(360); // CARD_W
    expect(byId.get("task_C")!.data.expanded).toBe(false);
    expect(byId.get("task_C")!.style.width).toBe(216); // CHIP_W
  });
});
