import type { RelationKind } from "../model/types";

// 图节点尺寸
export const NODE_W = 150;
export const NODE_H = 44;
export const GAP_X = 90;
export const GAP_Y = 24;
export const PAD = 24;
// 三元语泳道间距：decision 顶部 / task 中部 / fact 底部
export const SWIM_GAP = 70;

export const KIND_LABEL: Record<RelationKind, string> = {
  depends_on: "依赖",
  parent_of: "父子",
  references: "引用",
  supports: "支撑",
  supersedes: "推翻",
  derives: "派生",
  blocks: "阻塞",
  relates: "关联",
  invalidated_by: "失效于",
  supersedes_fact: "取代事实",
  observes: "observes",
};

export const KIND_LABEL_IN: Record<string, string> = {
  depends_on: "被依赖",
  parent_of: "子任务",
  references: "被引用",
  supports: "支撑→",
  supersedes: "被推翻",
  derives: "派生→",
  blocks: "被阻塞",
  relates: "关联",
  invalidated_by: "令…失效",
  supersedes_fact: "事实被取代",
};
