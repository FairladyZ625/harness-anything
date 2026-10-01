/** Token 数量的统一展示格式(原 SquadRunDetail 局部助手,Token 消耗页与会话面板共用)。 */

/** 可见面用紧凑记数(1.3M/210K);固定 en-US 保证两种界面语言下数字形态稳定。 */
export const compactTokens = (value: number): string =>
  new Intl.NumberFormat("en-US", { notation: "compact" }).format(value);

/** 分析页的数字多保留一位有效数字(1.96B 而不是 2B):构成与占比要对得上,不能被进位吃掉。 */
export const preciseTokens = (value: number): string =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 }).format(value);

/** 精确值进 title / KV 行,千分位分隔。 */
export const exactTokens = (value: number): string => new Intl.NumberFormat("en-US").format(value);

/** 占比:不足 0.1% 的非零值写成 <0.1%,不四舍五入成 0%(小不等于没有)。 */
export function percentText(ratio: number): string {
  if (ratio > 0 && ratio < 0.001) return "<0.1%";
  const percent = ratio * 100;
  return `${percent >= 10 || Number.isInteger(percent) ? Math.round(percent) : percent.toFixed(1)}%`;
}
