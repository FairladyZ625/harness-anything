import type { DecisionRow, RelationEdge, RelationKind } from "../../model/types";
import { t } from "../../i18n/core.ts";

/**
 * 决策谱系「演化史」视图的纯逻辑层：常量、类型、关系筛选、深度优先谱系收集。
 * 布局编码实现见 layout-encodings.ts。
 *
 * 时间维度是对的，但线性 wall-clock x 轴对点事件+成簇数据是错的。
 */

export const GENEALOGY_KINDS = new Set<RelationKind>([
  "refines",
  "narrows",
  "supersedes",
  "supports",
]);

/** 边语义：色 + 线型，不靠回头读图例也能分。 */
export const KIND_META: Record<
  string,
  { label: string; color: string; verb: string; dash: string; strokeWidth: number }
> = {
  refines: {
    get label() { return t("views.layout.refine"); },
    color: "var(--color-accent)",
    get verb() { return t("views.layout.refined"); },
    dash: "",
    strokeWidth: 1.6,
  },
  narrows: {
    get label() { return t("views.layout.narrow"); },
    color: "var(--color-status-in-review)",
    get verb() { return t("views.layout.narrowed"); },
    dash: "5 3",
    strokeWidth: 1.6,
  },
  supersedes: {
    get label() { return t("views.layout.overthrow"); },
    color: "var(--color-danger)",
    get verb() { return t("views.layout.overturned"); },
    dash: "",
    strokeWidth: 2.4,
  },
  supports: {
    get label() { return t("views.layout.support"); },
    color: "var(--color-status-done)",
    get verb() { return t("views.layout.supported"); },
    dash: "1.5 2.5",
    strokeWidth: 1.4,
  },
};

/** 编码模式：DAG 拓扑（唯一布局），日簇是同列内同日节点过多时的自动收敛策略。 */
export type EncodingMode = "dag";

export const ENCODING_META: Record<
  EncodingMode,
  { label: string; short: string; blurb: string }
> = {
  dag: {
    get label() { return t("views.layout.dagTopology"); },
    short: "DAG",
    get blurb() { return t("views.layout.genealogyTopologyTypesettingOnlySortingByTime"); },
  },
};

// ---- 布局常量（px）----
// 卡片加宽加高，让真实账本里 80–100 字标题能完整显示（3 行 × ~28 字）。
export const CARD_W = 280;
export const CARD_H = 96;
export const ROW_H = 118;
export const AXIS_H = 34;
export const PAD_X = 28;
export const PAD_Y = 20;
export const CLUSTER_W = 188;
export const CLUSTER_H = 72;

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
  encoding: EncodingMode;
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

export function shortTime(decision: DecisionRow): string {
  const raw = decision.decidedAt ?? decision.proposedAt;
  if (!raw) return t("views.layout.noDecisionTime");
  return raw.slice(0, 10);
}

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

export function findGenealogyCycles(edges: GenealogyEdge[]): string[][] {
  const byFrom = new Map<string, string[]>();
  for (const edge of edges) {
    const arr = byFrom.get(edge.from) ?? [];
    arr.push(edge.to);
    byFrom.set(edge.from, arr);
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

export interface RawLineageNode {
  id: string;
  decision: DecisionRow;
  depth: number;
  timeMs: number | null;
  dayKey: string;
}

export function collectRawNodes(
  focus: DecisionRow,
  edges: GenealogyEdge[],
  byId: Map<string, DecisionRow>,
): RawLineageNode[] {
  const depthMap = collectLineage(focus.decisionId, edges);
  return [...depthMap.entries()]
    .map(([id, depth]) => {
      const decision = byId.get(id);
      if (!decision) return null;
      return {
        id,
        decision,
        depth,
        timeMs: timeMsOf(decision),
        dayKey: dayKeyOf(decision),
      };
    })
    .filter((node): node is RawLineageNode => node !== null);
}

export const EMPTY_LAYOUT: TimelineLayout = {
  nodes: [],
  width: 0,
  height: 0,
  ticks: [],
  minT: 0,
  maxT: 0,
  encoding: "dag",
  cycleWarning: { count: 0, cycles: [] },
};

export type LayoutOptions = {
  expandedDays?: ReadonlySet<string>;
};

// re-export dispatcher so现有 import { computeLayout } from "./layout" 仍可用
export { computeLayout } from "./layout-encodings";
