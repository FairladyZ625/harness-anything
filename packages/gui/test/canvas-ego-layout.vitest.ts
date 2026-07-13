import { describe, it, expect } from "vitest";
import {
  layoutCanvasEgo,
  buildEgoGraph,
  bfsShown,
  egoFocusIdOf,
  estimateCardHeight,
} from "../src/renderer/graph/canvasEgoLayout";
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

// ══ D1:领地→聚光灯 ID 命名空间归一 ══
// 复现:territoryLayout.buildChipNode 给 task chip 发射的 navRef 是 `task/<id>` 形态,
// 而 ego 图 byId 的 task 键是裸 id(canvasEgoLayout.buildEgoGraph)。
// 修复前 useEgoCanvas.openFocus 直接把 navRef 当 focusId → bfsShown 从 task/<id> 出发,
// adj/byId 都键不上 → 焦点不在 byId → layoutCanvasEgo 丢弃 → 0 节点(空白画布)。
// 修复:导出 egoFocusIdOf 作为 ego 图入口不变量,openFocus 必须经它归一。
describe("D1 · egoFocusIdOf (territory chip → ego 焦点归一)", () => {
  it("task/<id> 归一为裸 id(territory chip navRef 形态)", () => {
    // territoryLayout.buildChipNode:m.entity === "task" ? `task/${m.id}` : m.id
    expect(egoFocusIdOf("task/task_01ABC")).toBe("task_01ABC");
  });

  it("decision/<id> 与裸 task id 原样通过(其他入口形态)", () => {
    // decision chip navRef = `decision/${id}`(已与 byId 键对齐)
    expect(egoFocusIdOf("decision/dec_X")).toBe("decision/dec_X");
    // FocusSwitcher / 双击 / 抽屉「设为焦点」传的是裸 task id
    expect(egoFocusIdOf("task_01ABC")).toBe("task_01ABC");
    // fact ref 原样通过
    expect(egoFocusIdOf("fact/task_x/F1")).toBe("fact/task_x/F1");
  });

  it("领地 task chip navRef 经 egoFocusIdOf 后喂进 ego 图 >0 节点(集成)", () => {
    // 真实场景:task_C 有子任务 C1/C2;从领地点 task_C chip 进聚光灯。
    const { tasks, decisions, facts, relations } = scene();
    const navRef = "task/task_C"; // territoryLayout 给 task_C chip 的 navRef
    const focusId = egoFocusIdOf(navRef); // 修复后 openFocus 内部做这步
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShown(graph, focusId, 2, ALL_AXES);
    const out = layoutCanvasEgo({
      focusId,
      tasks,
      decisions,
      facts,
      relations,
      filters: filters(),
      inLoopEdges: new Set(),
      shown,
      expanded: new Set([focusId]),
    });
    expect(out.nodes.length).toBeGreaterThan(0);
    expect(out.nodes.some((n) => n.id === "task_C")).toBe(true);
    // 焦点本身必须渲染为卡片
    const focus = out.nodes.find((n) => n.id === "task_C");
    expect(focus?.data.expanded).toBe(true);
  });

  it("阴性对照:不经归一直接用 navRef 当 focusId → 0 节点(复现 D1 bug)", () => {
    // 这是修复前 useEgoCanvas.openFocus 的行为:直接 setFocusId(navRef)。
    const { tasks, decisions, facts, relations } = scene();
    const navRef = "task/task_C"; // 未经 egoFocusIdOf 归一
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    // byId 键为裸 task id,task/task_C 不在里面
    expect(graph.byId.has(navRef)).toBe(false);
    expect(graph.byId.has(egoFocusIdOf(navRef))).toBe(true);
    const out = layoutCanvasEgo({
      focusId: navRef,
      tasks,
      decisions,
      facts,
      relations,
      filters: filters(),
      inLoopEdges: new Set(),
      shown: bfsShown(graph, navRef, 2, ALL_AXES),
      expanded: new Set([navRef]),
    });
    // bug:焦点不在 byId → vis 集为空 → 0 节点
    expect(out.nodes.length).toBe(0);
  });
});

// ══ D4:task 卡片高度内容感知 ══
// 修复前 estimateCardHeight 对 task 永远返回 150,长标题被截、短标题浪费空间。
describe("D4 · estimateCardHeight(task 内容感知)", () => {
  it("短标题 task 卡片高度基线", () => {
    const t = task("t_short", { title: "短标题" });
    const h = estimateCardHeight("task", t);
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThanOrEqual(260); // 合理上限
  });

  it("长标题 task 卡片比短标题高(内容感知)", () => {
    const shortT = task("t_s", { title: "short" });
    const longT = task("t_l", { title: "X".repeat(120) });
    const shortH = estimateCardHeight("task", shortT);
    const longH = estimateCardHeight("task", longT);
    // 修复前:两者都返回 150(完全相等,bug)。修复后:长标题需要更多行 → 更高。
    expect(longH).toBeGreaterThan(shortH);
  });

  it("task 卡片高度不再是无视内容的常量 150(回归)", () => {
    // 修复前:任何 task 都返回 exactly 150。修复后:基线随内容浮动。
    const t = task("t", { title: "a".repeat(80) });
    const h = estimateCardHeight("task", t);
    expect(h).not.toBe(150);
  });
});
