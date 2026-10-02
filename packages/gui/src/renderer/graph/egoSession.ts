import type { EgoHopBudget } from "./egoCanvas";
import { egoFocusIdOf } from "./egoCanvas";

/**
 * 聚光灯探索会话(task_baca8e2b3e32c288fbd14b71f0):详情页往返之间的图状态锚点。
 *
 * GraphView/EgoNeighborhood 随路由卸载,组件态(focusId/shown/expanded/viewport/hops)
 * 一起消失;「详情 → 返回,焦点/邻居/viewport 保持」的验收要求一个比组件活得久的落点。
 * 本模块是渲染进程内的单槽会话(模块级变量,不进 localStorage —— 刷新即新会话,
 * 与既有 graph-territory/graph-density 的持久偏好不同类,不做跨会话恢复)。
 *
 * 归属主图导航上下文:GraphView 显式启用 rememberSession,其 useEgoCanvas 写
 * 焦点/铺开/展开、EgoNeighborhood 写中心/viewport、GraphView 写 hops。
 * 详情页与工作页的嵌入邻域不接入此槽,它们的探索态只随组件存活。
 * 归属键是仓 + 焦点引用(CEO 返修 2026-10-02):ref 只在仓内唯一,两个项目可以有
 * 完全相同的 `task/...`/`decision/...`,因此跨项目绝不互读 —— 换仓的写入把槽重置为
 * 新仓的全新会话(单槽只保留当前仓的探索,不引入按仓缓存);同仓内换焦点同样重置
 * (旧焦点的铺开/展开不跨焦点串场)。读方 readEgoSessionFor 只在仓与焦点都吻合时
 * 给回条目,任一不同 = 新探索,不给陈旧恢复。
 */

export interface EgoSessionEntry {
  /** 会话归属的仓(App 的 activeRepoId;同名实体跨仓是支持用法,不是低频豁免)。 */
  repoId: string;
  /** 会话归属的焦点(canonical ego 键空间,即 egoFocusIdOf 的输出)。 */
  focusRef: string;
  /** 跳数预算(GraphView 的步进器态)。 */
  hops?: EgoHopBudget;
  /** 累积可见集:id → 距焦点跳数。 */
  shown?: ReadonlyArray<[string, number]>;
  /** 原位展开的卡片 id。 */
  expanded?: ReadonlyArray<string>;
  /** 用户最后的平移/缩放。 */
  viewport?: { x: number; y: number; zoom: number };
  /** 本次探索已摆放的节点中心;详情往返不根据展开态重新分列。 */
  centers?: ReadonlyArray<[string, { x: number; y: number }]>;
}

let entry: EgoSessionEntry | null = null;

/**
 * 合并写入(部分写:viewport/hops 微调可不带 focusRef)。仓或焦点变化的写入重置
 * 整个槽(换仓 = 新项目的新探索,旧仓的会话不保留;换焦点 = 新探索,旧焦点的
 * 铺开/展开不串场);两者都未变的写入并入当前会话。
 */
export function mergeEgoSession(repoId: string, partial: Partial<EgoSessionEntry>): void {
  if (entry !== null && repoId !== entry.repoId) {
    entry = null;
  }
  if (entry !== null && partial.focusRef !== undefined && partial.focusRef !== entry.focusRef) {
    entry = { repoId, focusRef: partial.focusRef };
  }
  const focusRef = partial.focusRef ?? entry?.focusRef ?? "";
  entry = { ...(entry ?? { repoId, focusRef }), ...partial, repoId, focusRef };
}

/** 只在会话仓与焦点都和传入的一致时返回条目;任一不一致(或无会话)返回 null。 */
export function readEgoSessionFor(repoId: string, focusRef: string | null): EgoSessionEntry | null {
  if (!repoId || !focusRef || !entry) return null;
  if (entry.repoId !== repoId || entry.focusRef !== egoFocusIdOf(focusRef)) return null;
  return entry;
}

export function clearEgoSession(): void {
  entry = null;
}
