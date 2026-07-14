import type { RelationKind } from "../model/types";
import { t } from "../i18n/core.ts";

// 图节点尺寸
export const NODE_W = 150;
export const NODE_H = 44;
export const GAP_X = 90;
export const GAP_Y = 24;
export const PAD = 24;
// 三元语泳道间距：decision 顶部 / task 中部 / fact 底部
export const SWIM_GAP = 70;

/**
 * 语义轴（decision dec_01KXA7811SVVT8P66HNDFZQ7DF CH4 + 原型 .harness/generated/triadic-graph）。
 * 关系类型按语义归并为四轴,每轴一种视觉 + 可独立开关,relates 默认关。
 *   authority  权威  — decision 谱系 / 派生 (refines/narrows/supersedes/derives/supports)
 *   evidence   证据  — fact 佐证 (evidenced-by/supersedes-fact)
 *   execution  执行  — task 协作 (depends-on)
 *   assoc      关联  — 松关联 (relates/implements)
 * axisForKind 的归类与原型 index.html 的 axis 字段对齐 (decision 派生也走 authority)。
 */
export type SemanticAxis = "authority" | "evidence" | "execution" | "assoc";

export const AXIS_ORDER: ReadonlyArray<SemanticAxis> = ["authority", "evidence", "execution", "assoc"];

export const AXIS_LABEL: Record<SemanticAxis, string> = {
  get authority() { return t("graph.constants.authority"); },
  get evidence() { return t("graph.constants.evidence"); },
  get execution() { return t("graph.constants.execute"); },
  get assoc() { return t("graph.constants.association"); },
};

export const AXIS_SUBLABEL: Record<SemanticAxis, string> = {
  authority: "refines · supersedes · derives · supports",
  evidence: "evidenced-by · supersedes-fact",
  execution: "depends-on",
  assoc: "relates · implements",
};

/** 关系类型 → 语义轴。和 .harness/generated/triadic-graph/index.html 的归类一一对齐。 */
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
  // 以下类型在 triadic 投影里极少出现或归入相邻轴,保持显式归类避免 fallthrough。
  blocks: "execution",
  produces: "execution",
  evidences: "evidence",
  refutes: "evidence",
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

/** coverage 灯配色:covered 绿 / uncovered 红 / 未知灰。 */
export const COVERAGE_COLOR_VAR = {
  covered: "var(--color-status-done)",
  uncovered: "var(--color-danger)",
  unknown: "var(--color-text-faint)",
} as const;

export const KIND_LABEL: Record<RelationKind, string> = {
  get supports() { return t("graph.constants.support"); },
  get supersedes() { return t("graph.constants.overthrow"); },
  get refines() { return t("graph.constants.refine"); },
  get narrows() { return t("graph.constants.narrow"); },
  get derives() { return t("graph.constants.derived"); },
  get blocks() { return t("graph.constants.blocking"); },
  get relates() { return t("graph.constants.association"); },
  get implements() { return t("graph.constants.realize"); },
  get "depends-on"() { return t("graph.constants.depend"); },
  get produces() { return t("graph.constants.output"); },
  get evidences() { return t("graph.constants.prove"); },
  get "evidenced-by"() { return t("graph.constants.evidence"); },
  get refutes() { return t("graph.constants.counterevidence"); },
  get "invalidated-by"() { return t("graph.constants.invalid"); },
  get "supersedes-fact"() { return t("graph.constants.replaceFacts"); },
};

export const KIND_LABEL_IN: Record<string, string> = {
  get supports() { return t("graph.constants.support2"); },
  get supersedes() { return t("graph.constants.overturned"); },
  get refines() { return t("graph.constants.refined"); },
  get narrows() { return t("graph.constants.narrowed"); },
  get derives() { return t("graph.constants.derive"); },
  get blocks() { return t("graph.constants.blocked"); },
  get relates() { return t("graph.constants.association"); },
  get implements() { return t("graph.constants.realized"); },
  get "depends-on"() { return t("graph.constants.depended"); },
  get produces() { return t("graph.constants.producedBy"); },
  get evidences() { return t("graph.constants.proven"); },
  get "evidenced-by"() { return t("graph.constants.evidenceComesFrom"); },
  get refutes() { return t("graph.constants.disproved"); },
  get "invalidated-by"() { return t("graph.constants.invalidate"); },
  get "supersedes-fact"() { return t("graph.constants.factsReplaced"); },
};
