import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import { parseEndpoint, endpointToNodeId } from "./endpoint";
import { axisForKind, type SemanticAxis } from "./constants";
import type { AxisFilter, GraphFilterInput, LayoutOutput } from "./graphLayoutTypes";
import {
  buildEdge,
  factRefOf,
  findRelationCycles,
  inLoopEdge,
  statusColor,
} from "./graphLayoutShared";
import type { Node, Edge } from "@xyflow/react";
import { Position } from "@xyflow/react";
import { t as translate } from "../i18n/core.ts";

/**
 * 无限画布 ego 布局(dec_01KXBGJQFQARSZHHQW1WADFDNC refines dec_01KXA7811)。
 *
 * 取代 simpleEgoLayout 的单跳径向 / threeLaneLayout 的 claim 泳道:三类实体统一,
 * 以焦点为 0 级,按跳级(BFS hop)分层成列——上游系谱→左,下游落地→右,同级竖排,
 * barycenter 排序减少交叉。确定性布局,零重叠,不测 DOM。
 *
 * 累积模型:GraphView 持有 `shown`(累积可见集 id→hop)与 `expanded`(渲染为卡片的 id)。
 * 本文件导出:
 *   buildEgoGraph  — 统一图(byId + adj,含合成父子边),布局与 GraphView reveal 共用。
 *   bfsShown       — 从焦点 BFS 到 maxHop 的可见集(openFocus 用,按轴过滤)。
 *   neighborsOf    — 某节点通过轴过滤的一跳邻居 id(revealNeighbors 用)。
 *   layoutCanvasEgo — 纯布局器:给定 (focusId, shown, expanded, filters) → 节点位置 + 边。
 * 展开/收起/长邻居的状态变更在 GraphView(单击永不重排已展开画布)。
 */

export type Entity = "task" | "decision" | "fact";

export interface NodeMeta {
  entity: Entity;
  row: TaskRow | DecisionRow | FactRef;
}

export interface AdjEntry {
  other: string;
  dir: "out" | "in";
  axis: SemanticAxis;
  edge: RelationEdge;
  /** 去重键(避免同一条边正反各画一次)。 */
  key: string;
}

export interface EgoGraph {
  byId: Map<string, NodeMeta>;
  adj: Map<string, AdjEntry[]>;
  /** 合成的 task 父子边(执行轴),供边组装复用。 */
  synthEdges: Array<{ edge: RelationEdge; key: string }>;
}

/** 统一图:byId(三类实体归一 id) + adj(relations 双向 + 合成 task 父子边)。 */
export function buildEgoGraph(
  tasks: TaskRow[],
  decisions: DecisionRow[],
  facts: FactRef[],
  relations: RelationEdge[],
): EgoGraph {
  const byId = new Map<string, NodeMeta>();
  for (const t of tasks) byId.set(t.taskId, { entity: "task", row: t });
  for (const d of decisions) byId.set(`decision/${d.decisionId}`, { entity: "decision", row: d });
  for (const f of facts) byId.set(factRefOf(f), { entity: "fact", row: f });

  const adj = new Map<string, AdjEntry[]>();
  const addAdj = (a: string, e: AdjEntry) => {
    const list = adj.get(a);
    if (list) list.push(e);
    else adj.set(a, [e]);
  };
  const link = (edge: RelationEdge, axis: SemanticAxis, key: string) => {
    const s = endpointToNodeId(edge.from);
    const t = endpointToNodeId(edge.to);
    if (!byId.has(s) || !byId.has(t)) return; // 跳过悬挂端点
    addAdj(s, { other: t, dir: "out", axis, edge, key });
    addAdj(t, { other: s, dir: "in", axis, edge, key });
  };

  relations.forEach((edge, i) => {
    if (!parseEndpoint(edge.from) || !parseEndpoint(edge.to)) return;
    link(edge, axisForKind(edge.kind), `rel_${i}`);
  });

  // 合成父子边:parent → child,执行轴(parentTaskId 不在 relations 里)。
  const synthEdges: Array<{ edge: RelationEdge; key: string }> = [];
  const taskIds = new Set(tasks.map((t) => t.taskId));
  for (const t of tasks) {
    if (t.parentTaskId && taskIds.has(t.parentTaskId)) {
      const edge: RelationEdge = {
        from: `task/${t.parentTaskId}`,
        to: `task/${t.taskId}`,
        kind: "depends-on",
        provenance: "local-document",
        rationale: translate("graph.canvasEgoLayout.subtask"),
      };
      const key = `child_${t.taskId}`;
      link(edge, "execution", key);
      synthEdges.push({ edge, key });
    }
  }

  return { byId, adj, synthEdges };
}

/** 从焦点 BFS 到 maxHop 的可见集(id → hop),按轴过滤。openFocus 铺开默认 ±2 跳。 */
export function bfsShown(
  graph: EgoGraph,
  focusId: string,
  maxHop: number,
  axes: AxisFilter,
): Map<string, number> {
  const shown = new Map<string, number>([[focusId, 0]]);
  const queue: Array<[string, number]> = [[focusId, 0]];
  while (queue.length) {
    const [id, h] = queue.shift()!;
    if (h >= maxHop) continue;
    for (const a of graph.adj.get(id) ?? []) {
      if (!axes[a.axis]) continue;
      if (!shown.has(a.other)) {
        shown.set(a.other, h + 1);
        queue.push([a.other, h + 1]);
      }
    }
  }
  return shown;
}

/** 某节点通过轴过滤的一跳邻居 id(去重)。revealNeighbors 用。 */
export function neighborsOf(graph: EgoGraph, id: string, axes: AxisFilter): string[] {
  const out = new Set<string>();
  for (const a of graph.adj.get(id) ?? []) {
    if (axes[a.axis]) out.add(a.other);
  }
  return [...out];
}

export interface CanvasEgoInput {
  focusId: string;
  tasks: TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  /** 原始 relations(未按 axis 预筛;本布局器内部按 filters.axes 自筛)。 */
  relations: RelationEdge[];
  filters: GraphFilterInput;
  inLoopEdges: Set<string>;
  /** 累积可见集:node id → 距焦点跳数。 */
  shown: Map<string, number>;
  /** 渲染为详情卡片的 node id 集(其余为紧凑 chip)。 */
  expanded: Set<string>;
  /** 用户拖拽调整后的卡片尺寸覆盖(node id → {w,h});未覆盖的走内容估算。 */
  sizeOverrides?: ReadonlyMap<string, { w: number; h: number }>;
}

/**
 * Ego 图的入口不变量:把任何 endpoint 形态(decision/<id>、task/<id>、fact/<...>)
 * 或裸 task id 归一为 ego 图 byId 的键空间。
 *
 * D1 根因:territory chip 发射的 navRef 是 `task/<id>`(territoryLayout.buildChipNode),
 * 而 ego 图 byId 的 task 键是裸 id(buildEgoGraph)。useEgoCanvas.openFocus 修复前直接把
 * navRef 当 focusId → bfsShown 从 `task/<id>` 出发,adj/byId 都键不上 → 焦点命中失败 →
 * layoutCanvasEgo 在 `if (!meta) continue` 处丢弃 → 0 节点(空白画布)。
 *
 * 修复:openFocus 内部强制经此函数归一,使任何入口形态都收敛到 byId 键空间。territory
 * chip / FocusSwitcher / 双击 / 抽屉「设为焦点」/ 历史前后退都共用同一个入口不变量,
 * 下一个入口不会再踩同一个坑。
 */
export function egoFocusIdOf(ref: string): string {
  return endpointToNodeId(ref);
}

// 节点尺寸(确定性布局用)。chip 紧凑一条;card 固定宽,高按内容估算并封顶。
const CHIP_W = 216;
const CHIP_H = 46;
const CARD_W = 360;
const GAP_X = 72;
const GAP_Y = 26;

/**
 * 卡片高度:内容感知估算 + 封顶。节点即以此高渲染,分区溢出内滚 → 零重叠。
 *
 * D4:task 高度修复前是常量 150(无视标题长度)—— 长标题被截、内容溢出。
 * 现在按标题行数 + body 徽章/新鲜度/meta 的固定开销估算,与 decision/fact 同源。
 */
export function estimateCardHeight(entity: Entity, row: TaskRow | DecisionRow | FactRef): number {
  if (entity === "task") {
    const t = row as TaskRow;
    // header(32) + body(badges 24 + freshness 20 + meta 20 + gaps 16 ≈ 80) + footer(20) ≈ 130
    // + title 每行 22px(卡片宽 360,padding 后 ~320,约 30 字符/行)
    const titleLines = Math.max(1, Math.ceil((t.title ?? "").length / 30));
    return Math.min(260, 130 + titleLines * 22);
  }
  if (entity === "fact") {
    const f = row as FactRef;
    const obs = Math.min(160, 56 + Math.ceil((f.text?.length ?? 0) / 42) * 20);
    return 108 + obs;
  }
  const d = row as DecisionRow;
  let h = 130;
  if (d.question) h += Math.min(96, 34 + Math.ceil(d.question.length / 40) * 20);
  if (d.chosen && d.chosen.length) h += Math.min(120, 34 + d.chosen.length * 26);
  if (d.claims && d.claims.length) h += Math.min(120, 30 + d.claims.length * 24);
  return Math.min(476, h);
}

function nodeDims(
  entity: Entity,
  expanded: boolean,
  row: NodeMeta["row"] | undefined,
  override?: { w: number; h: number },
): { w: number; h: number } {
  if (override) return override;
  if (expanded && row) return { w: CARD_W, h: estimateCardHeight(entity, row) };
  return { w: CHIP_W, h: CHIP_H };
}

export function layoutCanvasEgo(input: CanvasEgoInput): LayoutOutput {
  const { focusId, filters, shown, expanded } = input;
  const sizeOverrides = input.sizeOverrides;
  const { byId, adj, synthEdges } = buildEgoGraph(
    input.tasks,
    input.decisions,
    input.facts,
    input.relations,
  );

  const axisOn = (axis: SemanticAxis): boolean => filters.axes[axis];
  const typeOn = (entity: Entity): boolean => filters.types.has(entity);
  const dimOf = (id: string) => {
    const meta = byId.get(id);
    return nodeDims(meta?.entity ?? "task", expanded.has(id), meta?.row, sizeOverrides?.get(id));
  };

  // ── 可见集:shown 中通过类型过滤者;焦点恒可见(不被自身类型开关抹掉) ──
  const vis = new Set<string>();
  for (const id of shown.keys()) {
    if (id === focusId) {
      vis.add(id);
      continue;
    }
    const meta = byId.get(id);
    if (meta && typeOn(meta.entity)) vis.add(id);
  }
  if (byId.has(focusId)) vis.add(focusId);

  // ── 分级:BFS from focus,边方向定侧(出=下游/右,入=上游/左),更深处沿父方向 ──
  const lvl = new Map<string, number>([[focusId, 0]]);
  const side = new Map<string, "focus" | "up" | "down">([[focusId, "focus"]]);
  const queue = [focusId];
  while (queue.length) {
    const id = queue.shift()!;
    const L = lvl.get(id)!;
    for (const a of adj.get(id) ?? []) {
      if (!axisOn(a.axis) || !vis.has(a.other) || lvl.has(a.other)) continue;
      lvl.set(a.other, L + 1);
      side.set(a.other, id === focusId ? (a.dir === "out" ? "down" : "up") : side.get(id)!);
      queue.push(a.other);
    }
  }
  // 筛选下变孤立的 vis 节点 → 归到最远下游一列,不丢失。
  let far = 1;
  for (const v of lvl.values()) far = Math.max(far, v);
  for (const id of vis) {
    if (!lvl.has(id)) {
      lvl.set(id, far + 1);
      side.set(id, "down");
    }
  }

  // ── 分列:按 side:level 聚列,barycenter 排序,竖排居中于 y=0 ──
  const pos = new Map<string, { x: number; y: number }>();
  const cols = new Map<string, string[]>();
  for (const id of vis) {
    const k = `${side.get(id)}:${lvl.get(id)}`;
    const list = cols.get(k);
    if (list) list.push(id);
    else cols.set(k, [id]);
  }
  pos.set(focusId, { x: 0, y: 0 });
  const bary = (id: string, innerL: number): number => {
    let s = 0;
    let n = 0;
    for (const a of adj.get(id) ?? []) {
      if (!axisOn(a.axis)) continue;
      if (lvl.get(a.other) === innerL && pos.has(a.other)) {
        s += pos.get(a.other)!.y;
        n += 1;
      }
    }
    return n ? s / n : 1e9;
  };
  for (const [sd, sign] of [
    ["down", 1],
    ["up", -1],
  ] as const) {
    let cx = dimOf(focusId).w / 2;
    let L = 1;
    while (cols.has(`${sd}:${L}`)) {
      const ids = cols.get(`${sd}:${L}`)!;
      ids.sort((a, b) => bary(a, L - 1) - bary(b, L - 1));
      const w = Math.max(...ids.map((id) => dimOf(id).w));
      cx += GAP_X + w / 2;
      const totalH = ids.reduce((acc, id) => acc + dimOf(id).h + GAP_Y, -GAP_Y);
      let y = -totalH / 2;
      for (const id of ids) {
        const h = dimOf(id).h;
        pos.set(id, { x: sign * cx, y: y + h / 2 });
        y += h + GAP_Y;
      }
      cx += w / 2;
      L += 1;
    }
  }

  // ── 组装 React Flow 节点 ──
  const rfNodes: Node[] = [];
  for (const id of vis) {
    const meta = byId.get(id);
    if (!meta) continue;
    const center = pos.get(id) ?? { x: 0, y: 0 };
    const isExpanded = expanded.has(id);
    const { w, h } = nodeDims(meta.entity, isExpanded, meta.row, sizeOverrides?.get(id));
    let hiddenCount = 0;
    for (const a of adj.get(id) ?? []) {
      if (
        axisOn(a.axis) &&
        !shown.has(a.other) &&
        byId.has(a.other) &&
        typeOn(byId.get(a.other)!.entity)
      ) {
        hiddenCount += 1;
      }
    }
    const navRef = meta.entity === "task" ? `task/${id}` : id;
    rfNodes.push({
      id,
      type: "ego",
      position: { x: center.x - w / 2, y: center.y - h / 2 },
      // 尺寸同时给 style(渲染)和顶层 width/height(RF 内部维度)。少了顶层这对,
      // node.measured 直到 DOM 观测才有值,MiniMap 的 nodeHasDimensions() 判假 → 一个方块都不画。
      width: w,
      height: h,
      style: { width: w, height: h },
      data: {
        entity: meta.entity,
        raw: meta.row,
        label: labelOf(meta),
        focus: id === focusId,
        expanded: isExpanded,
        hop: lvl.get(id) ?? 0,
        degree: (adj.get(id) ?? []).filter((a) => axisOn(a.axis)).length,
        hiddenCount,
        color: meta.entity === "task" ? statusColor(meta.row as TaskRow) : undefined,
        navRef,
      },
      zIndex: id === focusId ? 6 : isExpanded ? 5 : 1,
    });
  }

  // ── 组装边:两端都在 vis + 轴开 ──
  const rfEdges: Edge[] = [];
  const emit = (edge: RelationEdge, axis: SemanticAxis, key: string) => {
    const s = endpointToNodeId(edge.from);
    const t = endpointToNodeId(edge.to);
    if (!vis.has(s) || !vis.has(t) || !axisOn(axis)) return;
    rfEdges.push(
      buildEdge({
        edgeId: `e_${key}`,
        edge,
        sourceId: s,
        targetId: t,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        axis,
        isLoop: inLoopEdge(input.inLoopEdges, edge),
      }),
    );
  };
  input.relations.forEach((edge, i) => {
    if (!parseEndpoint(edge.from) || !parseEndpoint(edge.to)) return;
    emit(edge, axisForKind(edge.kind), `rel_${i}`);
  });
  for (const { edge, key } of synthEdges) emit(edge, "execution", key);

  const normalizedEdges = rfEdges.map((e) => ({ from: e.source, to: e.target }));
  const cycleWarning = findRelationCycles(normalizedEdges);

  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (const n of rfNodes) {
    const w = (n.style?.width as number) ?? CHIP_W;
    const h = (n.style?.height as number) ?? CHIP_H;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }

  return {
    nodes: rfNodes,
    edges: rfEdges,
    cycleWarning: { count: cycleWarning.cycles.length, cycles: cycleWarning.cycles },
    resolvedFocusId: focusId,
    focusClaims: [],
    bounds: { width: maxX - minX, height: maxY - minY },
  };
}

function labelOf(meta: NodeMeta): string {
  if (meta.entity === "task") return (meta.row as TaskRow).title;
  if (meta.entity === "decision") return (meta.row as DecisionRow).title;
  const f = meta.row as FactRef;
  return f.text?.slice(0, 48) ?? f.anchor;
}
