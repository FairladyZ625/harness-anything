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
 * 写方:useEgoCanvas(焦点/铺开/展开)、EgoNeighborhood(viewport)、GraphView(hops)。
 * 归属键是焦点引用:换焦点后的写入把槽重置为新焦点的全新会话;读方
 * readEgoSessionFor 只在焦点吻合时给回条目,焦点不同 = 新探索,不给陈旧恢复。
 */

export interface EgoSessionEntry {
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
}

let entry: EgoSessionEntry | null = null;

/**
 * 合并写入(部分写:viewport/hops 微调可不带 focusRef)。带 focusRef 的写入在焦点
 * 变化时重置整个槽(旧焦点的铺开/展开不跨焦点串场);不带 focusRef 的写入并入当前会话。
 */
export function mergeEgoSession(partial: Partial<EgoSessionEntry>): void {
  if (entry !== null && partial.focusRef !== undefined && partial.focusRef !== entry.focusRef) {
    entry = { ...partial, focusRef: partial.focusRef };
    return;
  }
  const focusRef = partial.focusRef ?? entry?.focusRef ?? "";
  entry = { ...(entry ?? { focusRef }), ...partial, focusRef };
}

export function readEgoSession(): EgoSessionEntry | null {
  return entry;
}

/** 只在会话焦点与传入焦点一致时返回条目;不一致(或无会话)返回 null。 */
export function readEgoSessionFor(focusRef: string | null): EgoSessionEntry | null {
  if (!focusRef || !entry || entry.focusRef !== egoFocusIdOf(focusRef)) return null;
  return entry;
}

export function clearEgoSession(): void {
  entry = null;
}
