/** Token 数量的统一展示格式(原 SquadRunDetail 局部助手,Token 消耗页与会话面板共用)。 */

/** 可见面用紧凑记数(1.3M/210K);固定 en-US 保证两种界面语言下数字形态稳定。 */
export const compactTokens = (value: number): string =>
  new Intl.NumberFormat("en-US", { notation: "compact" }).format(value);

/** 精确值进 title / KV 行,千分位分隔。 */
export const exactTokens = (value: number): string => new Intl.NumberFormat("en-US").format(value);
