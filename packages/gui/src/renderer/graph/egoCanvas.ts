import type { TaskRow, DecisionRow, FactRef, RelationEdge, RelationKind } from "../model/types";
import type { Node, Edge } from "@xyflow/react";
import { MarkerType as RFMarkerType } from "@xyflow/react";
import { parseEndpoint, endpointToNodeId, type EntityKind } from "./endpoint";
import { governedEntityLabel, governedEntitySub, type GovernedEntityRow } from "./governedEntities";
import { axisForKind, AXIS_COLOR_VAR, type SemanticAxis } from "./constants";
import { visualForKind, type FlowAnimMode } from "./relationVisual";
import { scheduleTargetEdges, type AgentNodeRow, type ScheduleNodeRow } from "./runtimeEntities";
import { STATUS_META } from "../components/badges";

/**
 * 无限画布 ego 布局(dec_01KXBGJQFQARSZHHQW1WADFDNC refines dec_01KXA7811SVVT8P66HNDFZQ7DF)。
 *
 * 取代固定三泳道 ego(该决策 RJ1 明确否决「固定 1 跳上 / 1 跳下三列」):三类实体统一,
 * 以焦点为 0 级,按跳级(BFS hop)分层成列 —— 上游系谱→左,下游落地→右,同级竖排、
 * barycenter 排序减少交叉。确定性布局、零重叠、不测 DOM、不引第三方布局器。
 *
 * 节点没有展开态(视觉规范 §5.2,业主 2026-10-01):单击 = 选中 + 抽屉,双击 = 以它
 * 为中心重排邻域。布局只输出统一 chip 尺寸的节点:
 *   buildEgoGraph    — 统一图(byId + adj,含合成 task 父子边)。
 *   bfsShownFromFocus— 从焦点按 {up, down} 预算 BFS 的可见集(openFocus 铺开)。
 *   egoNeighborsOf   — 某节点经轴过滤的一跳邻居(单跳高亮集用)。
 *   layoutEgoCanvas  — 给定 (focusId, shown, filters) → 节点位置 + 边。
 *
 * 不变量:布局只依赖 (focusId, shown, filters);可见集只由焦点/跳数预算/筛选重算,
 * 节点交互不再改变布局输入(旧「单击展开累积」路径已随 §5.2 删除)。
 */

/** 图节点的 kind:内建五类 + 已注册 kind 读面上声明出来的 kind(见 graph/endpoint.ts)。 */
export type EgoEntity = EntityKind;

export interface EgoNodeMeta {
  entity: EgoEntity;
  row: TaskRow | DecisionRow | FactRef | AgentNodeRow | ScheduleNodeRow | GovernedEntityRow;
}

export type EgoNodeData = Record<string, unknown> & {
  id: string;
  entity: EgoEntity;
  raw: EgoNodeMeta["row"];
  label: string;
  sub?: string;
  focus: boolean;
  hop: number;
  degree: number;
  hiddenCount: number;
  dimmed: boolean;
  color?: string;
  navRef: string;
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
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
  /** 选中的实体种类;null = 不按种类筛(调用方没有已注册 kind 清单时的诚实缺省)。 */
  types: ReadonlySet<string> | null;
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
 * 统一图:byId(五类实体归一 id) + adj(relations 双向 + 合成边)。
 *
 * factAnchors 里有、facts 投影里没有正文的 fact 仍然建节点(标 anchor,正文留空),
 * 否则指向它的 evidenced-by 边会静默消失 —— 那是把「未投影」伪装成「没有关系」。
 * 但绝不为它编造正文。agent/schedule 行缺席时同理:指向它的 dispatches 边被跳过,
 * 不造节点(agent/schedule 行来自各自的既有读,读不到就是该平面缺席)。
 *
 * 合成边两条,同一条先例(执行轴,不在 relations 投影里):
 *   task 父子(parentTaskId)与 schedule→agent(Schedule 定义声明的 target)。
 */
export function buildEgoGraph(
  tasks: ReadonlyArray<TaskRow>,
  decisions: ReadonlyArray<DecisionRow>,
  facts: ReadonlyArray<FactRef>,
  relations: ReadonlyArray<RelationEdge>,
  factAnchors: ReadonlyArray<{ factRef: string; taskId?: string; factId: string }> = [],
  runtime: { readonly agents?: ReadonlyArray<AgentNodeRow>; readonly schedules?: ReadonlyArray<ScheduleNodeRow> } = {},
  governed: ReadonlyArray<GovernedEntityRow> = [],
): EgoGraph {
  const byId = new Map<string, EgoNodeMeta>();
  for (const t of tasks) byId.set(t.taskId, { entity: "task", row: t });
  for (const d of decisions) byId.set(`decision/${d.decisionId}`, { entity: "decision", row: d });
  for (const f of facts) byId.set(egoFactRefOf(f), { entity: "fact", row: f });
  for (const a of runtime.agents ?? []) byId.set(a.id, { entity: "agent", row: a });
  for (const s of runtime.schedules ?? []) byId.set(s.id, { entity: "schedule", row: s });
  // 声明实体:ref 整串即节点 id(与 endpointToNodeId 的兜底同形),kind 即 entity。
  for (const row of governed) byId.set(row.ref, { entity: row.kind, row });
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

  const declaredKinds = [...new Set(governed.map(({ kind }) => kind))];
  relations.forEach((edge, i) => {
    if (!parseEndpoint(edge.from, declaredKinds) || !parseEndpoint(edge.to, declaredKinds)) return;
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
  // 合成 schedule→agent 边:Schedule 定义声明的 target(执行轴,同一条先例)。
  for (const edge of scheduleTargetEdges(runtime.schedules ?? [])) {
    const key = `sched_${edge.from}`;
    link(edge, "execution", key);
    synthEdges.push({ edge, key });
  }

  return { byId, adj, synthEdges };
}

/** 聚焦铺开的跳数预算:向上(父系)与向下(落地)各一,任务图谱页的步进器改它。 */
export interface EgoHopBudget {
  readonly up: number;
  readonly down: number;
}

/** 从焦点按 `{up, down}` 预算 BFS 的可见集(id → 距焦点跳数),按轴过滤。
 *
 * 方向语义与 layoutEgoCanvas 的分侧同源:焦点的出边邻居归「下游/右」、入边邻居归
 * 「上游/左」,更深处**继承**来侧(一条 up 侧路径上的折返边不把节点挪到 down 侧),
 * 所以两侧预算各自约束的是「沿该侧走出的跳数」,不是「纯出边/纯入边可达」。
 * `up === down` 时与旧的对称 maxHop 完全同集。
 *
 * `allowed`(重点模式)再收一层:只有重点集里的节点会被铺开,重点外的邻居留在
 * chip 的「+N 未铺开」徽章里(双击以它为中心重排即可展开)。焦点自身恒可见。
 */
export function bfsShownFromFocus(
  graph: EgoGraph,
  focusId: string,
  hops: EgoHopBudget,
  axes: EgoAxisFilter,
  allowed: ReadonlySet<string> | null = null,
): Map<string, number> {
  const pass = (id: string) => allowed === null || id === focusId || allowed.has(id);
  const shown = new Map<string, number>([[focusId, 0]]);
  const queue: Array<[string, "up" | "down", number]> = [[focusId, "down", 0]];
  while (queue.length > 0) {
    const [id, side, hop] = queue.shift()!;
    for (const entry of graph.adj.get(id) ?? []) {
      if (!axes[entry.axis]) continue;
      if (shown.has(entry.other)) continue;
      if (!pass(entry.other)) continue;
      const nextSide = id === focusId ? (entry.dir === "out" ? "down" : "up") : side;
      if (hop + 1 > hops[nextSide]) continue;
      shown.set(entry.other, hop + 1);
      queue.push([entry.other, nextSide, hop + 1]);
    }
  }
  return shown;
}

/** 某节点经轴过滤的一跳邻居 id(去重)。单跳高亮集(egoOneHopHighlight)用。 */
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
// §5.2 后节点只有一种形态:紧凑 chip,焦点与邻居同尺寸;内容一律在抽屉里。
const CHIP_W = 216;
const CHIP_H = 46;
const GAP_X = 72;
const GAP_Y = 36;

export interface EgoCanvasInput {
  focusId: string;
  graph: EgoGraph;
  relations: ReadonlyArray<RelationEdge>;
  filters: EgoFilters;
  /** 累积可见集:node id → 距焦点跳数。 */
  shown: ReadonlyMap<string, number>;
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
  const { focusId, graph, filters, shown, highlight } = input;
  const { byId, adj, synthEdges } = graph;
  const focusMeta = byId.get(focusId);
  if (!focusMeta) return emptyEgoLayout();

  const axisOn = (axis: SemanticAxis): boolean => filters.axes[axis];
  const typeOn = (entity: EgoEntity): boolean => filters.types === null || filters.types.has(entity);
  const nodeW = CHIP_W;
  const nodeH = CHIP_H;

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
    let cx = nodeW / 2;
    let depth = 1;
    while (cols.has(`${sideKey}:${depth}`)) {
      const ids = cols.get(`${sideKey}:${depth}`)!;
      ids.sort((a, b) => barycenter(a, depth - 1) - barycenter(b, depth - 1) || a.localeCompare(b));
      cx += GAP_X + nodeW / 2;
      const totalH = ids.length * nodeH + (ids.length - 1) * GAP_Y;
      let y = -totalH / 2;
      for (const id of ids) {
        pos.set(id, { x: sign * cx, y: y + nodeH / 2 });
        y += nodeH + GAP_Y;
      }
      cx += nodeW / 2;
      depth += 1;
    }
  }

  // ── 组装节点 ──
  const nodes: EgoFlowNode[] = [];
  for (const id of vis) {
    const meta = byId.get(id);
    if (!meta) continue;
    const center = pos.get(id) ?? { x: 0, y: 0 };
    // 「还有多少邻居没铺开」—— chip 上的 +N 徽章;双击该节点重排邻域即可展开。
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
      position: { x: center.x - nodeW / 2, y: center.y - nodeH / 2 },
      width: nodeW,
      height: nodeH,
      data: {
        id,
        entity: meta.entity,
        raw: meta.row,
        label: egoLabelOf(meta),
        ...(egoSubOf(meta) === undefined ? {} : { sub: egoSubOf(meta) }),
        focus: id === focusId,
        hop: level.get(id) ?? 0,
        degree: (adj.get(id) ?? []).filter((entry) => axisOn(entry.axis)).length,
        hiddenCount,
        dimmed: highlight ? !highlight.has(id) : false,
        color: meta.entity === "task" ? STATUS_META[(meta.row as TaskRow).coordinationStatus]?.color : undefined,
        navRef: meta.entity === "task" ? `task/${id}` : id,
      },
      draggable: false,
      zIndex: id === focusId ? 6 : 1,
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
  // 端点能否成节点由已建好的 byId 决定(它已经含声明实体),不在这里再判一次 kind。
  const canvasKinds = [...new Set([...input.graph.byId.values()].map(({ entity }) => entity))];
  input.relations.forEach((edge, i) => {
    if (!parseEndpoint(edge.from, canvasKinds) || !parseEndpoint(edge.to, canvasKinds)) return;
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

/**
 * 副标题:声明实体显示它的 locator 指针;内建 kind 的副标由各自的卡片内容负责。
 * 按行的形状判断,不按 kind 名单——名单会随声明变,行的形状不会。
 */
function egoSubOf(meta: EgoNodeMeta): string | undefined {
  const row = meta.row as Partial<GovernedEntityRow>;
  return typeof row.ref === "string" && "locator" in row ? governedEntitySub(row as GovernedEntityRow) : undefined;
}

function egoLabelOf(meta: EgoNodeMeta): string {
  if (meta.entity === "task") return (meta.row as TaskRow).title;
  if (meta.entity === "decision") return (meta.row as DecisionRow).title;
  if (meta.entity === "agent") return (meta.row as AgentNodeRow).name;
  if (meta.entity === "schedule") return (meta.row as ScheduleNodeRow).name;
  if (meta.entity === "fact") {
    const fact = meta.row as FactRef;
    // 无正文的 anchor:显示锚点本身,不拿别处的文字冒充观察。已归档行带前缀标记
    // (dec_62CAE6CA):开关放行回来时,聚光灯里第一眼能认出它为什么默认被藏。
    const label = fact.text ? fact.text.slice(0, 60) : fact.anchor;
    return fact.archived ? `已归档 · ${label}` : label;
  }
  // 其余都是声明实体:标题在描述符里,没有就显示 entityId。
  return governedEntityLabel(meta.row as GovernedEntityRow);
}
