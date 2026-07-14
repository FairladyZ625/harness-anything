import { describe, it, expect } from "vitest";
import { layoutTerritory, deriveGridCols } from "../src/renderer/graph/territoryLayout";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types";
import type { GraphFilterInput } from "../src/renderer/graph/graphLayoutTypes";

// ── 精简工厂 ──
const task = (id: string, extra: Partial<TaskRow> = {}): TaskRow =>
  ({
    taskId: id,
    title: `T ${id}`,
    coordinationStatus: "active",
    module: "m",
    rootTaskId: id,
    rootTitle: `Root ${id}`,
    lastKnownAt: new Date().toISOString(),
    ...extra,
  }) as unknown as TaskRow;

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

const fact = (taskId: string, factId: string, extra: Partial<FactRef> = {}): FactRef =>
  ({
    anchor: `${taskId}/${factId}`,
    taskId,
    category: "finding",
    text: `Fact ${factId}`,
    at: "2026-07-10",
    confidence: "high",
    ...extra,
  }) as unknown as FactRef;

const rel = (from: string, to: string, kind: RelationEdge["kind"]): RelationEdge =>
  ({ from, to, kind, provenance: "local-document" }) as RelationEdge;

const ALL_FILTERS: GraphFilterInput = {
  modules: new Set<string>(),
  types: new Set(["task", "decision", "fact"]),
  axes: { authority: true, evidence: true, execution: true, assoc: true },
};

const filters = (over: Partial<GraphFilterInput> = {}): GraphFilterInput => ({
  ...ALL_FILTERS,
  ...over,
});

// ── 辅助:节点重叠检测 ──
function boxesOverlap(a: any, b: any): boolean {
  const aw = a.width ?? a.style?.width ?? 0;
  const ah = a.height ?? a.style?.height ?? 0;
  const bw = b.width ?? b.style?.width ?? 0;
  const bh = b.height ?? b.style?.height ?? 0;
  return (
    a.position.x < b.position.x + bw &&
    b.position.x < a.position.x + aw &&
    a.position.y < b.position.y + bh &&
    b.position.y < a.position.y + ah
  );
}

// section 节点是宽薄标签,不参与重叠检测(它们故意横跨整行)
// chip 故意叠在 zone 上面(zone 是背景),所以只检测:
//   zone-vs-zone(不同 zone 不应重叠)
//   chip-vs-chip(不同 chip 不应重叠)
function zoneNodes(ns: any[]): any[] {
  return ns.filter((n) => n.type === "territoryZone" && n.data?.variant === "zone");
}
function chipNodes(ns: any[]): any[] {
  return ns.filter((n) => n.type === "territoryChip");
}
/** zone-vs-zone + chip-vs-chip 零重叠(不检 zone-vs-chip:后者故意叠在前者上)。 */
function expectNoOverlap(ns: any[]) {
  const zones = zoneNodes(ns);
  const chips = chipNodes(ns);
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      expect(boxesOverlap(zones[i], zones[j])).toBe(false);
    }
  }
  for (let i = 0; i < chips.length; i++) {
    for (let j = i + 1; j < chips.length; j++) {
      expect(boxesOverlap(chips[i], chips[j])).toBe(false);
    }
  }
}

// ══ TASK 领地 ══
describe("layoutTerritory · task skel", () => {
  it("milestone(root+子任务)和独立任务按模块分区", () => {
    const tasks = [
      // milestone A:root_A + 2 子任务
      task("root_A", { rootTaskId: "root_A", rootTitle: "Milestone A", title: "Milestone A" }),
      task("A1", { parentTaskId: "root_A", rootTaskId: "root_A", rootTitle: "Milestone A" }),
      task("A2", { parentTaskId: "root_A", rootTaskId: "root_A", rootTitle: "Milestone A" }),
      // 独立任务(无 parent, 无子)
      task("solo1", { module: "gui", rootTaskId: "solo1", rootTitle: "solo1" }),
      task("solo2", { module: "gui", rootTaskId: "solo2", rootTitle: "solo2" }),
      task("solo3", { module: "kernel", rootTaskId: "solo3", rootTitle: "solo3" }),
    ];
    const out = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ modules: new Set(["m", "gui", "kernel"]) }),
      expandedZones: new Set(),
    });
    const zoneTitles = out.nodes
      .filter((n) => n.type === "territoryZone" && n.data?.variant === "zone")
      .map((n) => n.data.title);
    expect(zoneTitles).toContain("Milestone A");
    expect(zoneTitles.some((t) => t === "gui")).toBe(true);
    expect(zoneTitles.some((t) => t === "kernel")).toBe(true);
  });

  it("确定性布局零重叠(zone + chip)", () => {
    const tasks = [
      task("root_A", { rootTaskId: "root_A", rootTitle: "A" }),
      task("A1", { parentTaskId: "root_A", rootTaskId: "root_A" }),
      task("A2", { parentTaskId: "root_A", rootTaskId: "root_A" }),
      task("root_B", { rootTaskId: "root_B", rootTitle: "B" }),
      task("B1", { parentTaskId: "root_B", rootTaskId: "root_B" }),
    ];
    for (let seed = 0; seed < 3; seed++) {
      const out = layoutTerritory({
        skel: "task",
        tasks,
        decisions: [],
        facts: [],
        relations: [],
        filters: filters({ modules: new Set(["m"]) }),
        expandedZones: new Set(),
      });
      expectNoOverlap(out.nodes);
    }
  });

  it("折叠态默认只显前 8 个 hot;展开后显全部", () => {
    const children = Array.from({ length: 15 }, (_, i) =>
      task(`c${i}`, {
        parentTaskId: "root_big",
        rootTaskId: "root_big",
        coordinationStatus: i < 3 ? "active" : "done",
      }),
    );
    const tasks = [task("root_big", { rootTaskId: "root_big", rootTitle: "Big" }), ...children];

    const folded = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(),
    });
    const foldedChips = folded.nodes.filter((n) => n.type === "territoryChip" && n.data?.entity === "task");
    // 折叠态:8 chip + 1 fold 提示
    expect(foldedChips.length).toBe(8);
    expect(folded.nodes.some((n) => n.type === "territoryChip" && n.data?.entity === "fold")).toBe(true);

    const expanded = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(["root:root_big"]),
    });
    const expandedChips = expanded.nodes.filter((n) => n.type === "territoryChip" && n.data?.entity === "task");
    // 展开态:全部(1 root + 15 children = 16)
    expect(expandedChips.length).toBe(16);
    expect(expanded.nodes.some((n) => n.type === "territoryChip" && n.data?.entity === "fold")).toBe(false);
  });

  it("状态比例条数据正确(每个状态的计数)", () => {
    const tasks = [
      task("root", { rootTaskId: "root", rootTitle: "R" }),
      task("c1", { parentTaskId: "root", rootTaskId: "root", coordinationStatus: "active" }),
      task("c2", { parentTaskId: "root", rootTaskId: "root", coordinationStatus: "done" }),
      task("c3", { parentTaskId: "root", rootTaskId: "root", coordinationStatus: "blocked" }),
    ];
    const out = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(),
    });
    const zone = out.nodes.find((n) => n.type === "territoryZone" && n.data?.variant === "zone");
    expect(zone.data.statusCounts).toMatchObject({ active: 2, done: 1, blocked: 1 });
    expect(zone.data.total).toBe(4);
    expect(zone.data.isAllDone).toBe(false);
  });

  it("全部 done → isAllDone=true", () => {
    const tasks = [
      task("root", { rootTaskId: "root", rootTitle: "R", coordinationStatus: "done" }),
      task("c1", { parentTaskId: "root", rootTaskId: "root", coordinationStatus: "done" }),
    ];
    const out = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(),
    });
    const zone = out.nodes.find((n) => n.type === "territoryZone" && n.data?.variant === "zone");
    expect(zone.data.isAllDone).toBe(true);
  });

  it("所有节点都有顶层 width/height(MiniMap 必须)", () => {
    const tasks = [
      task("root", { rootTaskId: "root", rootTitle: "R" }),
      task("c1", { parentTaskId: "root", rootTaskId: "root" }),
    ];
    const out = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(),
    });
    for (const n of out.nodes) {
      expect(n.width).toBeTruthy();
      expect(n.height).toBeTruthy();
    }
  });
});

// ══ DECISION 领地 ══
describe("layoutTerritory · decision skel", () => {
  it("supersede/refine 链 → 同一家族", () => {
    const decisions = [
      decision("dec_A", { title: "Original" }),
      decision("dec_B", { title: "Refined", state: "proposed" }),
    ];
    const relations = [
      rel("decision/dec_B", "decision/dec_A", "refines"),
    ];
    const out = layoutTerritory({
      skel: "decision",
      tasks: [],
      decisions,
      facts: [],
      relations,
      filters: filters(),
      expandedZones: new Set(),
    });
    // 两个 decision 同一家族 → 只有一个 head chip
    const chips = out.nodes.filter((n) => n.type === "territoryChip" && n.data?.entity === "decision");
    expect(chips.length).toBe(1);
    // head = 非被替代 + 最高分;dec_B 是 proposed(分更高)+ 没被 supersede → head
    expect(chips[0].data.label).toBe("Refined");
    expect(chips[0].data.historyCount).toBe(1); // 1 历史版本(另一个成员)
  });

  it("derives → task → rootTaskId = 落地 milestone 派生", () => {
    const tasks = [
      task("root_M", { rootTaskId: "root_M", rootTitle: "Milestone M" }),
      task("M1", { parentTaskId: "root_M", rootTaskId: "root_M" }),
    ];
    const decisions = [decision("dec_L", { title: "Landed Decision" })];
    const relations = [rel("decision/dec_L", "task/M1", "derives")];
    const out = layoutTerritory({
      skel: "decision",
      tasks,
      decisions,
      facts: [],
      relations,
      filters: filters(),
      expandedZones: new Set(),
    });
    const sections = out.nodes.filter((n) => n.type === "territoryZone" && n.data?.variant === "section");
    expect(sections.some((s) => s.data.title.includes("Milestone M"))).toBe(true);
  });

  it("无 derives 的决策 → 未落地示警区", () => {
    const decisions = [
      decision("dec_L", { title: "Landed" }),
      decision("dec_U", { title: "Unlanded", state: "proposed" }),
    ];
    const tasks = [task("root_M", { rootTaskId: "root_M", rootTitle: "M" })];
    const relations = [rel("decision/dec_L", "task/root_M", "derives")];
    const out = layoutTerritory({
      skel: "decision",
      tasks,
      decisions,
      facts: [],
      relations,
      filters: filters(),
      expandedZones: new Set(),
    });
    const sections = out.nodes.filter((n) => n.type === "territoryZone" && n.data?.variant === "section");
    expect(sections.some((s) => s.data.title.includes("⚠ Not landed"))).toBe(true);
  });

  it("coverage 灯数据正确(有 evidence = covered)", () => {
    const decisions = [
      decision("dec_C", {
        title: "With Claims",
        claims: [{ id: "CH1", text: "claim1" }, { id: "CH2", text: "claim2" }] as any,
        chosen: [{ id: "CH1", text: "c1", evidence: ["fact/task_x/F1"], whyNot: undefined }] as any,
      }),
    ];
    const out = layoutTerritory({
      skel: "decision",
      tasks: [],
      decisions,
      facts: [],
      relations: [],
      filters: filters(),
      expandedZones: new Set(),
    });
    const zone = out.nodes.find((n) => n.type === "territoryZone" && n.data?.variant === "zone");
    // CH1 有 evidence → covered;CH2 无 → not covered
    expect(zone.data.coverageSummary.total).toBe(2);
    expect(zone.data.coverageSummary.covered).toBe(1);
  });

  it("decision 领地零重叠", () => {
    const decisions = [
      decision("dec1", { title: "D1" }),
      decision("dec2", { title: "D2" }),
      decision("dec3", { title: "D3" }),
      decision("dec4", { title: "D4" }),
    ];
    const tasks = [task("root_M", { rootTaskId: "root_M", rootTitle: "M" })];
    const relations = [
      rel("decision/dec1", "task/root_M", "derives"),
      rel("decision/dec2", "task/root_M", "derives"),
      // dec3/dec4 未落地
    ];
    const out = layoutTerritory({
      skel: "decision",
      tasks,
      decisions,
      facts: [],
      relations,
      filters: filters(),
      expandedZones: new Set(),
    });
    const ns = out.nodes;
    expectNoOverlap(ns);
  });
});

// ══ FACT 领地 ══
// fact 领地现在尊重 filters.modules(与 task/unified 对齐);测试需显式传入模块集。
describe("layoutTerritory · fact skel", () => {
  it("健康 fact 按宿主 task 模块分区", () => {
    const tasks = [
      task("t_a", { module: "gui" }),
      task("t_b", { module: "kernel" }),
    ];
    const facts = [
      fact("t_a", "F1"),
      fact("t_a", "F2"),
      fact("t_b", "F3"),
    ];
    const out = layoutTerritory({
      skel: "fact",
      tasks,
      decisions: [],
      facts,
      relations: [],
      filters: filters({ modules: new Set(["gui", "kernel"]) }),
      expandedZones: new Set(),
    });
    const zoneTitles = out.nodes
      .filter((n) => n.type === "territoryZone" && n.data?.variant === "zone")
      .map((n) => n.data.title);
    expect(zoneTitles).toContain("gui");
    expect(zoneTitles).toContain("kernel");
    // gui zone 有 2 条 fact chip
    const guiChips = out.nodes.filter(
      (n) => n.type === "territoryChip" && n.data?.entity === "fact" && n.id.includes("t_a"),
    );
    expect(guiChips.length).toBe(2);
  });

  it("失效 fact(invalidated-by)进示警区,健康 fact 进模块区", () => {
    const tasks = [task("t1", { module: "m" })];
    const facts = [
      fact("t1", "F_ok"),
      fact("t1", "F_bad"),
    ];
    const relations = [
      rel("fact/t1/F_bad", "decision/dec_X", "invalidated-by"),
    ];
    const out = layoutTerritory({
      skel: "fact",
      tasks,
      decisions: [],
      facts,
      relations,
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(),
    });
    const sections = out.nodes.filter((n) => n.type === "territoryZone" && n.data?.variant === "section");
    // 示警区(first section)
    expect(sections.length).toBeGreaterThanOrEqual(2);
    // 失效 fact chip 在示警区,健康 fact chip 在模块区
    const badChip = out.nodes.find((n) => n.type === "territoryChip" && n.id.includes("F_bad"));
    const okChip = out.nodes.find((n) => n.type === "territoryChip" && n.id.includes("F_ok"));
    expect(badChip).toBeDefined();
    expect(okChip).toBeDefined();
    // 失效 fact 应被标记 dimmed
    expect(badChip?.data?.dimmed).toBe(true);
    expect(okChip?.data?.dimmed).toBe(false);
  });

  it("未挂接 task 的 fact 进「未挂接任务」分区", () => {
    const facts = [fact("ghost", "F1")]; // host task "ghost" 不在 tasks 列表
    const out = layoutTerritory({
      skel: "fact",
      tasks: [],
      decisions: [],
      facts,
      relations: [],
      filters: filters(),
      expandedZones: new Set(),
    });
    const zones = out.nodes.filter((n) => n.type === "territoryZone" && n.data?.variant === "zone");
    // 单一 zone = 未挂接 task 区
    expect(zones.length).toBe(1);
    expect(zones[0].data.unlanded).toBe(true);
  });

  it("类型过滤:关掉 fact 后 fact 领地空", () => {
    const facts = [fact("t1", "F1")];
    const out = layoutTerritory({
      skel: "fact",
      tasks: [task("t1")],
      decisions: [],
      facts,
      relations: [],
      filters: filters({ modules: new Set(["m"]), types: new Set(["task", "decision"]) }),
      expandedZones: new Set(),
    });
    expect(out.nodes.length).toBe(0);
  });

  it("模块过滤:关掉宿主模块 → 该模块 fact 隐藏;未挂接 fact 保留", () => {
    // 与 unified ledger / task territory 对齐:有宿主按 host.module 过滤;
    // 无宿主(task 不在投影)→ 保留可见(unlanded 区)。
    const tasks = [
      task("t_gui", { module: "gui" }),
      task("t_kernel", { module: "kernel" }),
    ];
    const facts = [
      fact("t_gui", "F_gui"),
      fact("t_kernel", "F_kernel"),
      fact("ghost", "F_orphan"), // host 不在 tasks → unhosted,应保留
    ];
    const out = layoutTerritory({
      skel: "fact",
      tasks,
      decisions: [],
      facts,
      relations: [],
      filters: filters({ modules: new Set(["gui"]) }),
      expandedZones: new Set(),
    });
    const chipIds = out.nodes
      .filter((n) => n.type === "territoryChip" && n.data?.entity === "fact")
      .map((n) => n.id);
    expect(chipIds.some((id) => id.includes("F_gui"))).toBe(true);
    expect(chipIds.some((id) => id.includes("F_kernel"))).toBe(false);
    expect(chipIds.some((id) => id.includes("F_orphan"))).toBe(true);
  });

  it("告警区标题/subtitle 覆盖 LOW_CONFIDENCE(与 severity>0 桶一致)", () => {
    const tasks = [task("t1", { module: "m" })];
    const facts = [fact("t1", "F_low", { confidence: "low" })];
    const out = layoutTerritory({
      skel: "fact",
      tasks,
      decisions: [],
      facts,
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(),
    });
    // 低置信 → 示警区 zone title 应点名 low confidence(en-US 默认 locale)。
    const alertZone = out.nodes.find(
      (n) => n.type === "territoryZone" && n.data?.variant === "zone" && n.id.includes("fact-alert"),
    );
    expect(alertZone).toBeDefined();
    const title = String(alertZone?.data?.title ?? "");
    expect(title.toLowerCase()).toMatch(/low confidence|低置信/);
  });

  it("fact chip 的 navRef 形如 fact/<task>/<id>(可被 enterSpotlight 消费)", () => {
    const facts = [fact("t1", "F1")];
    const out = layoutTerritory({
      skel: "fact",
      tasks: [task("t1")],
      decisions: [],
      facts,
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(),
    });
    const chip = out.nodes.find((n) => n.type === "territoryChip" && n.data?.entity === "fact");
    expect(chip).toBeDefined();
    expect(chip?.data?.navRef).toMatch(/^fact\//);
  });
});

// ═─ 横切 ─═
describe("layoutTerritory · 横切", () => {
  it("类型过滤:关掉 task 后 task 领地空", () => {
    const tasks = [task("t1", { rootTaskId: "t1" })];
    const out = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ types: new Set(["decision", "fact"]) }),
      expandedZones: new Set(),
    });
    expect(out.nodes.length).toBe(0);
  });

  it("无边(L1 是分区形状,边在 L2 才画)", () => {
    const tasks = [
      task("root", { rootTaskId: "root", rootTitle: "R" }),
      task("c1", { parentTaskId: "root", rootTaskId: "root" }),
    ];
    const out = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(),
    });
    expect(out.edges.length).toBe(0);
  });

  it("bounds 非零(有内容时)", () => {
    const tasks = [
      task("root", { rootTaskId: "root", rootTitle: "R" }),
      task("c1", { parentTaskId: "root", rootTaskId: "root" }),
    ];
    const out = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(),
    });
    expect(out.bounds.width).toBeGreaterThan(0);
    expect(out.bounds.height).toBeGreaterThan(0);
  });
});

// ══ D2:zone 展开后 chip 溢出重叠 + decision zone 不折叠 ══
// 复现:territoryLayout.computeBodyH 把 zone 高度夹在 ZONE_MAX_BODY_H=460,
// 但 chip 发射按实际成员数(不夹),行推进按夹过的高度 → chip 溢出到下一个 zone/section。
// 附带同源 bug:visibleMembers 对 decision skel 直接 return zone.members(不折叠),
// 所以 ≥5 个家族的 decision zone 默认折叠态就已经重叠。
describe("D2 · zone 展开后零重叠(盒子与孩子同源)", () => {
  it("task skel:展开大 zone(21 成员)chip 不压到下一行 zone", () => {
    // 4 个 milestone zone(填满 GRID_COLS=3 的第 1 行 + 第 2 行第 1 个)。
    // root_big 展开后 21 chip;夹到 460 → 溢出 ~250px 压到 root_d(下一行)。
    const tasks = [
      task("root_big", { rootTaskId: "root_big", rootTitle: "Big" }),
      ...Array.from({ length: 20 }, (_, i) =>
        task(`big_c${i}`, { parentTaskId: "root_big", rootTaskId: "root_big" }),
      ),
      task("root_b", { rootTaskId: "root_b", rootTitle: "B" }),
      task("b1", { parentTaskId: "root_b", rootTaskId: "root_b" }),
      task("root_c", { rootTaskId: "root_c", rootTitle: "C" }),
      task("c1", { parentTaskId: "root_c", rootTaskId: "root_c" }),
      task("root_d", { rootTaskId: "root_d", rootTitle: "D" }),
      task("d1", { parentTaskId: "root_d", rootTaskId: "root_d" }),
    ];
    const out = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(["root:root_big"]),
    });
    expectNoOverlap(out.nodes);
  });

  it("task skel:展开的 zone 自身 chip 不溢出 zone 盒子(chip-within-zone)", () => {
    const tasks = [
      task("root_big", { rootTaskId: "root_big", rootTitle: "Big" }),
      ...Array.from({ length: 20 }, (_, i) =>
        task(`big_c${i}`, { parentTaskId: "root_big", rootTaskId: "root_big" }),
      ),
    ];
    const out = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(["root:root_big"]),
    });
    const zone = out.nodes.find(
      (n) => n.type === "territoryZone" && n.data?.zoneId === "root:root_big",
    );
    expect(zone).toBeTruthy();
    const zoneBottom = zone!.position.y + (zone!.height ?? 0);
    const memberChips = out.nodes.filter(
      (n) => n.type === "territoryChip" && n.data?.entity === "task",
    );
    // 每个 chip 的底边必须在 zone 盒子内(修复前:超出夹过的高度 → 溢出)
    for (const chip of memberChips) {
      const chipBottom = chip.position.y + (chip.height ?? 0);
      expect(chipBottom).toBeLessThanOrEqual(zoneBottom + 1); // +1 容差
    }
  });

  it("decision skel:≥5 家族默认折叠态不重叠(decision 也折叠)", () => {
    // 7 个决策族都落地到 milestone M(同 1 zone),外加 milestone N(下一 section)。
    // 修复前:decision 不折叠 → 7 chip × 92px = 644,body 夹 460 → 溢出 184px 到 N。
    const tasks = [
      task("root_M", { rootTaskId: "root_M", rootTitle: "M" }),
      task("root_N", { rootTaskId: "root_N", rootTitle: "N" }),
    ];
    const decisionsM = Array.from({ length: 7 }, (_, i) =>
      decision(`dec_M${i}`, { title: `DM${i}`, state: "proposed" }),
    );
    const decisionsN = [decision("dec_N0", { title: "DN0" })];
    const relations = [
      ...decisionsM.map((d) => rel(`decision/${d.decisionId}`, "task/root_M", "derives")),
      rel("decision/dec_N0", "task/root_N", "derives"),
    ];
    const out = layoutTerritory({
      skel: "decision",
      tasks,
      decisions: [...decisionsM, ...decisionsN],
      facts: [],
      relations,
      filters: filters(),
      expandedZones: new Set(), // 默认折叠
    });
    expectNoOverlap(out.nodes);
  });

  it("decision skel:展开大 zone(7 家族)也不重叠", () => {
    const tasks = [
      task("root_M", { rootTaskId: "root_M", rootTitle: "M" }),
      task("root_N", { rootTaskId: "root_N", rootTitle: "N" }),
    ];
    const decisionsM = Array.from({ length: 7 }, (_, i) =>
      decision(`dec_M${i}`, { title: `DM${i}`, state: "proposed" }),
    );
    const decisionsN = [decision("dec_N0", { title: "DN0" })];
    const relations = [
      ...decisionsM.map((d) => rel(`decision/${d.decisionId}`, "task/root_M", "derives")),
      rel("decision/dec_N0", "task/root_N", "derives"),
    ];
    const out = layoutTerritory({
      skel: "decision",
      tasks,
      decisions: [...decisionsM, ...decisionsN],
      facts: [],
      relations,
      filters: filters(),
      expandedZones: new Set(["landing:__landed__"]), // 展开(landing zone id 由 partition 决定,这里用宽松匹配)
    });
    // 即使展开,zone 盒高必须跟着 chip 数走,不能夹。
    expectNoOverlap(out.nodes);
  });
});

// ══ D3:列数由视口宽度派生(不再硬编码 3) ══
describe("D3 · deriveGridCols(视口宽度派生列数)", () => {
  it("窄视口(单列)", () => {
    // 一列需要 ZONE_W=340;两侧 LEFT_PAD=24 各。
    expect(deriveGridCols(360)).toBe(1);
    expect(deriveGridCols(400)).toBe(1);
  });

  it("中视口(2-3 列)", () => {
    // 2 列需 ~700;3 列需 ~1060。
    expect(deriveGridCols(720)).toBe(2);
    expect(deriveGridCols(1060)).toBe(3);
  });

  it("宽视口(4+ 列)", () => {
    expect(deriveGridCols(1420)).toBe(4);
    expect(deriveGridCols(1800)).toBe(5);
  });

  it("默认值:未测量(width 缺省/0)→ 兜底 3 列", () => {
    expect(deriveGridCols(0)).toBe(3);
    expect(deriveGridCols(-1)).toBe(3);
  });

  it("集成:layoutTerritory 接受 containerWidth,宽屏 4 列", () => {
    // 8 个 milestone zone,宽屏(4 列)→ 前 4 个在第 1 行;窄屏(3 列)→ 前 3 个在第 1 行。
    const tasks: TaskRow[] = [];
    for (let i = 0; i < 8; i++) {
      const root = `root_${i}`;
      tasks.push(task(root, { rootTaskId: root, rootTitle: `R${i}` }));
      tasks.push(task(`${root}_c`, { parentTaskId: root, rootTaskId: root }));
    }
    const wide = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(),
      containerWidth: 1600,
    });
    const narrow = layoutTerritory({
      skel: "task",
      tasks,
      decisions: [],
      facts: [],
      relations: [],
      filters: filters({ modules: new Set(["m"]) }),
      expandedZones: new Set(),
      containerWidth: 800,
    });
    // 宽屏(4 列)的第 4 个 zone 的 x 应远大于窄屏(2 列)第 3 个 zone 的 x —— 列数不同 → 摆位不同。
    // 用 bounds.width 间接断言:更多列 → 更宽。
    expect(wide.bounds.width).toBeGreaterThan(narrow.bounds.width);
    // 且实际有 4 列:第 1 行有 4 个 zone 横向排开(不同 x)。
    const wideZones = wide.nodes.filter(
      (n) => n.type === "territoryZone" && n.data?.variant === "zone",
    );
    const xs = new Set(wideZones.map((n) => n.position.x));
    expect(xs.size).toBeGreaterThanOrEqual(4); // 至少 4 个不同的 x(列)
  });
});
