import { describe, it, expect } from "vitest";
import { layoutLedgerGraph } from "../src/renderer/graph/ledgerGraphLayout";
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
  modules: new Set<string>(["m", "gui", "kernel"]),
  types: new Set(["task", "decision", "fact"]),
  // assoc 默认关 —— 全域总览里 relates 是噪音(D7 item3 反毛球策略)。
  axes: { authority: true, evidence: true, execution: true, assoc: false },
};

const filters = (over: Partial<GraphFilterInput> = {}): GraphFilterInput => ({
  ...ALL_FILTERS,
  ...over,
});

describe("layoutLedgerGraph · 全域三实体合图", () => {
  it("三类实体都渲染为 ego 节点(紧凑 chip)", async () => {
    const tasks = [task("t1", { module: "m" })];
    const decisions = [decision("dec1")];
    const facts = [fact("t1", "F1")];
    const out = await layoutLedgerGraph({
      tasks,
      decisions,
      facts,
      relations: [],
      filters: filters(),
    });
    const entities = new Set(out.nodes.filter((n) => n.type === "ego").map((n) => n.data?.entity));
    expect(entities.has("task")).toBe(true);
    expect(entities.has("decision")).toBe(true);
    expect(entities.has("fact")).toBe(true);
  });

  it("跨类边连接三实体(authority + evidence 轴)", async () => {
    const tasks = [task("t1", { module: "m" })];
    const decisions = [decision("dec1")];
    const facts = [fact("t1", "F1")];
    const relations = [
      rel("decision/dec1", "task/t1", "derives"), // authority
      rel("decision/dec1", "fact/t1/F1", "evidenced-by"), // evidence
    ];
    const out = await layoutLedgerGraph({
      tasks,
      decisions,
      facts,
      relations,
      filters: filters(),
    });
    // 至少有 2 条边(decision→task + decision→fact)
    expect(out.edges.length).toBeGreaterThanOrEqual(2);
    // 边的两端都在可见节点集
    for (const e of out.edges) {
      const ids = out.nodes.filter((n) => n.type === "ego").map((n) => n.id);
      expect(ids).toContain(e.source);
      expect(ids).toContain(e.target);
    }
  });

  it("assoc (relates) 默认关 → 松关联边不渲染", async () => {
    const tasks = [task("t1", { module: "m" }), task("t2", { module: "m" })];
    const relations = [rel("task/t1", "task/t2", "relates")];
    const out = await layoutLedgerGraph({
      tasks,
      decisions: [],
      facts: [],
      relations,
      filters: filters(),
    });
    expect(out.edges.length).toBe(0);
  });

  it("打开 assoc 轴 → 松关联边渲染", async () => {
    const tasks = [task("t1", { module: "m" }), task("t2", { module: "m" })];
    const relations = [rel("task/t1", "task/t2", "relates")];
    const out = await layoutLedgerGraph({
      tasks,
      decisions: [],
      facts: [],
      relations,
      filters: filters({ axes: { authority: true, evidence: true, execution: true, assoc: true } }),
    });
    expect(out.edges.length).toBeGreaterThanOrEqual(1);
  });

  it("模块过滤:关掉 m → task/decision(落地 m)被过滤", async () => {
    const tasks = [task("t1", { module: "m" }), task("t2", { module: "gui" })];
    const decisions = [decision("dec1")];
    const relations = [rel("decision/dec1", "task/t1", "derives")]; // dec1 落地 m
    const out = await layoutLedgerGraph({
      tasks,
      decisions,
      facts: [],
      relations,
      filters: filters({ modules: new Set(["gui"]) }),
    });
    const ids = out.nodes.filter((n) => n.type === "ego").map((n) => n.id);
    // t2(gui)保留;t1(m)被过滤;dec1 落地 m → 也被过滤
    expect(ids).toContain("t2");
    expect(ids).not.toContain("t1");
    expect(ids).not.toContain("decision/dec1");
  });

  it("fact 上限 60:超过 → 只显近期 60 + 折叠提示", async () => {
    const tasks = [task("t1", { module: "m" })];
    const facts = Array.from({ length: 70 }, (_, i) =>
      fact("t1", `F${i}`, { at: `2026-07-${String(10 + (i % 20)).padStart(2, "0")}` }),
    );
    const out = await layoutLedgerGraph({
      tasks,
      decisions: [],
      facts,
      relations: [],
      filters: filters(),
    });
    const factNodes = out.nodes.filter((n) => n.type === "ego" && n.data?.entity === "fact");
    expect(factNodes.length).toBeLessThanOrEqual(60);
    // 有折叠提示
    const notice = out.nodes.find((n) => n.id === "ledger-cap-notice");
    expect(notice).toBeDefined();
  });

  it("密度上限 180:总实体超限 → 砍 task + 折叠提示", async () => {
    // 100 个 task(done) + 100 个 fact + 1 decision → 总 > 180
    const tasks = Array.from({ length: 100 }, (_, i) =>
      task(`t${i}`, { module: "m", coordinationStatus: "done" }),
    );
    const facts = Array.from({ length: 100 }, (_, i) => fact(`t${i}`, `F${i}`));
    const out = await layoutLedgerGraph({
      tasks,
      decisions: [decision("dec1")],
      facts,
      relations: [],
      filters: filters(),
    });
    const egoNodes = out.nodes.filter((n) => n.type === "ego");
    expect(egoNodes.length).toBeLessThanOrEqual(180);
  });

  it("密度上限 180:决策单独超限 → decisions 也被截断 + 折叠提示", async () => {
    // 修复前 decisions 永不截断:≥181 decisions → ego 节点数 > 180。
    const decisions = Array.from({ length: 200 }, (_, i) => decision(`dec${i}`));
    const out = await layoutLedgerGraph({
      tasks: [],
      decisions,
      facts: [],
      relations: [],
      filters: filters(),
    });
    const egoNodes = out.nodes.filter((n) => n.type === "ego");
    expect(egoNodes.length).toBeLessThanOrEqual(180);
    const notice = out.nodes.find((n) => n.id === "ledger-cap-notice");
    expect(notice).toBeDefined();
  });

  it("密度上限:decision 超预算时 facts 不被负 slice 误保留", async () => {
    // 修复前 budget = NODE_CAP - visDecisions.length 可为负 →
    // visFacts.slice(0, factBudget) 以负端点截断 = 保留尾部,而非清空。
    const decisions = Array.from({ length: 200 }, (_, i) => decision(`dec${i}`));
    const tasks = [task("t1", { module: "m" })];
    const facts = Array.from({ length: 10 }, (_, i) => fact("t1", `F${i}`));
    const out = await layoutLedgerGraph({
      tasks,
      decisions,
      facts,
      relations: [],
      filters: filters(),
    });
    const egoNodes = out.nodes.filter((n) => n.type === "ego");
    expect(egoNodes.length).toBeLessThanOrEqual(180);
    // budget 归零后 facts/tasks 应全部被裁掉;仅 decisions(截到 180)保留。
    const factNodes = egoNodes.filter((n) => n.data?.entity === "fact");
    const taskNodes = egoNodes.filter((n) => n.data?.entity === "task");
    expect(factNodes.length).toBe(0);
    expect(taskNodes.length).toBe(0);
    const decisionNodes = egoNodes.filter((n) => n.data?.entity === "decision");
    expect(decisionNodes.length).toBe(180);
    const notice = out.nodes.find((n) => n.id === "ledger-cap-notice");
    expect(notice).toBeDefined();
  });

  it("所有节点都有 navRef(供 enterSpotlight 消费)", async () => {
    const tasks = [task("t1", { module: "m" })];
    const decisions = [decision("dec1")];
    const facts = [fact("t1", "F1")];
    const out = await layoutLedgerGraph({
      tasks,
      decisions,
      facts,
      relations: [],
      filters: filters(),
    });
    for (const n of out.nodes.filter((n) => n.type === "ego")) {
      expect(n.data?.navRef).toBeTruthy();
    }
  });

  it("所有类型关 → 空图(0 ego 节点)", async () => {
    const out = await layoutLedgerGraph({
      tasks: [task("t1")],
      decisions: [decision("dec1")],
      facts: [fact("t1", "F1")],
      relations: [],
      filters: filters({ types: new Set() }),
    });
    const egoNodes = out.nodes.filter((n) => n.type === "ego");
    expect(egoNodes.length).toBe(0);
  });
});
