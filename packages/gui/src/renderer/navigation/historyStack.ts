/**
 * 前向截断历史栈的泛型核心(经典浏览器语义)。
 *
 * 图内焦点历史(graph/focusHistory.ts,条目=实体 id)与应用位置历史
 * (navigation/navigationHistory.ts,条目=AppLocation)只在两处不同:条目类型,
 * 以及"两个条目算不算同一个"的判据。除此之外 back/forward/截断的迁移完全一致 ——
 * 所以这里只存在一份实现,两边各自提供条目类型与相等性,不各写一遍。
 *
 * index = -1 表示"当前不在栈里"(图内的默认焦点 / 退出聚焦属于这种情况);
 * 应用位置历史从 index=0 播种,永远落在栈里。
 */

export interface HistoryState<T> {
  /** 完整足迹;back 从 [0,index-1] 取,forward 从 [index+1]。 */
  entries: T[];
  /** 当前条目在 entries 中的下标;-1 表示当前不在历史里。 */
  index: number;
}

/** 当前落在历史里的条目;index=-1 时返回 null(不代表"没有条目",只代表"不在栈里")。 */
export function current<T>(state: HistoryState<T>): T | null {
  return state.index >= 0 && state.index < state.entries.length
    ? state.entries[state.index]
    : null;
}

export function canGoBack<T>(state: HistoryState<T>): boolean {
  return state.index > 0;
}

export function canGoForward<T>(state: HistoryState<T>): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

/**
 * 推一个新条目。与当前条目等价则 no-op(防误灌栈)。截断 forward 栈:
 * 从历史中间推新条目后,旧 future 作废。
 */
export function push<T>(
  state: HistoryState<T>,
  entry: T,
  equals: (a: T, b: T) => boolean,
): HistoryState<T> {
  const head = current(state);
  if (head !== null && equals(head, entry)) return state;
  const nextIndex = state.index + 1;
  const truncated = state.entries.slice(0, nextIndex);
  truncated.push(entry);
  return { entries: truncated, index: nextIndex };
}

/**
 * 原地更新当前条目(不推栈,不截断 forward)。用于非导航性的微调 ——
 * 用户"调了一下筛选"不该单独占一个历史条目,但下次导航的快照里应带上最新值。
 */
export function patch<T>(
  state: HistoryState<T>,
  entry: T,
  equals: (a: T, b: T) => boolean,
): HistoryState<T> {
  const head = current(state);
  if (head === null || equals(head, entry)) return state;
  const entries = state.entries.slice();
  entries[state.index] = entry;
  return { entries, index: state.index };
}

export function goBack<T>(state: HistoryState<T>): HistoryState<T> {
  if (!canGoBack(state)) return state;
  return { ...state, index: state.index - 1 };
}

export function goForward<T>(state: HistoryState<T>): HistoryState<T> {
  if (!canGoForward(state)) return state;
  return { ...state, index: state.index + 1 };
}
