import type { CanonicalStatus, RelationKind } from "../../model/types";

export const STEP_FLOW: CanonicalStatus[] =
  /* @gate-identity check-gui-status-judgments/gui-status-016 */
  ["planned", "active", "in_review", "done"];

export const OUT_LABEL: Record<RelationKind, string> = {
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
  executes: "执行",
  reviews: "审查",
  owns: "拥有",
  dispatches: "派发",
  authorizes: "授权",
};

export const IN_LABEL: Record<RelationKind, string> = {
  supports: "支撑→",
  supersedes: "被推翻",
  refines: "被细化",
  narrows: "被收窄",
  derives: "派生自",
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
  executes: "执行→",
  reviews: "被审查",
  owns: "归属",
  dispatches: "被派发",
  authorizes: "获授权",
};
