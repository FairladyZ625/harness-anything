import type { RelationKind, RelationEdge } from "../model/types";
import { KIND_AXIS, type SemanticAxis } from "./constants";

/**
 * 关系类型视觉词表 + 筛选/动画纯函数。
 * 色按语义轴走 CSS 变量;类型间差异用线型(dash)+ 线宽 + 端点形态表达。
 * 动画克制:默认仅 focus(选中/悬停/邻接)边流动,全局开关兜底。
 */

export type FlowAnimMode = "off" | "focus" | "all";

export interface RelationVisual {
  dasharray: string | undefined;
  strokeWidth: number;
}

/**
 * 每类 relation 的一致视觉词表。
 * 记忆锚:supersedes=堆叠(粗虚线) / derives=方向流(实线稍粗) / 路径类画线。
 */
export const RELATION_VISUAL: Record<RelationKind, RelationVisual> = {
  derives: { dasharray: undefined, strokeWidth: 1.8 },
  supersedes: { dasharray: "6 3", strokeWidth: 2.2 },
  refines: { dasharray: "6 3", strokeWidth: 1.6 },
  narrows: { dasharray: "2 3", strokeWidth: 1.5 },
  supports: { dasharray: "1.5 2.5", strokeWidth: 1.4 },
  "evidenced-by": { dasharray: undefined, strokeWidth: 1.6 },
  evidences: { dasharray: undefined, strokeWidth: 1.5 },
  "supersedes-fact": { dasharray: "6 3", strokeWidth: 2.0 },
  "refuted-by": { dasharray: "4 3", strokeWidth: 1.6 },
  "invalidated-by": { dasharray: "2 3", strokeWidth: 1.5 },
  "depends-on": { dasharray: undefined, strokeWidth: 1.6 },
  blocks: { dasharray: "8 3", strokeWidth: 2.0 },
  produces: { dasharray: undefined, strokeWidth: 1.5 },
  relates: { dasharray: "4 3", strokeWidth: 1.2 },
  implements: { dasharray: "1.5 2.5", strokeWidth: 1.4 },
  executes: { dasharray: undefined, strokeWidth: 1.6 },
  reviews: { dasharray: "4 3", strokeWidth: 1.5 },
  owns: { dasharray: "2 3", strokeWidth: 1.2 },
  dispatches: { dasharray: undefined, strokeWidth: 1.4 },
  authorizes: { dasharray: "6 3", strokeWidth: 1.5 },
};

/** 稳定顺序:按语义轴分组,便于筛选 UI 与图例。 */
export const RELATION_KIND_ORDER: ReadonlyArray<RelationKind> = [
  "derives",
  "supersedes",
  "refines",
  "narrows",
  "supports",
  "evidenced-by",
  "evidences",
  "supersedes-fact",
  "refuted-by",
  "invalidated-by",
  "depends-on",
  "blocks",
  "produces",
  "relates",
  "implements",
  "executes",
  "reviews",
  "owns",
  "dispatches",
  "authorizes",
];

export function visualForKind(kind: RelationKind): RelationVisual {
  return RELATION_VISUAL[kind] ?? RELATION_VISUAL.relates;
}

/** 默认关系类型筛选:assoc 轴(relates/implements)默认关,降噪。 */
export function defaultKindFilter(): Set<RelationKind> {
  return new Set(RELATION_KIND_ORDER.filter((k) => KIND_AXIS[k] !== "assoc"));
}

/** 默认语义轴筛选:assoc 默认关。 */
export function defaultAxisFilter(): Record<SemanticAxis, boolean> {
  return { authority: true, evidence: true, execution: true, assoc: false };
}

/** 边是否通过关系类型筛选。kinds 空集 = 全部隐藏。 */
export function edgePassesKindFilter(edge: Pick<RelationEdge, "kind">, kinds: ReadonlySet<string>): boolean {
  return kinds.has(edge.kind);
}

/** 是否应对该边开流动动画。 */
export function shouldAnimateEdge(
  mode: FlowAnimMode,
  opts: { selected: boolean; hovered: boolean; adjacent: boolean },
): boolean {
  if (mode === "off") return false;
  if (mode === "all") return true;
  return opts.selected || opts.hovered || opts.adjacent;
}

/** 按轴分组的 kind 列表(筛选 UI / 图例用)。 */
export function kindsByAxis(): Record<SemanticAxis, RelationKind[]> {
  const out: Record<SemanticAxis, RelationKind[]> = {
    authority: [],
    evidence: [],
    execution: [],
    assoc: [],
  };
  for (const kind of RELATION_KIND_ORDER) {
    out[KIND_AXIS[kind]].push(kind);
  }
  return out;
}

/** 图例样例:每轴一条代表 kind(色=轴,线型=kind),与老版 GraphLegend 词表一致。 */
export function legendSampleKinds(): ReadonlyArray<{
  kind: RelationKind;
  axis: SemanticAxis;
}> {
  return [
    { kind: "derives", axis: "authority" },
    { kind: "supersedes", axis: "authority" },
    { kind: "evidenced-by", axis: "evidence" },
    { kind: "depends-on", axis: "execution" },
    { kind: "blocks", axis: "execution" },
    { kind: "relates", axis: "assoc" },
  ];
}
