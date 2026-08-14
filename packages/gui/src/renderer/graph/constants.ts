import type { RelationKind } from "../model/types";

// 图节点尺寸
export const NODE_W = 150;
export const NODE_H = 44;
export const GAP_X = 90;
export const GAP_Y = 24;
export const PAD = 24;
// 三元语泳道间距：decision 顶部 / task 中部 / fact 底部
export const SWIM_GAP = 70;

/**
 * 语义轴(dec_01KXA7811SVVT8P66HNDFZQ7DF CH4)。关系类型按语义归并为四轴,
 * 每轴一种视觉 + 可独立开关,relates 默认关。
 *   authority  权威  — decision 谱系 / 派生 (refines/narrows/supersedes/derives/supports)
 *   evidence   证据  — fact 佐证 (evidenced-by/supersedes-fact)
 *   execution  执行  — task 协作 (depends-on)
 *   assoc      关联  — 松关联 (relates/implements)
 */
export type SemanticAxis = "authority" | "evidence" | "execution" | "assoc";

export const AXIS_ORDER: ReadonlyArray<SemanticAxis> = [
  "authority",
  "evidence",
  "execution",
  "assoc",
];

export const AXIS_LABEL: Record<SemanticAxis, string> = {
  authority: "权威",
  evidence: "证据",
  execution: "执行",
  assoc: "关联",
};

export const AXIS_SUBLABEL: Record<SemanticAxis, string> = {
  authority: "refines · supersedes · derives · supports",
  evidence: "evidenced-by · supersedes-fact",
  execution: "depends-on",
  assoc: "relates · implements",
};

/** 关系类型 → 语义轴。 */
export const KIND_AXIS: Record<RelationKind, SemanticAxis> = {
  refines: "authority",
  narrows: "authority",
  supersedes: "authority",
  derives: "authority",
  supports: "authority",
  "evidenced-by": "evidence",
  "supersedes-fact": "evidence",
  "depends-on": "execution",
  relates: "assoc",
  implements: "assoc",
  blocks: "execution",
  produces: "execution",
  evidences: "evidence",
  "refuted-by": "evidence",
  "invalidated-by": "evidence",
};

export function axisForKind(kind: RelationKind): SemanticAxis {
  return KIND_AXIS[kind] ?? "assoc";
}

/** 每轴一个 CSS 颜色变量;亮 / 暗主题都能区分。 */
export const AXIS_COLOR_VAR: Record<SemanticAxis, string> = {
  authority: "var(--color-axis-authority)",
  evidence: "var(--color-axis-evidence)",
  execution: "var(--color-axis-execution)",
  assoc: "var(--color-axis-assoc)",
};

/** Claim 兑现三形态配色(coverageRows.fulfillment;移植老版 GraphLegend 词表)。 */
export const FULFILLMENT_COLOR_VAR = {
  evidenced: "var(--color-status-done)",
  delivered: "var(--color-axis-execution)",
  "standing-policy": "var(--color-accent)",
  unknown: "var(--color-text-faint)",
} as const;

export const FULFILLMENT_LABEL: Record<keyof typeof FULFILLMENT_COLOR_VAR, string> = {
  evidenced: "已佐证",
  delivered: "已交付",
  "standing-policy": "常设政策",
  unknown: "未投影",
};

export const KIND_LABEL: Record<RelationKind, string> = {
  supports: "支撑",
  supersedes: "推翻",
  refines: "细化",
  narrows: "收窄",
  derives: "派生",
  blocks: "阻塞",
  relates: "关联",
  implements: "实现",
  "depends-on": "依赖",
  produces: "产出",
  evidences: "证明",
  "evidenced-by": "证据",
  "refuted-by": "反驳",
  "invalidated-by": "失效于",
  "supersedes-fact": "取代事实",
};

export const KIND_LABEL_IN: Record<string, string> = {
  supports: "支撑→",
  supersedes: "被推翻",
  refines: "被细化",
  narrows: "被收窄",
  derives: "派生→",
  blocks: "被阻塞",
  relates: "关联",
  implements: "被实现",
  "depends-on": "被依赖",
  produces: "由…产出",
  evidences: "被证明",
  "evidenced-by": "证据来自",
  "refuted-by": "反驳来自",
  "invalidated-by": "令…失效",
  "supersedes-fact": "事实被取代",
};
