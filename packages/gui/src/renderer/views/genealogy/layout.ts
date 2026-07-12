import type { DecisionRow, RelationEdge, RelationKind } from "../../model/types";

/**
 * 决策谱系「演化史」视图的纯逻辑层：常量、类型、关系筛选、深度优先谱系收集、
 * 时间轴布局计算。无 React、无 JSX，方便单测与复用。
 *
 * 承接 dec_01KXA7811SVVT8P66HNDFZQ7DF 原则 6：关系图解决「结构」，而 decision
 * 谱系（refines/narrows/supersedes/supports）本质是**时间演化**，用一条时间轴
 * 更清晰——X=decidedAt（缺则 fallback proposedAt），行=谱系深度，节点=决策卡。
 */

// 谱系边：只认权威轴里表达「思想演化」的四类关系，两端必须都是 decision。
export const GENEALOGY_KINDS = new Set<RelationKind>([
  "refines",
  "narrows",
  "supersedes",
  "supports",
]);

// 每类边的语义标签 + 语义色（复用 styles.css 里已定义的 CSS 变量，绝不新造）。
export const KIND_META: Record<
  string,
  { label: string; color: string; verb: string }
> = {
  refines: { label: "细化", color: "var(--color-accent)", verb: "细化了" },
  narrows: { label: "收窄", color: "var(--color-status-in-review)", verb: "收窄了" },
  supersedes: { label: "推翻", color: "var(--color-danger)", verb: "推翻了" },
  supports: { label: "支撑", color: "var(--color-status-done)", verb: "支撑了" },
};

// ---- 布局常量（px）----
export const CARD_W = 210;
export const CARD_H = 60;
export const ROW_H = 82;
export const AXIS_H = 34;
export const PAD_X = 28;
export const PAD_Y = 20;
export const LANE_GAP = 26; // 同一深度带内两卡的最小水平间隙

export interface GenealogyEdge {
  from: string; // 后代（较新，refines/narrows/... 的一方）
  to: string; // 祖先（较旧，被 refine 的一方）
  kind: RelationKind;
  rationale?: string;
}

export interface LaidOutNode {
  id: string;
  decision: DecisionRow;
  depth: number; // 相对焦点：祖先为负、焦点为 0、后代为正
  timeMs: number | null;
  x: number; // 卡片左上角 x（含 PAD）
  y: number; // 卡片左上角 y（含 AXIS + PAD）
}

export interface TimelineLayout {
  nodes: LaidOutNode[];
  width: number;
  height: number;
  ticks: { x: number; label: string }[];
  minT: number;
  maxT: number;
}

/** 把 `decision/dec_x/CH1` 之类的 ref 归一成裸 decision id；非 decision 端返回 null。 */
export function decisionIdOf(ref: string): string | null {
  if (!ref.startsWith("decision/")) return null;
  const rest = ref.slice("decision/".length);
  const id = rest.split("/")[0];
  return id.length > 0 ? id : null;
}

/** decidedAt 优先，缺则 proposedAt；都无 → null（优雅降级）。 */
export function timeMsOf(decision: DecisionRow): number | null {
  const raw = decision.decidedAt ?? decision.proposedAt;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function shortTime(decision: DecisionRow): string {
  const raw = decision.decidedAt ?? decision.proposedAt;
  if (!raw) return "无判定时间";
  return raw.slice(0, 10);
}

/** 全量谱系边（decision→decision），去重。 */
export function buildGenealogyEdges(
  relations: RelationEdge[],
  byId: Map<string, DecisionRow>,
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

/** 以 focus 为中心，上溯祖先（沿 from→to）+ 下溯后代（沿 to→from），返回带 depth 的谱系集合。 */
export function collectLineage(
  focusId: string,
  edges: GenealogyEdge[],
): Map<string, number> {
  const outByFrom = new Map<string, GenealogyEdge[]>();
  const inByTo = new Map<string, GenealogyEdge[]>();
  for (const edge of edges) {
    (outByFrom.get(edge.from) ?? outByFrom.set(edge.from, []).get(edge.from)!).push(edge);
    (inByTo.get(edge.to) ?? inByTo.set(edge.to, []).get(edge.to)!).push(edge);
  }

  const depth = new Map<string, number>([[focusId, 0]]);

  // 上溯祖先：focus --refines--> ancestor，祖先更旧 → 负 depth。
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

  // 下溯后代：descendant --refines--> focus，后代更新 → 正 depth。
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

/** 时间轴上做 3–6 个刻度。 */
export function axisTicks(minT: number, maxT: number): { t: number; label: string }[] {
  if (!(maxT > minT)) return [];
  const count = 5;
  const ticks: { t: number; label: string }[] = [];
  for (let i = 0; i <= count; i += 1) {
    const t = minT + ((maxT - minT) * i) / count;
    ticks.push({ t, label: new Date(t).toISOString().slice(0, 10) });
  }
  return ticks;
}

const EMPTY_LAYOUT: TimelineLayout = {
  nodes: [],
  width: 0,
  height: 0,
  ticks: [],
  minT: 0,
  maxT: 0,
};

/**
 * 焦点谱系的时间轴布局：按 depth 升序（祖先在上）分带，带内按 x 排序后贪心装道，
 * 保证零重叠。无焦点 → 空布局。
 */
export function computeLayout(
  focus: DecisionRow | null,
  edges: GenealogyEdge[],
  byId: Map<string, DecisionRow>,
  plotWidth: number,
): TimelineLayout {
  if (!focus) return EMPTY_LAYOUT;

  const depthMap = collectLineage(focus.decisionId, edges);
  const rawNodes = [...depthMap.entries()]
    .map(([id, depth]) => {
      const decision = byId.get(id);
      if (!decision) return null;
      return { id, decision, depth, timeMs: timeMsOf(decision) };
    })
    .filter((node): node is Omit<LaidOutNode, "x" | "y"> => node !== null);

  const times = rawNodes.map((node) => node.timeMs).filter((t): t is number => t !== null);
  const minT = times.length > 0 ? Math.min(...times) : 0;
  const maxT = times.length > 0 ? Math.max(...times) : 0;
  const span = maxT - minT;

  const plotW = Math.max(360, plotWidth - PAD_X * 2 - CARD_W);
  const xOfTime = (timeMs: number | null): number => {
    if (timeMs === null) return 0; // 无时间 → 贴最左，并在卡上标注
    if (span <= 0) return plotW / 2;
    return ((timeMs - minT) / span) * plotW;
  };

  const depths = [...new Set(rawNodes.map((node) => node.depth))].sort((a, b) => a - b);
  const placed: LaidOutNode[] = [];
  let rowCursor = 0;
  for (const depth of depths) {
    const group = rawNodes
      .filter((node) => node.depth === depth)
      .sort((a, b) => xOfTime(a.timeMs) - xOfTime(b.timeMs));
    const laneRight: number[] = [];
    for (const node of group) {
      const nx = xOfTime(node.timeMs);
      let lane = laneRight.findIndex((right) => nx >= right + LANE_GAP);
      if (lane === -1) {
        lane = laneRight.length;
        laneRight.push(0);
      }
      laneRight[lane] = nx + CARD_W;
      placed.push({
        ...node,
        x: PAD_X + nx,
        y: AXIS_H + PAD_Y + (rowCursor + lane) * ROW_H,
      });
    }
    rowCursor += Math.max(1, laneRight.length);
  }

  const width = PAD_X * 2 + plotW + CARD_W;
  const height = AXIS_H + PAD_Y * 2 + rowCursor * ROW_H;
  const ticks = axisTicks(minT, maxT).map((tick) => ({
    x: PAD_X + xOfTime(tick.t),
    label: tick.label,
  }));
  return { nodes: placed, width, height, ticks, minT, maxT };
}
