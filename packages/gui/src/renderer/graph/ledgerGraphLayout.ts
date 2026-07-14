import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import { parseEndpoint, endpointToNodeId } from "./endpoint";
import { axisForKind, type SemanticAxis } from "./constants";
import type { GraphFilterInput, LayoutOutput } from "./graphLayoutTypes";
import { buildEdge, factRefOf, statusColor } from "./graphLayoutShared";
import { runElkLayout } from "./elkRunner";
import type { Node, Edge } from "@xyflow/react";
import { Position } from "@xyflow/react";
import { t as translate } from "../i18n/core.ts";

/**
 * 全域三实体合图(D7 item3,skel="unified")。
 *
 * 与 layoutTerritory(单种类分区,无边)和 layoutCanvasEgo(ego-scoped)并列:把 task /
 * decision / fact 三类实体及其跨类关系组装进一张图,ELK kind-bands(decision→task→fact)
 * 分层。是「大而全」的台账总览 —— 点击任一节点 → enterSpotlight 进聚光灯深入。
 *
 * 反毛球策略:
 *   - assoc (relates/implements) 默认关 —— 松关联在大图上是噪音。
 *   - ELK kind-bands:三类实体各自归层(decision=0 / task=1 / fact=2),减少跨类交叉。
 *   - 密度上限 ~180 节点;fact > 60 时只显近期 60 条(余进折叠提示)。
 *   - 节点 = 紧凑 chip(非详情卡),与 territory zone 的视觉层级一致。
 */

export type Entity = "task" | "decision" | "fact";

export interface LedgerInput {
  tasks: TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  /** 原始 relations(未按 axis 预筛;本布局器内部按 filters.axes 自筛)。 */
  relations: RelationEdge[];
  filters: GraphFilterInput;
}

// ── 紧凑 chip 尺寸(全域是总览,不是详情卡)──
const CHIP_W: Record<Entity, number> = { decision: 200, task: 190, fact: 170 };
const CHIP_H: Record<Entity, number> = { decision: 56, task: 40, fact: 40 };

// 密度上限
const NODE_CAP = 180;
const FACT_VISIBLE_CAP = 60;

/**
 * 决策的模块亲和:via derives 落地(decision --derives--> task.module)。无落地 → 不参与
 * 模块过滤(保留可见,避免无落地决策被模块误删)。
 */
function decisionModuleAffinity(
  decisions: DecisionRow[],
  relations: RelationEdge[],
  taskById: Map<string, TaskRow>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of relations) {
    if (e.kind !== "derives") continue;
    const s = endpointToNodeId(e.from);
    const t = endpointToNodeId(e.to);
    if (!s.startsWith("decision/")) continue;
    const task = taskById.get(t);
    if (task?.module) {
      // 首次落地优先(稳定的模块归属)
      if (!out.has(s)) out.set(s, task.module);
    }
  }
  return out;
}

function labelOf(entity: Entity, row: TaskRow | DecisionRow | FactRef): string {
  if (entity === "task") return (row as TaskRow).title;
  if (entity === "decision") return (row as DecisionRow).title;
  const f = row as FactRef;
  return f.text?.slice(0, 48) ?? f.anchor;
}

export async function layoutLedgerGraph(input: LedgerInput): Promise<LayoutOutput> {
  const { tasks, decisions, facts, relations, filters } = input;
  const typeOn = (e: Entity): boolean => filters.types.has(e);
  const axisOn = (a: SemanticAxis): boolean => filters.axes[a];
  const mods = filters.modules;

  const taskById = new Map<string, TaskRow>(tasks.map((t) => [t.taskId, t] as [string, TaskRow]));
  const decModule = decisionModuleAffinity(decisions, relations, taskById);

  // ── 候选节点集(按类型 + 模块过滤)──
  // decision 模块亲和 = derives 落地 task 的 module;无落地 → 保留(不被模块过滤删)。
  const candDecisions = decisions.filter((d) => {
    if (!typeOn("decision")) return false;
    const m = decModule.get(`decision/${d.decisionId}`);
    return m ? mods.has(m) : true;
  });
  const candTasks = tasks.filter((t) => typeOn("task") && mods.has(t.module));
  const candFacts = facts.filter((f) => {
    if (!typeOn("fact")) return false;
    const host = taskById.get(f.taskId);
    return host ? mods.has(host.module) : true;
  });

  // ── fact 近期截断(>60 条只显近期)──
  const sortedFacts = [...candFacts].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const factsCapped = sortedFacts.slice(0, FACT_VISIBLE_CAP);
  const factsHiddenByCap = candFacts.length - factsCapped.length;

  // ── 密度上限 ~180:三类实体共享预算(含 decision);超限按优先级裁剪 ──
  // 优先级:decision > 非 done task > fact > done task。
  // 预算始终 clamp ≥ 0 —— 负 budget 会让 Array#slice(0, -N) 误保留尾部,而非清空。
  let visDecisions = candDecisions;
  let visTasks = candTasks;
  let visFacts = factsCapped;
  const totalCandidate = visDecisions.length + visTasks.length + visFacts.length;
  let hiddenByDensity = 0;
  if (totalCandidate > NODE_CAP) {
    const activeTasks = visTasks.filter((t) => t.coordinationStatus !== "done" && t.coordinationStatus !== "cancelled");
    const doneTasks = visTasks.filter((t) => t.coordinationStatus === "done" || t.coordinationStatus === "cancelled");
    // decisions 优先,但同样受 NODE_CAP 约束(决策单独 > 180 时也要截断)。
    const keptDecisions = visDecisions.slice(0, NODE_CAP);
    const budget = Math.max(0, NODE_CAP - keptDecisions.length);
    // 先给 facts 固定份额(剩余 budget 的 1/3),余给 tasks;份额与 slice 端均 ≥ 0。
    const factBudget = Math.max(0, Math.min(visFacts.length, Math.floor(budget / 3)));
    const taskBudget = Math.max(0, budget - factBudget);
    const keptActive = activeTasks.slice(0, taskBudget);
    const keptDone =
      taskBudget > keptActive.length ? doneTasks.slice(0, taskBudget - keptActive.length) : [];
    const keptFacts = visFacts.slice(0, factBudget);
    hiddenByDensity =
      totalCandidate - (keptDecisions.length + keptActive.length + keptDone.length + keptFacts.length);
    visDecisions = keptDecisions;
    visTasks = [...keptActive, ...keptDone];
    visFacts = keptFacts;
  }

  // ── 可见 id 集 ──
  const vis = new Set<string>();
  for (const d of visDecisions) vis.add(`decision/${d.decisionId}`);
  for (const t of visTasks) vis.add(t.taskId);
  for (const f of visFacts) vis.add(factRefOf(f));

  // ── byId(仅可见)──
  const byId = new Map<string, { entity: Entity; row: TaskRow | DecisionRow | FactRef }>();
  for (const d of visDecisions) byId.set(`decision/${d.decisionId}`, { entity: "decision", row: d });
  for (const t of visTasks) byId.set(t.taskId, { entity: "task", row: t });
  for (const f of visFacts) byId.set(factRefOf(f), { entity: "fact", row: f });

  // ── 边:两端可见 + 轴开 ──
  const rfEdges: Edge[] = [];
  const emit = (edge: RelationEdge, axis: SemanticAxis, key: string) => {
    if (!axisOn(axis)) return;
    const s = endpointToNodeId(edge.from);
    const t = endpointToNodeId(edge.to);
    if (!vis.has(s) || !vis.has(t)) return;
    rfEdges.push(
      buildEdge({
        edgeId: `e_${key}`,
        edge,
        sourceId: s,
        targetId: t,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        axis,
      }),
    );
  };
  relations.forEach((edge, i) => {
    if (!parseEndpoint(edge.from) || !parseEndpoint(edge.to)) return;
    emit(edge, axisForKind(edge.kind), `rel_${i}`);
  });
  // 合成 task 父子边(执行轴)
  const taskIds = new Set(visTasks.map((t) => t.taskId));
  for (const t of visTasks) {
    if (t.parentTaskId && taskIds.has(t.parentTaskId)) {
      const edge: RelationEdge = {
        from: `task/${t.parentTaskId}`,
        to: `task/${t.taskId}`,
        kind: "depends-on",
        provenance: "local-document",
        rationale: translate("graph.canvasEgoLayout.subtask"),
      };
      emit(edge, "execution", `child_${t.taskId}`);
    }
  }

  // ── 组装 RF 节点(紧凑 chip)──
  const rfNodes: Node[] = [];
  const dimsMap = new Map<string, { width: number; height: number }>();
  for (const [id, meta] of byId) {
    const w = CHIP_W[meta.entity];
    const h = CHIP_H[meta.entity];
    dimsMap.set(id, { width: w, height: h });
    const navRef = meta.entity === "task" ? `task/${id}` : id;
    rfNodes.push({
      id,
      type: "ego",
      position: { x: 0, y: 0 },
      width: w,
      height: h,
      data: {
        entity: meta.entity,
        raw: meta.row,
        label: labelOf(meta.entity, meta.row),
        focus: false,
        expanded: false,
        hop: 0,
        degree: 0,
        hiddenCount: 0,
        color: meta.entity === "task" ? statusColor(meta.row as TaskRow) : undefined,
        navRef,
      },
      zIndex: 1,
    });
  }

  // ── ELK kind-bands:decision=0 / task=1 / fact=2 ──
  const elkNodes = rfNodes.map((n) => {
    const entity = (n.data as { entity: Entity }).entity;
    const partition = entity === "decision" ? 0 : entity === "task" ? 1 : 2;
    return {
      id: n.id,
      width: dimsMap.get(n.id)!.width,
      height: dimsMap.get(n.id)!.height,
      partition,
    };
  });
  const elkEdges = rfEdges.map((e) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }));
  const elkResult = await runElkLayout(elkNodes, elkEdges);
  if (elkResult) {
    for (const n of rfNodes) {
      const p = elkResult.positions.get(n.id);
      if (p) n.position = p;
    }
    for (const e of rfEdges) {
      const route = elkResult.routes.get(e.id);
      if (route && route.points.length >= 2) {
        e.data = { ...(e.data as Record<string, unknown>), route: route.points };
      }
    }
  } else {
    // ELK 失败降级:简单按 kind 分列手工摆位。
    fallbackColumnLayout(rfNodes);
  }

  // ── bounds ──
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of rfNodes) {
    const w = dimsMap.get(n.id)!.width;
    const h = dimsMap.get(n.id)!.height;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }

  // ── 折叠提示节点(fact 截断 / 密度上限)──
  const hiddenTotal = hiddenByDensity + factsHiddenByCap;
  if (hiddenTotal > 0) {
    rfNodes.push({
      id: "ledger-cap-notice",
      type: "territoryChip",
      position: { x: minX, y: maxY + 24 },
      width: 320,
      height: 30,
      data: {
        entity: "fold",
        label: translate("graph.ledgerGraphLayout.nodeCapExceeded", { hidden: hiddenTotal }),
        zoneId: undefined,
        skel: "unified",
      },
      zIndex: 2,
    });
  }

  const allTypesOff = !typeOn("task") && !typeOn("decision") && !typeOn("fact");
  if (allTypesOff && rfNodes.length === 0) {
    // 空态由 GraphView 兜底;此处仅保证 bounds 非负。
  }

  return {
    nodes: rfNodes,
    edges: rfEdges,
    cycleWarning: { count: 0, cycles: [] },
    resolvedFocusId: null,
    focusClaims: [],
    bounds: { width: maxX - minX, height: maxY - minY },
  };
}

/**
 * ELK 失败降级:按 kind 分三列手工摆位(decision 左 / task 中 / fact 右)。
 * 不追求美观,只保证零重叠 + kind 分带语义保留。
 */
function fallbackColumnLayout(rfNodes: Node[]): void {
  const COL_W = 240;
  const GAP_Y = 12;
  const byKind: Record<string, Node[]> = { decision: [], task: [], fact: [] };
  for (const n of rfNodes) {
    const entity = (n.data as { entity?: string })?.entity ?? "task";
    if (byKind[entity]) byKind[entity].push(n);
  }
  const order: Array<keyof typeof byKind> = ["decision", "task", "fact"];
  order.forEach((kind, col) => {
    let y = 0;
    for (const n of byKind[kind]) {
      n.position = { x: col * COL_W, y };
      y += (n.height ?? 40) + GAP_Y;
    }
  });
}
