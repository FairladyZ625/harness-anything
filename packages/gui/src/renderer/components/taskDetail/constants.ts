import type { CanonicalStatus, RelationKind } from "../../model/types";

export const LOCAL_TRANSITIONS: CanonicalStatus[] = [
  "planned",
  "active",
  "blocked",
  "in_review",
  "done",
  "cancelled",
];

export const STEP_FLOW: CanonicalStatus[] = ["planned", "active", "in_review", "done"];

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
  refutes: "反证",
  "invalidated-by": "失效于",
  "supersedes-fact": "取代事实",
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
  refutes: "被反证",
  "invalidated-by": "令…失效",
  "supersedes-fact": "事实被取代",
};
