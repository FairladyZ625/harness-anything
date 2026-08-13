import type { DecisionRow, RelationEdge, RelationKind } from "../model/types";

/**
 * 决策谱系「演化史」纯逻辑层(REQ-GUI-05)。
 *
 * 纯前端派生:从 relations 筛谱系四类边(refines/narrows/supersedes/supports —— 均为
 * decision↔decision),焦点上溯/下溯。布局 = DAG 拓扑(x = 谱系深度 rank),同列内同日
 * 节点过多时自动折成簇(time cluster)。
 *
 * 只认 decision 间谱系边;task/fact 无谱系(由 EntityWorkspace 在 mode 层给空态)。
 */

/** 谱系四类边(仅 decision↔decision)。 */
export const GENEALOGY_KINDS = new Set<RelationKind>([
  "refines",
  "narrows",
  "supersedes",
  "supports",
]);

/** 边语义:色 + 线型。 */
export const KIND_META: Record<
  string,
  { label: string; color: string; verb: string; dash: string; strokeWidth: number }
> = {
  refines: { label: "细化", color: "var(--color-accent)", verb: "细化自", dash: "", strokeWidth: 1.6 },
  narrows: { label: "收窄", color: "var(--color-status-in-review)", verb: "收窄自", dash: "5 3", strokeWidth: 1.6 },
  supersedes: { label: "推翻", color: "var(--color-danger)", verb: "推翻了", dash: "", strokeWidth: 2.4 },
  supports: { label: "支撑", color: "var(--color-status-done)", verb: "支撑", dash: "1.5 2.5", strokeWidth: 1.4 },
};

// ---- 布局常量(px)----
export const CARD_W = 280;
export const CARD_H = 96;
export const ROW_H = 118;
export const AXIS_H = 34;
export const PAD_X = 28;
export const PAD_Y = 20;
export const CLUSTER_W = 188;
export const CLUSTER_H = 72;
const LANE_STEP_MIN = 12;
const SAME_DAY_CLUSTER_THRESHOLD = 2;

export interface GenealogyEdge {
  from: string;
  to: string;
  kind: RelationKind;
  rationale?: string;
}

export interface LaidOutNode {
  id: string;
  decision: DecisionRow;
  depth: number;
  timeMs: number | null;
  x: number;
  y: number;
  dayKey?: string;
  isCluster?: boolean;
  clusterSize?: number;
  memberIds?: string[];
}

export interface TimelineLayout {
  nodes: LaidOutNode[];
  width: number;
  height: number;
  ticks: { x: number; label: string }[];
  minT: number;
  maxT: number;
  cycleWarning: { count: number; cycles: string[][] };
}

export function decisionIdOf(ref: string): string | null {
  if (!ref.startsWith("decision/")) return null;
  const rest = ref.slice("decision/".length);
  const id = rest.split("/")[0];
  return id.length > 0 ? id : null;
}

export function timeMsOf(decision: DecisionRow): number | null {
  const raw = decision.decidedAt ?? decision.proposedAt;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function dayKeyOf(decision: DecisionRow): string {
  const raw = decision.decidedAt ?? decision.proposedAt;
  if (!raw) return "NO_TIME";
  return raw.slice(0, 10);
}

/**
 * 从全部 relations 筛出 decision↔decision 谱系边(去重)。
 * 端点不在 byId 里的边丢弃(不发明 decision)。
 */
export function buildGenealogyEdges(
  relations: ReadonlyArray<RelationEdge>,
  byId: ReadonlyMap<string, DecisionRow>,
): GenealogyEdge[] {
  const seen = new Set<string>();
  const edges: GenealogyEdge[] = [];
  for (const relation of relations) {
    if (!GENEALOGY_KINDS.has(relation.kind)) continue;
    const from = decisionIdOf(relation.from);
    const to = decisionIdOf(relation.to);
    if (!from || !to || from === to) continue;
    if (!byId.has(from) || !byId.has(to)) continue;
    const key = `${from}|${to}|${relation.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, kind: relation.kind, rationale: relation.rationale });
  }
  return edges;
}

interface RawLineageNode {
  id: string;
  decision: DecisionRow;
  depth: number;
  timeMs: number | null;
  dayKey: string;
}

/**
 * 焦点上溯/下溯谱系,返回每个 decision 的 depth(焦点=0,祖先<0,后代>0)。
 *
 * Canonical 契约(kernel entity-relation):`source <verb> target`。
 *   refines: source=refiner=后代(更细/更新),target=refined=祖先(更粗/更早)。
 *   narrows/supersedes 同理:source 是后代(收窄/推翻者),target 是祖先。
 *   supports: source 支撑 target —— 方向上 source 是 target 的支撑,谱系上
 *   仍按 source=后代(后出的支撑决策)处理,与 refines 族一致。
 *
 * 因此:edge.from(source)=后代,edge.to(target)=祖先。
 *   - 后代(depth+1)= 沿 inByTo 反向:指向 current 的边的 source 就是 current 的后代。
 *   - 祖先(depth-1)= 沿 outByFrom 正向:current 作为 source 的边的 target 就是 current 的祖先。
 *
 * 双向 BFS;已访问不再更新 depth(首达即定层)。
 */
export function collectLineage(
  focusId: string,
  edges: ReadonlyArray<GenealogyEdge>,
): Map<string, number> {
  const outByFrom = new Map<string, GenealogyEdge[]>();
  const inByTo = new Map<string, GenealogyEdge[]>();
  for (const edge of edges) {
    pushInto(outByFrom, edge.from, edge);
    pushInto(inByTo, edge.to, edge);
  }

  const depth = new Map<string, number>([[focusId, 0]]);

  // 祖先(depth-1):current 作为 source 的边 → edge.to(target)是祖先。
  const upQueue: string[] = [focusId];
  while (upQueue.length > 0) {
    const current = upQueue.shift()!;
    const currentDepth = depth.get(current)!;
    for (const edge of outByFrom.get(current) ?? []) {
      if (!depth.has(edge.to)) {
        depth.set(edge.to, currentDepth - 1);
        upQueue.push(edge.to);
      }
    }
  }
  // 后代(depth+1):指向 current 的边 → edge.from(source)是后代。
  const downQueue: string[] = [focusId];
  while (downQueue.length > 0) {
    const current = downQueue.shift()!;
    const currentDepth = depth.get(current)!;
    for (const edge of inByTo.get(current) ?? []) {
      if (!depth.has(edge.from)) {
        depth.set(edge.from, currentDepth + 1);
        downQueue.push(edge.from);
      }
    }
  }
  return depth;
}

function pushInto(map: Map<string, GenealogyEdge[]>, key: string, edge: GenealogyEdge): void {
  const arr = map.get(key);
  if (arr) arr.push(edge);
  else map.set(key, [edge]);
}

/** 谱系环检测(DFS + 栈)。 */
export function findGenealogyCycles(edges: ReadonlyArray<GenealogyEdge>): string[][] {
  const byFrom = new Map<string, string[]>();
  for (const edge of edges) {
    pushStr(byFrom, edge.from, edge.to);
  }
  const cycles: string[][] = [];
  const seenKeys = new Set<string>();
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string) => {
    if (onStack.has(node)) {
      const start = stack.indexOf(node);
      if (start >= 0) {
        const cycle = [...stack.slice(start), node];
        const key = cycle.join(">");
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          cycles.push(cycle);
        }
      }
      return;
    }
    if (visited.has(node)) return;
    onStack.add(node);
    stack.push(node);
    for (const next of byFrom.get(node) ?? []) visit(next);
    stack.pop();
    onStack.delete(node);
    visited.add(node);
  };

  for (const node of byFrom.keys()) visit(node);
  return cycles;
}

function pushStr(map: Map<string, string[]>, key: string, val: string): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

function collectRawNodes(
  focus: DecisionRow,
  edges: ReadonlyArray<GenealogyEdge>,
  byId: ReadonlyMap<string, DecisionRow>,
): RawLineageNode[] {
  const depthMap = collectLineage(focus.decisionId, edges);
  return [...depthMap.entries()]
    .map(([id, depth]) => {
      const decision = byId.get(id);
      if (!decision) return null;
      return { id, decision, depth, timeMs: timeMsOf(decision), dayKey: dayKeyOf(decision) };
    })
    .filter((n): n is RawLineageNode => n !== null);
}

export const EMPTY_LAYOUT: TimelineLayout = {
  nodes: [],
  width: 0,
  height: 0,
  ticks: [],
  minT: 0,
  maxT: 0,
  cycleWarning: { count: 0, cycles: [] },
};

export interface LayoutOptions {
  expandedDays?: ReadonlySet<string>;
}

/**
 * 焦点谱系布局调度。DAG 拓扑(x = 谱系深度 rank),同列同日节点过多自动折簇。
 */
export function computeLayout(
  focus: DecisionRow | null,
  edges: ReadonlyArray<GenealogyEdge>,
  byId: ReadonlyMap<string, DecisionRow>,
  plotWidth: number,
  options: LayoutOptions = {},
): TimelineLayout {
  if (!focus) return EMPTY_LAYOUT;
  const expandedDays = options.expandedDays ?? new Set<string>();
  const cycles = findGenealogyCycles(edges);
  const cycleWarning = { count: cycles.length, cycles };

  const raw = collectRawNodes(focus, edges, byId);
  const times = raw.map((n) => n.timeMs).filter((t): t is number => t !== null);
  const minT = times.length ? Math.min(...times) : 0;
  const maxT = times.length ? Math.max(...times) : 0;

  const depths = raw.map((n) => n.depth);
  const minDepth = depths.length ? Math.min(...depths) : 0;
  const rankOf = new Map(raw.map((n) => [n.id, n.depth - minDepth]));

  const byRank = new Map<number, RawLineageNode[]>();
  for (const node of raw) {
    const rank = rankOf.get(node.id) ?? 0;
    pushNode(byRank, rank, node);
  }
  for (const list of byRank.values()) {
    list.sort((a, b) => {
      const ta = a.timeMs ?? Number.POSITIVE_INFINITY;
      const tb = b.timeMs ?? Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    });
  }

  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const maxRank = ranks.length ? Math.max(...ranks) : 0;
  const plotW = Math.max(360, plotWidth - PAD_X * 2 - CARD_W);
  const colStep =
    maxRank <= 0
      ? 0
      : Math.max(CARD_W + LANE_STEP_MIN, Math.min(CARD_W + 80, plotW / maxRank));
  const contentW = Math.max(plotW, maxRank * colStep);

  const placed: LaidOutNode[] = [];
  for (const rank of ranks) {
    const col = byRank.get(rank) ?? [];
    const x = maxRank === 0 ? PAD_X + contentW / 2 - CARD_W / 2 : PAD_X + rank * colStep;

    const byDayInCol = new Map<string, RawLineageNode[]>();
    for (const node of col) pushNodeStr(byDayInCol, node.dayKey, node);
    const dayKeys = [...byDayInCol.keys()].sort((a, b) => {
      if (a === "NO_TIME") return 1;
      if (b === "NO_TIME") return -1;
      return a.localeCompare(b);
    });

    let rowCursor = 0;
    for (const dayKey of dayKeys) {
      const dayNodes = byDayInCol.get(dayKey)!;
      const shouldFold = dayNodes.length >= SAME_DAY_CLUSTER_THRESHOLD && !expandedDays.has(dayKey);
      if (shouldFold) {
        const seed = dayNodes[0]!;
        const midDepths = dayNodes.map((m) => m.depth).sort((a, b) => a - b);
        const mid = midDepths[Math.floor(midDepths.length / 2)] ?? 0;
        placed.push({
          id: `cluster:${rank}:${dayKey}`,
          decision: seed.decision,
          depth: mid,
          timeMs: seed.timeMs,
          dayKey,
          x: maxRank === 0 ? PAD_X + contentW / 2 - CLUSTER_W / 2 : x,
          y: AXIS_H + PAD_Y + rowCursor * ROW_H,
          isCluster: true,
          clusterSize: dayNodes.length,
          memberIds: dayNodes.map((m) => m.id),
        });
        rowCursor += 1;
      } else {
        for (const node of dayNodes) {
          placed.push({ ...node, x, y: AXIS_H + PAD_Y + rowCursor * ROW_H, isCluster: false });
          rowCursor += 1;
        }
      }
    }
  }

  const ticks = ranks.map((rank) => {
    const col = byRank.get(rank) ?? [];
    const label =
      rank === 0 ? "焦点" : rank === maxRank ? "后代" : `第 ${rank} 层`;
    const x = maxRank === 0 ? PAD_X + contentW / 2 : PAD_X + rank * colStep;
    const day = col[0]?.dayKey;
    const dayLabel = day && day !== "NO_TIME" ? day.slice(5) : "";
    return { x, label: dayLabel ? `${label} · ${dayLabel}` : label };
  });

  const maxRight = placed.reduce((m, n) => Math.max(m, n.x + (n.isCluster ? CLUSTER_W : CARD_W)), PAD_X + 360);
  const maxBottom = placed.reduce((m, n) => Math.max(m, n.y + (n.isCluster ? CLUSTER_H : CARD_H)), AXIS_H + PAD_Y + ROW_H);

  return {
    nodes: placed,
    width: Math.max(maxRight + PAD_X, 480),
    height: maxBottom + PAD_Y,
    ticks,
    minT,
    maxT,
    cycleWarning,
  };
}

function pushNode<T>(map: Map<number, T[]>, key: number, val: T): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}
function pushNodeStr<T>(map: Map<string, T[]>, key: string, val: T): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}
