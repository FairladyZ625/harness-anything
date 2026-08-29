import type { TaskRow, DecisionRow, FactRef, RelationEdge, RelationKind } from "../model/types";
import type { Node, Edge } from "@xyflow/react";
import { MarkerType as RFMarkerType } from "@xyflow/react";
import { parseEndpoint, endpointToNodeId } from "./endpoint";
import { axisForKind, AXIS_COLOR_VAR, type SemanticAxis } from "./constants";
import { visualForKind, type FlowAnimMode } from "./relationVisual";
import { STATUS_META } from "../components/badges";

/**
 * 无限画布 ego 布局(dec_01KXBGJQFQARSZHHQW1WADFDNC refines dec_01KXA7811SVVT8P66HNDFZQ7DF)。
 *
 * 取代固定三泳道 ego(该决策 RJ1 明确否决「固定 1 跳上 / 1 跳下三列」):三类实体统一,
 * 以焦点为 0 级,按跳级(BFS hop)分层成列 —— 上游系谱→左,下游落地→右,同级竖排、
 * barycenter 排序减少交叉。确定性布局、零重叠、不测 DOM、不引第三方布局器。
 *
 * 累积模型的状态(shown / expanded)由 useEgoCanvas 持有,本文件是纯函数:
 *   buildEgoGraph    — 统一图(byId + adj,含合成 task 父子边)。
 *   bfsShownFromFocus— 从焦点 BFS 到 maxHop 的可见集(openFocus 铺开默认 ±2 跳)。
 *   egoNeighborsOf   — 某节点经轴过滤的一跳邻居(展开卡片时长出下一环)。
 *   layoutEgoCanvas  — 给定 (focusId, shown, expanded, filters) → 节点位置 + 边。
 *
 * 不变量:布局只依赖 (focusId, shown, expanded, filters)。单击展开只往 shown 里加,
 * 收起只从 expanded 里减 —— 已铺开的邻居永不撤回,画布永不重排(决策 CH1)。
 */

export type EgoEntity = "task" | "decision" | "fact";

export interface EgoNodeMeta {
  entity: EgoEntity;
  row: TaskRow | DecisionRow | FactRef;
}

export type EgoNodeData = Record<string, unknown> & {
  id: string;
  entity: EgoEntity;
  raw: EgoNodeMeta["row"];
  label: string;
  sub?: string;
  focus: boolean;
  expanded: boolean;
  hop: number;
  degree: number;
  hiddenCount: number;
  dimmed: boolean;
  color?: string;
  navRef: string;
  onCollapse?: (id: string) => void;
  onRefocus?: (ref: string) => void;
  onNavigate?: (ref: string) => void;
  refocusTitle?: string;
};

export type EgoEdgeData = Record<string, unknown> & RelationEdge & { axis: SemanticAxis };
export type EgoFlowNode = Node<EgoNodeData, "ego">;
export type EgoFlowEdge = Edge<EgoEdgeData, "interactive">;

export interface EgoAdjEntry {
  other: string;
  dir: "out" | "in";
  axis: SemanticAxis;
  kind: RelationKind;
  edge: RelationEdge;
  /** 去重键(同一条边正反各登记一次,靠它折叠)。 */
  key: string;
}

export interface EgoGraph {
  byId: Map<string, EgoNodeMeta>;
  adj: Map<string, EgoAdjEntry[]>;
  /** 合成的 task 父子边(执行轴);parentTaskId 不在 relations 里。 */
  synthEdges: Array<{ edge: RelationEdge; key: string }>;
}

export type EgoAxisFilter = Record<SemanticAxis, boolean>;

export interface EgoFilters {
  axes: EgoAxisFilter;
  kinds: ReadonlySet<RelationKind>;
  types: ReadonlySet<string>;
  flowMode: FlowAnimMode;
}

/** fact 归一 ref(fact/<anchor>),与边端点键空间对齐。 */
export function egoFactRefOf(fact: FactRef): string {
  return fact.anchor.startsWith("fact/") ? fact.anchor : `fact/${fact.anchor}`;
}

/**
 * 任何入口形态(decision/<id>、task/<id>、fact/<id>、裸 task id)→ ego 图键空间。
 * territory chip、命令面板、双击、焦点历史共用此不变量,避免「焦点键不上 → 空白画布」。
 */
export function egoFocusIdOf(ref: string): string {
  return endpointToNodeId(ref);
}

/**
 * 统一图:byId(三类实体归一 id) + adj(relations 双向 + 合成 task 父子边)。
 *
 * factAnchors 里有、facts 投影里没有正文的 fact 仍然建节点(标 anchor,正文留空),
 * 否则指向它的 evidenced-by 边会静默消失 —— 那是把「未投影」伪装成「没有关系」。
 * 但绝不为它编造正文。
 */
export function buildEgoGraph(
  tasks: ReadonlyArray<TaskRow>,
  decisions: ReadonlyArray<DecisionRow>,
  facts: ReadonlyArray<FactRef>,
  relations: ReadonlyArray<RelationEdge>,
  factAnchors: ReadonlyArray<{ factRef: string; taskId?: string; factId: string }> = [],
): EgoGraph {
  const byId = new Map<string, EgoNodeMeta>();
  for (const t of tasks) byId.set(t.taskId, { entity: "task", row: t });
  for (const d of decisions) byId.set(`decision/${d.decisionId}`, { entity: "decision", row: d });
  for (const f of facts) byId.set(egoFactRefOf(f), { entity: "fact", row: f });
  for (const anchor of factAnchors) {
    if (byId.has(anchor.factRef)) continue;
    byId.set(anchor.factRef, {
      entity: "fact",
      // 缺的字段(at / confidence)保持**缺席**,不填空串或默认值冒充观察数据;
      // 渲染侧对空正文有显式「仅有锚点」分支。
      row: {
        anchor: `fact/${anchor.factId}`,
        ...(anchor.taskId ? { taskId: anchor.taskId } : {}),
        category: "anchor",
        text: "",
      } as unknown as FactRef,
    });
  }

  const adj = new Map<string, EgoAdjEntry[]>();
  const addAdj = (id: string, entry: EgoAdjEntry) => {
    const list = adj.get(id);
    if (list) list.push(entry);
    else adj.set(id, [entry]);
  };
  const link = (edge: RelationEdge, axis: SemanticAxis, key: string) => {
    const source = endpointToNodeId(edge.from);
    const target = endpointToNodeId(edge.to);
    // 悬挂端点(投影里没有该实体)跳过 —— 不造节点,不伪造关系。
    if (!byId.has(source) || !byId.has(target)) return;
    addAdj(source, { other: target, dir: "out", axis, kind: edge.kind, edge, key });
    addAdj(target, { other: source, dir: "in", axis, kind: edge.kind, edge, key });
  };

  relations.forEach((edge, i) => {
    if (!parseEndpoint(edge.from) || !parseEndpoint(edge.to)) return;
    link(edge, axisForKind(edge.kind), `rel_${i}`);
  });

  // 合成父子边:parent → child,执行轴(task 树层级不在 relations 投影里)。
  const synthEdges: Array<{ edge: RelationEdge; key: string }> = [];
  const taskIds = new Set(tasks.map((t) => t.taskId));
  for (const t of tasks) {
    if (!t.parentTaskId || !taskIds.has(t.parentTaskId)) continue;
    const edge: RelationEdge = {
      from: `task/${t.parentTaskId}`,
      to: `task/${t.taskId}`,
      kind: "depends-on",
      provenance: "local-document",
      rationale: "子任务",
    };
    const key = `child_${t.taskId}`;
    link(edge, "execution", key);
    synthEdges.push({ edge, key });
  }

  return { byId, adj, synthEdges };
}

/** 从焦点 BFS 到 maxHop 的可见集(id → 距焦点跳数),按轴过滤。 */
export function bfsShownFromFocus(
  graph: EgoGraph,
  focusId: string,
  maxHop: number,
  axes: EgoAxisFilter,
): Map<string, number> {
  const shown = new Map<string, number>([[focusId, 0]]);
  const queue: Array<[string, number]> = [[focusId, 0]];
  while (queue.length > 0) {
    const [id, hop] = queue.shift()!;
    if (hop >= maxHop) continue;
    for (const entry of graph.adj.get(id) ?? []) {
      if (!axes[entry.axis]) continue;
      if (shown.has(entry.other)) continue;
      shown.set(entry.other, hop + 1);
      queue.push([entry.other, hop + 1]);
    }
  }
  return shown;
}

/** 某节点经轴过滤的一跳邻居 id(去重)。展开卡片时用它长出下一环。 */
export function egoNeighborsOf(graph: EgoGraph, id: string, axes: EgoAxisFilter): string[] {
  const out = new Set<string>();
  for (const entry of graph.adj.get(id) ?? []) {
    if (axes[entry.axis]) out.add(entry.other);
  }
  return [...out];
}

/** 单击选中的单跳高亮集:{selectId} ∪ 一跳邻居;null = 无选中(全亮)。 */
export function egoOneHopHighlight(graph: EgoGraph, selectId: string | null, axes: EgoAxisFilter): Set<string> | null {
  if (!selectId) return null;
  return new Set([selectId, ...egoNeighborsOf(graph, selectId, axes)]);
}

// ── 几何常量(确定性布局) ──
const CHIP_W = 216;
const CHIP_H = 46;
const CARD_W: Record<EgoEntity, number> = { fact: 300, task: 320, decision: 340 };
const CARD_W_FOCUS: Record<EgoEntity, number> = { fact: 340, task: 360, decision: 380 };
const GAP_X = 72;
const GAP_Y = 36;
const H_MIN_FOCUS: Record<EgoEntity, number> = { fact: 320, task: 300, decision: 340 };
const H_MIN_PERIPH: Record<EgoEntity, number> = { fact: 240, task: 220, decision: 260 };
const H_CAP_FOCUS = 640;
const H_CAP_PERIPH = 480;

/** 卡片高度的内容感知估算(地板与 cap 由 egoNodeDims 叠加)。 */
export function estimateEgoCardHeight(entity: EgoEntity, row: TaskRow | DecisionRow | FactRef, width: number): number {
  const cpl = Math.max(20, Math.floor((width - 24) / 8.5));
  const LINE = 22;
  const CHROME = 120; // header + 标题区 + footer + padding/gap
  if (entity === "task") {
    const task = row as TaskRow;
    const titleLines = Math.max(1, Math.ceil((task.title ?? "").length / cpl));
    return CHROME + titleLines * LINE + 80;
  }
  if (entity === "fact") {
    const fact = row as FactRef;
    const obsLines = Math.max(1, Math.ceil((fact.text?.length ?? 0) / Math.max(20, cpl - 4)));
    return CHROME + 20 + (32 + obsLines * 20) + 64;
  }
  const decision = row as DecisionRow;
  let height = CHROME + 20;
  if (decision.question) {
    height += Math.min(160, 32 + Math.ceil(decision.question.length / Math.max(20, cpl - 6)) * 20);
  }
  if (decision.chosen?.length) height += Math.min(200, 32 + decision.chosen.length * 26);
  if (decision.rejected?.length) height += Math.min(200, 32 + decision.rejected.length * 28);
  if (decision.claims?.length) height += Math.min(200, 32 + decision.claims.length * 24);
  return height;
}

/** 节点尺寸:chip 定值;卡片按内容估高 + 可读地板 + 硬 cap(超出由内部滚动兜底)。 */
export function egoNodeDims(
  entity: EgoEntity,
  expanded: boolean,
  row: EgoNodeMeta["row"] | undefined,
  isFocus: boolean,
): { w: number; h: number } {
  if (!expanded || !row) return { w: CHIP_W, h: CHIP_H };
  const w = isFocus ? CARD_W_FOCUS[entity] : CARD_W[entity];
  const minH = isFocus ? H_MIN_FOCUS[entity] : H_MIN_PERIPH[entity];
  const cap = isFocus ? H_CAP_FOCUS : H_CAP_PERIPH;
  return { w, h: Math.min(Math.max(estimateEgoCardHeight(entity, row, w), minH), cap) };
}

export interface EgoCanvasInput {
  focusId: string;
  graph: EgoGraph;
  relations: ReadonlyArray<RelationEdge>;
  filters: EgoFilters;
  /** 累积可见集:node id → 距焦点跳数。 */
  shown: ReadonlyMap<string, number>;
  /** 渲染为详情卡片的 node id(其余为紧凑 chip)。 */
  expanded: ReadonlySet<string>;
  /** 单跳高亮集;null = 全亮。 */
  highlight: ReadonlySet<string> | null;
}

export interface EgoCanvasLayout {
  nodes: EgoFlowNode[];
  edges: EgoFlowEdge[];
  focusId: string | null;
  focusEntity: EgoEntity | null;
  /** 可见节点数(不含焦点自身)。 */
  neighborCount: number;
}

export function emptyEgoLayout(): EgoCanvasLayout {
  return { nodes: [], edges: [], focusId: null, focusEntity: null, neighborCount: 0 };
}

/**
 * 跑无限画布 ego 布局。
 *
 * 分级:BFS from focus;焦点的出边邻居归「下游/右」,入边邻居归「上游/左」,更深处沿父方向。
 * 分列:按 side:level 聚列,barycenter 排序减少交叉,列内竖排居中于 y=0。
 */
export function layoutEgoCanvas(input: EgoCanvasInput): EgoCanvasLayout {
  const { focusId, graph, filters, shown, expanded, highlight } = input;
  const { byId, adj, synthEdges } = graph;
  const focusMeta = byId.get(focusId);
  if (!focusMeta) return emptyEgoLayout();

  const axisOn = (axis: SemanticAxis): boolean => filters.axes[axis];
  const typeOn = (entity: EgoEntity): boolean => filters.types.has(entity);
  const dimOf = (id: string) => {
    const meta = byId.get(id);
    return egoNodeDims(meta?.entity ?? "task", expanded.has(id), meta?.row, id === focusId);
  };

  // ── 可见集:shown ∩ 类型开关;焦点恒可见(不被自身类型开关抹掉) ──
  const vis = new Set<string>([focusId]);
  for (const id of shown.keys()) {
    if (id === focusId) continue;
    const meta = byId.get(id);
    if (meta && typeOn(meta.entity)) vis.add(id);
  }

  // ── 分级 + 定侧 ──
  const level = new Map<string, number>([[focusId, 0]]);
  const side = new Map<string, "focus" | "up" | "down">([[focusId, "focus"]]);
  const queue = [focusId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const depth = level.get(id)!;
    for (const entry of adj.get(id) ?? []) {
      if (!axisOn(entry.axis) || !vis.has(entry.other) || level.has(entry.other)) continue;
      level.set(entry.other, depth + 1);
      side.set(entry.other, id === focusId ? (entry.dir === "out" ? "down" : "up") : side.get(id)!);
      queue.push(entry.other);
    }
  }
  // 筛选下变孤立的可见节点 → 归到最远下游一列,不静默丢失。
  let farthest = 1;
  for (const depth of level.values()) farthest = Math.max(farthest, depth);
  for (const id of vis) {
    if (level.has(id)) continue;
    level.set(id, farthest + 1);
    side.set(id, "down");
  }

  // ── 分列 + barycenter 排序 ──
  const pos = new Map<string, { x: number; y: number }>([[focusId, { x: 0, y: 0 }]]);
  const cols = new Map<string, string[]>();
  for (const id of vis) {
    if (id === focusId) continue;
    const key = `${side.get(id)}:${level.get(id)}`;
    const list = cols.get(key);
    if (list) list.push(id);
    else cols.set(key, [id]);
  }
  const barycenter = (id: string, innerLevel: number): number => {
    let sum = 0;
    let n = 0;
    for (const entry of adj.get(id) ?? []) {
      if (!axisOn(entry.axis)) continue;
      if (level.get(entry.other) === innerLevel && pos.has(entry.other)) {
        sum += pos.get(entry.other)!.y;
        n += 1;
      }
    }
    return n > 0 ? sum / n : Number.MAX_SAFE_INTEGER;
  };
  for (const [sideKey, sign] of [
    ["down", 1],
    ["up", -1],
  ] as const) {
    let cx = dimOf(focusId).w / 2;
    let depth = 1;
    while (cols.has(`${sideKey}:${depth}`)) {
      const ids = cols.get(`${sideKey}:${depth}`)!;
      ids.sort((a, b) => barycenter(a, depth - 1) - barycenter(b, depth - 1) || a.localeCompare(b));
      const colW = Math.max(...ids.map((id) => dimOf(id).w));
      cx += GAP_X + colW / 2;
      const totalH = ids.reduce((acc, id) => acc + dimOf(id).h + GAP_Y, -GAP_Y);
      let y = -totalH / 2;
      for (const id of ids) {
        const h = dimOf(id).h;
        pos.set(id, { x: sign * cx, y: y + h / 2 });
        y += h + GAP_Y;
      }
      cx += colW / 2;
      depth += 1;
    }
  }

  // ── 组装节点 ──
  const nodes: EgoFlowNode[] = [];
  for (const id of vis) {
    const meta = byId.get(id);
    if (!meta) continue;
    const center = pos.get(id) ?? { x: 0, y: 0 };
    const isExpanded = expanded.has(id);
    const { w, h } = egoNodeDims(meta.entity, isExpanded, meta.row, id === focusId);
    // 「还有多少邻居没铺开」—— chip 上的 +N 徽章,告诉用户往外还能点。
    let hiddenCount = 0;
    for (const entry of adj.get(id) ?? []) {
      const other = byId.get(entry.other);
      if (axisOn(entry.axis) && !shown.has(entry.other) && other && typeOn(other.entity)) {
        hiddenCount += 1;
      }
    }
    nodes.push({
      id,
      type: "ego",
      position: { x: center.x - w / 2, y: center.y - h / 2 },
      width: w,
      height: h,
      data: {
        id,
        entity: meta.entity,
        raw: meta.row,
        label: egoLabelOf(meta),
        focus: id === focusId,
        expanded: isExpanded,
        hop: level.get(id) ?? 0,
        degree: (adj.get(id) ?? []).filter((entry) => axisOn(entry.axis)).length,
        hiddenCount,
        dimmed: highlight ? !highlight.has(id) : false,
        color: meta.entity === "task" ? STATUS_META[(meta.row as TaskRow).coordinationStatus]?.color : undefined,
        navRef: meta.entity === "task" ? `task/${id}` : id,
      },
      draggable: false,
      zIndex: id === focusId ? 6 : isExpanded ? 5 : 1,
    });
  }

  // ── 组装边:两端都可见 + 轴开 + 类型开 ──
  const edges: EgoFlowEdge[] = [];
  const seen = new Set<string>();
  const emit = (edge: RelationEdge, axis: SemanticAxis, key: string) => {
    const source = endpointToNodeId(edge.from);
    const target = endpointToNodeId(edge.to);
    if (!vis.has(source) || !vis.has(target) || !axisOn(axis)) return;
    if (!filters.kinds.has(edge.kind)) return;
    const dedupe = `${source}|${target}|${edge.kind}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    const visual = visualForKind(edge.kind);
    const color = AXIS_COLOR_VAR[axis];
    const touchesFocus = source === focusId || target === focusId;
    const faded = highlight ? !(highlight.has(source) && highlight.has(target)) : false;
    edges.push({
      id: `e_${key}`,
      source,
      target,
      type: "interactive",
      data: { ...edge, axis },
      animated: filters.flowMode === "all" || (filters.flowMode === "focus" && touchesFocus),
      style: {
        stroke: color,
        strokeWidth: visual.strokeWidth,
        strokeDasharray: visual.dasharray,
        opacity: faded ? 0.18 : 1,
      },
      markerEnd: { type: RFMarkerType.ArrowClosed, color },
    });
  };
  input.relations.forEach((edge, i) => {
    if (!parseEndpoint(edge.from) || !parseEndpoint(edge.to)) return;
    emit(edge, axisForKind(edge.kind), `rel_${i}`);
  });
  for (const { edge, key } of synthEdges) emit(edge, "execution", key);

  return {
    nodes,
    edges,
    focusId,
    focusEntity: focusMeta.entity,
    neighborCount: vis.size - 1,
  };
}

function egoLabelOf(meta: EgoNodeMeta): string {
  if (meta.entity === "task") return (meta.row as TaskRow).title;
  if (meta.entity === "decision") return (meta.row as DecisionRow).title;
  const fact = meta.row as FactRef;
  // 无正文的 anchor:显示锚点本身,不拿别处的文字冒充观察。
  return fact.text ? fact.text.slice(0, 60) : fact.anchor;
}
