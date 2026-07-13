import { describe, it, expect } from "vitest";
import { layoutTerritory } from "../src/renderer/graph/territoryLayout";
import type { TaskRow, DecisionRow, RelationEdge } from "../src/renderer/model/types";
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
    expect(sections.some((s) => s.data.title.includes("⚠ 未落地"))).toBe(true);
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
