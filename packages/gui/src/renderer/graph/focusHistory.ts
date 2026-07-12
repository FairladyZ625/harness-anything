/**
 * GraphView 焦点历史栈(dec_01KXA7811SVVT8P66HNDFZQ7DF — 关系图可用性补齐)。
 *
 * 纯函数 + 显式 state,刻意不挂 React,以便 vitest 直接覆盖 back/forward/push
 * 三条核心迁移。GraphView 用 useState 持有 FocusHistoryState,变更走这里的函数。
 *
 * 设计:
 *   - history 只收「主动切换焦点」的足迹:双击节点 / FocusSwitcher 点选 / 抽屉
 *     「设为焦点」按钮 / focusRef 跨视图带入。布局器自己挑的默认焦点不进栈,
 *     用户「退出聚焦」(关抽屉/点空白) 也不进栈 —— 这些都不算用户「跳到过」。
 *   - push 截断 forward 栈(经典浏览器语义):从历史中间换新焦点后,旧 future 作废。
 *   - 重复连推同 id 视为 no-op,避免点 Switcher 同一项把栈灌满。
 */

export interface FocusHistoryState {
  /** 完整足迹;back 从 [0,index-1] 取,forward 从 [index+1]。 */
  entries: string[];
  /** 当前焦点在 entries 中的下标;-1 表示当前不在历史里(默认焦点 / 退出聚焦)。 */
  index: number;
}

export function createFocusHistory(): FocusHistoryState {
  return { entries: [], index: -1 };
}

/** 当前落在历史里的焦点 id;若 index=-1 返回 null(不代表「无焦点」,只代表「不在栈里」)。 */
export function currentFocus(state: FocusHistoryState): string | null {
  return state.index >= 0 && state.index < state.entries.length
    ? state.entries[state.index]
    : null;
}

export function canGoBack(state: FocusHistoryState): boolean {
  return state.index > 0;
}

export function canGoForward(state: FocusHistoryState): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

/**
 * 推一个新焦点。重复推同 id 不变(防误灌栈)。截断 forward 栈:
 * 从历史中间换焦点后,旧 future 作废。
 */
export function pushFocus(
  state: FocusHistoryState,
  id: string,
): FocusHistoryState {
  if (currentFocus(state) === id) return state;
  const nextIndex = state.index + 1;
  const truncated = state.entries.slice(0, nextIndex);
  truncated.push(id);
  return { entries: truncated, index: nextIndex };
}

export function goBack(state: FocusHistoryState): FocusHistoryState {
  if (!canGoBack(state)) return state;
  return { ...state, index: state.index - 1 };
}

export function goForward(state: FocusHistoryState): FocusHistoryState {
  if (!canGoForward(state)) return state;
  return { ...state, index: state.index + 1 };
}
