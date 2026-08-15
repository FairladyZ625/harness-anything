/** 最近访问列表上限(与 archive 线 FocusSwitcher 的 RECENT_MAX 一致)。 */
export const RECENT_LIMIT = 12;

/**
 * 把 navRef 推到最近访问头部:去重 + 截 RECENT_LIMIT。
 * 纯函数(不引入新状态源);调用方持有 state,索引外的 ref 在渲染侧反解时过滤。
 */
export function pushRecentRef(prev: ReadonlyArray<string>, ref: string): string[] {
  return [ref, ...prev.filter((candidate) => candidate !== ref)].slice(0, RECENT_LIMIT);
}
