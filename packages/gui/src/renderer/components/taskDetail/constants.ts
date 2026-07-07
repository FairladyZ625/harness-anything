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
  depends_on: "依赖",
  parent_of: "父任务 of",
  references: "引用",
  supports: "支撑",
  supersedes: "推翻",
  derives: "派生",
  blocks: "阻塞",
  relates: "关联",
  invalidated_by: "失效于",
  supersedes_fact: "取代事实",
  observes: "观察",
};

export const IN_LABEL: Record<RelationKind, string> = {
  depends_on: "被依赖",
  parent_of: "子任务",
  references: "被引用",
  supports: "支撑→",
  supersedes: "被推翻",
  derives: "派生自",
  blocks: "被阻塞",
  relates: "关联",
  invalidated_by: "令…失效",
  supersedes_fact: "事实被取代",
  observes: "被观察",
};
