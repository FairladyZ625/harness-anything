/**
 * GraphView 焦点历史栈(dec_01KXA7811SVVT8P66HNDFZQ7DF — 关系图可用性补齐)。
 *
 * 迁移逻辑(back/forward/前向截断)住在 navigation/historyStack.ts,这里只提供
 * 「条目 = 实体 id」这一种特化。纯函数 + 显式 state,刻意不挂 React,以便 vitest
 * 直接覆盖三条核心迁移。
 *
 * 设计:
 *   - history 只收「主动切换焦点」的足迹:双击节点 / FocusSwitcher 点选 / 抽屉
 *     「设为焦点」按钮 / focusRef 跨视图带入。布局器自己挑的默认焦点不进栈,
 *     用户「退出聚焦」(关抽屉/点空白) 也不进栈 —— 这些都不算用户「跳到过」。
 *   - index=-1 表示当前焦点不在栈里(默认焦点 / 退出聚焦)。
 */

import {
  canGoBack,
  canGoForward,
  current,
  goBack,
  goForward,
  push,
  type HistoryState,
} from "../navigation/historyStack.ts";

export type FocusHistoryState = HistoryState<string>;

export { canGoBack, canGoForward, goBack, goForward };

export function createFocusHistory(): FocusHistoryState {
  return { entries: [], index: -1 };
}

/** 当前落在历史里的焦点 id;若 index=-1 返回 null(不代表「无焦点」,只代表「不在栈里」)。 */
export function currentFocus(state: FocusHistoryState): string | null {
  return current(state);
}

/** 推一个新焦点。重复推同 id 不变(防误灌栈);截断 forward 栈。 */
export function pushFocus(state: FocusHistoryState, id: string): FocusHistoryState {
  return push(state, id, sameFocus);
}

function sameFocus(left: string, right: string): boolean {
  return left === right;
}
