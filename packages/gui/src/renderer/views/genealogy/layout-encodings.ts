import type { DecisionRow } from "../../model/types";
import {
  AXIS_H,
  CARD_H,
  CARD_W,
  CLUSTER_H,
  CLUSTER_W,
  EMPTY_LAYOUT,
  type GenealogyEdge,
  type LaidOutNode,
  type LayoutOptions,
  type TimelineLayout,
  PAD_X,
  PAD_Y,
  ROW_H,
  collectRawNodes,
  findGenealogyCycles,
  type RawLineageNode,
} from "./layout";
import { t } from "../../i18n/core.ts";

/**
 * 谱系布局：DAG 拓扑为主视图，日簇折叠为同列内同日节点过多时的自动收敛策略。
 * 时间降级为排序约束，不再做坐标。
 */

/**
 * 焦点谱系布局调度。唯一编码 = DAG 拓扑（x = 谱系深度 rank），同列内同日节点过多时自动折成簇。
 * expandedDays 控制簇展开状态（按 dayKey 展开，跨 rank 同日一并展开）。
 */
export function computeLayout(
  focus: DecisionRow | null,
  edges: GenealogyEdge[],
  byId: Map<string, DecisionRow>,
  plotWidth: number,
  options: LayoutOptions = {},
): TimelineLayout {
  if (!focus) return EMPTY_LAYOUT;
  const expandedDays = options.expandedDays ?? new Set<string>();
  const cycles = findGenealogyCycles(edges);
  const cycleWarning = { count: cycles.length, cycles };

  const layout = computeDagLayout(focus, edges, byId, plotWidth, expandedDays);
  return { ...layout, cycleWarning };
}

function timeExtent(nodes: RawLineageNode[]): { minT: number; maxT: number } {
  const times = nodes.map((n) => n.timeMs).filter((t): t is number => t !== null);
  if (times.length === 0) return { minT: 0, maxT: 0 };
  return { minT: Math.min(...times), maxT: Math.max(...times) };
}

function finishLayout(
  placed: LaidOutNode[],
  ticks: { x: number; label: string }[],
  minT: number,
  maxT: number,
): TimelineLayout {
  const maxRight = placed.reduce((m, n) => {
    const w = n.isCluster ? CLUSTER_W : CARD_W;
    return Math.max(m, n.x + w);
  }, PAD_X + 360);
  const maxBottom = placed.reduce((m, n) => {
    const h = n.isCluster ? CLUSTER_H : CARD_H;
    return Math.max(m, n.y + h);
  }, AXIS_H + PAD_Y + ROW_H);
  return {
    nodes: placed,
    width: Math.max(maxRight + PAD_X, 480),
    height: maxBottom + PAD_Y,
    ticks,
    minT,
    maxT,
    encoding: "dag",
    cycleWarning: { count: 0, cycles: [] },
  };
}

const LANE_STEP_MIN = 12;
/** 同列同日节点数达到该阈值时自动折成簇。 */
const SAME_DAY_CLUSTER_THRESHOLD = 2;

/**
 * DAG 主布局：x = 拓扑层（祖先→后代），同层按时间排序后垂直装道。
 * 同列内同日节点超过阈值时自动折成簇（收敛策略），可展开。
 * 时间不做坐标，只做层内排序约束。
 */
export function computeDagLayout(
  focus: DecisionRow,
  edges: GenealogyEdge[],
  byId: Map<string, DecisionRow>,
  plotWidth: number,
  expandedDays: ReadonlySet<string> = new Set(),
): TimelineLayout {
  const raw = collectRawNodes(focus, edges, byId);
  const { minT, maxT } = timeExtent(raw);
  const ids = new Set(raw.map((n) => n.id));

  // 仅用于边过滤旁路；布局本身用 depth rank，不重算 longest-path。
  void edges.filter((e) => ids.has(e.from) && ids.has(e.to));

  const depths = raw.map((n) => n.depth);
  const minDepth = depths.length ? Math.min(...depths) : 0;
  const rankOf = new Map(raw.map((n) => [n.id, n.depth - minDepth]));

  const byRank = new Map<number, RawLineageNode[]>();
  for (const node of raw) {
    const rank = rankOf.get(node.id) ?? 0;
    const list = byRank.get(rank) ?? [];
    list.push(node);
    byRank.set(rank, list);
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
    const x =
      maxRank === 0
        ? PAD_X + contentW / 2 - CARD_W / 2
        : PAD_X + rank * colStep;

    // 按日分组，检测同日节点过多（收敛条件）。日序稳定。
    const byDayInCol = new Map<string, RawLineageNode[]>();
    for (const node of col) {
      const list = byDayInCol.get(node.dayKey) ?? [];
      list.push(node);
      byDayInCol.set(node.dayKey, list);
    }
    const dayKeys = [...byDayInCol.keys()].sort((a, b) => {
      if (a === "NO_TIME") return 1;
      if (b === "NO_TIME") return -1;
      return a.localeCompare(b);
    });

    let rowCursor = 0;
    for (const dayKey of dayKeys) {
      const dayNodes = byDayInCol.get(dayKey)!;
      const shouldFold =
        dayNodes.length >= SAME_DAY_CLUSTER_THRESHOLD && !expandedDays.has(dayKey);

      if (shouldFold) {
        // 簇 id 含 rank，避免跨列同日碰撞；展开态仍按 dayKey 统一控制。
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
          placed.push({
            ...node,
            x,
            y: AXIS_H + PAD_Y + rowCursor * ROW_H,
            isCluster: false,
            dayKey: node.dayKey,
          });
          rowCursor += 1;
        }
      }
    }
  }

  const ticks = ranks.map((rank) => {
    const col = byRank.get(rank) ?? [];
    const label =
      rank === 0 ? t("views.layoutEncodings.ancestors") : rank === maxRank ? t("views.layoutEncodings.descendants") : t("views.layoutEncodings.layerRank", { rank: rank });
    const x = maxRank === 0 ? PAD_X + contentW / 2 : PAD_X + rank * colStep;
    const day = col[0]?.dayKey;
    const dayLabel = day && day !== "NO_TIME" ? day.slice(5) : "";
    return {
      x,
      label: dayLabel ? `${label} · ${dayLabel}` : label,
    };
  });

  return finishLayout(placed, ticks, minT, maxT);
}
