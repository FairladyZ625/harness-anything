import { describe, it, expect, beforeAll } from "vitest";
import {
  layoutCanvasEgo,
  buildEgoGraph,
  bfsShown,
  egoFocusIdOf,
  estimateCardHeight,
} from "../src/renderer/graph/canvasEgoLayout";
import type { LayoutOutput } from "../src/renderer/graph/graphLayoutTypes";
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
  const aw = a.width;
  const ah = a.height;
  const bw = b.width;
  const bh = b.height;
  return (
    a.position.x < b.position.x + bw &&
    b.position.x < a.position.x + aw &&
    a.position.y < b.position.y + bh &&
    b.position.y < a.position.y + ah
  );
}
const centerX = (n: any) => n.position.x + n.width / 2;

describe("layoutCanvasEgo", () => {
  const { tasks, decisions, facts, relations } = scene();
  const graph = buildEgoGraph(tasks, decisions, facts, relations);
  const shown = bfsShown(graph, FOCUS, 2, ALL_AXES);
  let out: LayoutOutput;
  let byId: Map<string, any>;
  beforeAll(async () => {
    out = await layoutCanvasEgo({
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
    byId = new Map(out.nodes.map((n) => [n.id, n]));
  });

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

  it("按跳级逐层外扩(下游第 2 跳比第 1 跳更远)", () => {
    // 下游:C1/C2(第 2 跳)在 task_C(第 1 跳)右侧更远。
    expect(centerX(byId.get("task_C1"))!).toBeGreaterThan(centerX(byId.get("task_C"))!);
    // C:ELK 按 edge direction 分层(dec_U→fact_x),fact_x 落在 dec_U 右侧而非 BFS hop 的更远上游。
    // 这里只验「相连节点不同列」—— fact_x 与 dec_U 有边,ELK 必分到不同列。
    expect(centerX(byId.get("fact/task_x/F1"))!).not.toEqual(centerX(byId.get("decision/dec_U"))!);
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

  it("类型筛选:关掉 fact 后 fact 节点消失,task/decision 保留", async () => {
    const out2 = await layoutCanvasEgo({
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
    // G1:决策卡片宽 = 320(按 kind 分档,不再一刀切 360)。B2:改用顶层 width(不再写 style.width)。
    expect(byId.get(FOCUS)!.width).toBe(320);
    expect(byId.get("task_C")!.data.expanded).toBe(false);
    expect(byId.get("task_C")!.width).toBe(216); // CHIP_W
  });

  // C:ELK 正交路由后,edge.data.route 携带 bend points(start/end + 中间折点)。
  // InteractiveEdge 据此拼 SVG path;route 缺失时才回退 getSmoothStepPath。
  it("C · 边携带 ELK 正交路由(bend points)", () => {
    const routed = out.edges.filter((e) => Array.isArray((e.data as any)?.route));
    // 至少有一条边带路由(场景里有 5+ 条边,ELK 通常全部路由)。
    expect(routed.length).toBeGreaterThan(0);
    const sample = routed[0];
    const pts = (sample.data as any).route as Array<{ x: number; y: number }>;
    expect(pts.length).toBeGreaterThanOrEqual(2);
    // 折点都是有限数(防 NaN/Infinity 进 SVG path)。
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  // C(P0 回归):边折线必须与节点共享同一个坐标空间。InteractiveEdge 把 data.route 当
  // 绝对 SVG path 消费(绕过 RF 的 sourceX/sourceY),所以 route 的起点必须落在源节点盒
  // 的边界上、终点必须落在目标节点盒的边界上。修复前 centerOnFocus 先位移了 positions,
  // translateRoutes 再从已位移的 positions 反推 delta 得到 ≈0 → 折线留在 raw ELK 坐标,
  // 节点却是 focus-centered → 起止点漂离源/目标盒数百像素。
  it("C · ELK 路由起止点锚在源/目标节点盒上(同一坐标空间,P0 回归)", () => {
    const tol = 1.0; // 1px 浮点容差;ELK 把端点放在节点边界,distToBox 应为 0。
    const distToBox = (
      p: { x: number; y: number },
      box: { x: number; y: number; w: number; h: number },
    ): number => {
      const dx = Math.max(box.x - p.x, 0, p.x - (box.x + box.w));
      const dy = Math.max(box.y - p.y, 0, p.y - (box.y + box.h));
      return Math.hypot(dx, dy);
    };
    const routed = out.edges.filter((e) => Array.isArray((e.data as any)?.route));
    expect(routed.length).toBeGreaterThan(0);
    for (const e of routed) {
      const pts = (e.data as any).route as Array<{ x: number; y: number }>;
      const src = byId.get(e.source);
      const tgt = byId.get(e.target);
      expect(src).toBeDefined();
      expect(tgt).toBeDefined();
      const srcBox = {
        x: src!.position.x,
        y: src!.position.y,
        w: src!.width as number,
        h: src!.height as number,
      };
      const tgtBox = {
        x: tgt!.position.x,
        y: tgt!.position.y,
        w: tgt!.width as number,
        h: tgt!.height as number,
      };
      // 起点落在源节点盒边界上、终点落在目标节点盒边界上(同坐标空间不变量)。
      expect(distToBox(pts[0], srcBox)).toBeLessThanOrEqual(tol);
      expect(distToBox(pts[pts.length - 1], tgtBox)).toBeLessThanOrEqual(tol);
    }
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

  it("领地 task chip navRef 经 egoFocusIdOf 后喂进 ego 图 >0 节点(集成)", async () => {
    // 真实场景:task_C 有子任务 C1/C2;从领地点 task_C chip 进聚光灯。
    const { tasks, decisions, facts, relations } = scene();
    const navRef = "task/task_C"; // territoryLayout 给 task_C chip 的 navRef
    const focusId = egoFocusIdOf(navRef); // 修复后 openFocus 内部做这步
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    const shown = bfsShown(graph, focusId, 2, ALL_AXES);
    const out = await layoutCanvasEgo({
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

  it("阴性对照:不经归一直接用 navRef 当 focusId → 0 节点(复现 D1 bug)", async () => {
    // 这是修复前 useEgoCanvas.openFocus 的行为:直接 setFocusId(navRef)。
    const { tasks, decisions, facts, relations } = scene();
    const navRef = "task/task_C"; // 未经 egoFocusIdOf 归一
    const graph = buildEgoGraph(tasks, decisions, facts, relations);
    // byId 键为裸 task id,task/task_C 不在里面
    expect(graph.byId.has(navRef)).toBe(false);
    expect(graph.byId.has(egoFocusIdOf(navRef))).toBe(true);
    const out = await layoutCanvasEgo({
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

// ══ G1:内容驱动尺寸 + 竖优先地板 ══
// 节点宽按 kind 分档(fact 280 / task 300 / decision 320),高按内容估算 + 地板(W:H ≤ 0.85)
// + 硬 cap(640)。estimateCardHeight 只返内容估高(无地板无 cap);nodeDims 叠地板与 cap。
// B1:EgoNode body 改为始终 overflow-y-auto(Tailwind 在不溢出时不渲染滚动条),node.data 不再
// 携带 scrollable —— 真实内容超过估高也会被滚动条兜底,而非 overflow-hidden 静默剪裁。
describe("G1 · 内容驱动尺寸 + 竖优先地板", () => {
  it("estimateCardHeight 对 decision 包含 rejected 段(原漏算)", () => {
    const dNoRej = decision("d1");
    const dWithRej = decision("d2", {
      rejected: [
        { id: "RJ1", text: "rejected option", evidence: [], whyNot: "reason" } as any,
      ],
    });
    const hNoRej = estimateCardHeight("decision", dNoRej);
    const hWithRej = estimateCardHeight("decision", dWithRej);
    // types.ts:145 标注 rejected 必填非空,但原公式漏算 → 现在补上。
    expect(hWithRej).toBeGreaterThan(hNoRej);
  });

  it("expanded fact 节点 W:H ≤ 0.85(竖优先地板)", async () => {
    const f = fact("task_x", "F1");
    const id = `fact/${f.taskId}/${f.anchor.split("/")[1] ?? f.anchor}`;
    const out = await layoutCanvasEgo({
      focusId: id,
      tasks: [],
      decisions: [],
      facts: [f],
      relations: [],
      filters: filters(),
      inLoopEdges: new Set(),
      shown: new Map([[id, 0]]),
      expanded: new Set([id]),
    });
    const node = out.nodes.find((n) => n.id === id)!;
    // B2:尺寸改用顶层 width/height(不再写 style.width/height)。
    const w = node.width as number;
    const h = node.height as number;
    // W:H ≤ 0.85(竖优先地板),允许少许浮点。
    expect(w / h).toBeLessThanOrEqual(0.85 + 0.01);
    // G1 §④ 验收:fact ≤200 字时 h ≥ 280。
    expect(h).toBeGreaterThanOrEqual(280);
  });

  it("expanded task 节点 W:H ≤ 0.85(竖优先地板)", async () => {
    const t = task("task_short", { title: "x" });
    const id = t.taskId;
    const out = await layoutCanvasEgo({
      focusId: id,
      tasks: [t],
      decisions: [],
      facts: [],
      relations: [],
      filters: filters(),
      inLoopEdges: new Set(),
      shown: new Map([[id, 0]]),
      expanded: new Set([id]),
    });
    const node = out.nodes.find((n) => n.id === id)!;
    const w = node.width as number;
    const h = node.height as number;
    expect(w / h).toBeLessThanOrEqual(0.85 + 0.01);
  });

  it("expanded decision 节点 W:H ≤ 0.85(竖优先地板)", async () => {
    const d = decision("dec_short");
    const id = `decision/${d.decisionId}`;
    const out = await layoutCanvasEgo({
      focusId: id,
      tasks: [],
      decisions: [d],
      facts: [],
      relations: [],
      filters: filters(),
      inLoopEdges: new Set(),
      shown: new Map([[id, 0]]),
      expanded: new Set([id]),
    });
    const node = out.nodes.find((n) => n.id === id)!;
    const w = node.width as number;
    const h = node.height as number;
    expect(w / h).toBeLessThanOrEqual(0.85 + 0.01);
  });

  it("decision 三段内容(Q+chosen+rejected)高度 ≤ 630px", async () => {
    // G1 §④ 验收:decision 三段满载不撑破硬 cap(640)。B1 后即便估高有偏差,
    // body 始终 overflow-y-auto,真实内容超出时会出现滚动条而非被剪。
    const d = decision("dec_full", {
      question: "x".repeat(80),
      chosen: [
        { id: "CH1", text: "chosen strategy", evidence: [] } as any,
        { id: "CH2", text: "alt", evidence: [] } as any,
      ],
      rejected: [
        { id: "RJ1", text: "nope", evidence: [], whyNot: "why" } as any,
      ],
      claims: [{ id: "CL1", text: "claim" }],
    });
    const id = `decision/${d.decisionId}`;
    const out = await layoutCanvasEgo({
      focusId: id,
      tasks: [],
      decisions: [d],
      facts: [],
      relations: [],
      filters: filters(),
      inLoopEdges: new Set(),
      shown: new Map([[id, 0]]),
      expanded: new Set([id]),
    });
    const node = out.nodes.find((n) => n.id === id)!;
    expect(node.height).toBeLessThanOrEqual(630);
  });

  it("硬 cap:H_CAP_ABS=640 永远不被超(即便估高顶到各段 internal cap)", async () => {
    // 反向保护:无论内容多,节点高度都受 H_CAP_ABS 卡住;真实溢出由 body 滚动条兜底。
    const huge = decision("dec_huge", {
      question: "x".repeat(200),
      chosen: Array.from({ length: 6 }, (_, i) => ({
        id: `CH${i}`, text: "chosen", evidence: [],
      })) as any,
      rejected: Array.from({ length: 5 }, (_, i) => ({
        id: `RJ${i}`, text: "nope", evidence: [], whyNot: "why",
      })) as any,
      claims: Array.from({ length: 5 }, (_, i) => ({
        id: `CL${i}`, text: "claim",
      })),
    });
    const huge2 = decision("dec_huge2", {
      question: "y".repeat(400),
      chosen: Array.from({ length: 10 }, (_, i) => ({
        id: `CH${i}`, text: "c", evidence: [],
      })) as any,
      rejected: Array.from({ length: 10 }, (_, i) => ({
        id: `RJ${i}`, text: "r", evidence: [], whyNot: "w",
      })) as any,
      claims: Array.from({ length: 10 }, (_, i) => ({
        id: `CL${i}`, text: "cl",
      })),
    });
    const id = `decision/${huge2.decisionId}`;
    const out = await layoutCanvasEgo({
      focusId: id,
      tasks: [],
      decisions: [huge2],
      facts: [],
      relations: [],
      filters: filters(),
      inLoopEdges: new Set(),
      shown: new Map([[id, 0]]),
      expanded: new Set([id]),
    });
    const node = out.nodes.find((n) => n.id === id)!;
    expect(node.height).toBeLessThanOrEqual(640);
    void huge; // huge 是对照(同样不会撑破 cap,留作文档说明)。
  });

  // B2:NodeResizer 走 sizeOverrides 通道。override 必须原样落地为顶层 width/height,
  // 不被内容估高覆盖,且不再写 style.width(避免与 NodeResizer 的中间态打架)。
  it("B2 · sizeOverride 落地为顶层 width/height(不被内容估高覆盖)", async () => {
    const t = task("task_override", { title: "short" });
    const id = t.taskId;
    const out = await layoutCanvasEgo({
      focusId: id,
      tasks: [t],
      decisions: [],
      facts: [],
      relations: [],
      filters: filters(),
      inLoopEdges: new Set(),
      shown: new Map([[id, 0]]),
      expanded: new Set([id]),
      sizeOverrides: new Map([[id, { w: 500, h: 400 }]]),
    });
    const node = out.nodes.find((n) => n.id === id)!;
    expect(node.width).toBe(500);
    expect(node.height).toBe(400);
    // B2:不再写 style.width / style.height —— 让 NodeResizer 控盒子。
    expect(node.style?.width).toBeUndefined();
    expect(node.style?.height).toBeUndefined();
  });
});
