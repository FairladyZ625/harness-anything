import { dayKeyOf, formatDayKeyLabel, formatTime } from "./model/time.ts";
import type {
  AgentRuntimeTokenUsageMemberIdentity,
  AgentRuntimeTokenUsageOutcome,
  AgentRuntimeTokenUsageRange,
} from "@harness-anything/daemon/protocol";
import type { MessageKey } from "./i18n/index.tsx";

/** Token 消耗页的共享前端模型:范围/成员引用的编解码、排行指标与桶标签。数据形状全部来自
 * daemon 读模型(renderer 不自行聚合),这里只放纯展示投影。 */

export type TokenUsageRange = AgentRuntimeTokenUsageRange;
export const tokenUsageRanges: readonly TokenUsageRange[] = ["today", "7d", "30d"];
export const tokenUsageRangeKey: Readonly<Record<TokenUsageRange, MessageKey>> = {
  today: "agentRuntime.tokenUsageRangeToday",
  "7d": "agentRuntime.tokenUsageRange7d",
  "30d": "agentRuntime.tokenUsageRange30d",
};

/** 环比的参照周期怎么称呼:与 daemon 的 `previous` 同一段(往前一个窗口、截到同一时刻)。 */
export const tokenUsagePreviousKey: Readonly<Record<TokenUsageRange, MessageKey>> = {
  today: "agentRuntime.tokenUsagePreviousToday",
  "7d": "agentRuntime.tokenUsagePrevious7d",
  "30d": "agentRuntime.tokenUsagePrevious30d",
};

/** 成员详情的可寻址引用(推栈/回撤与列表页同一条路):`tokenAgent/<id>` | `tokenSquad/<id>`。 */
export function tokenUsageMemberRef(member: AgentRuntimeTokenUsageMemberIdentity): string {
  return member.kind === "agent" ? `tokenAgent/${member.agentId}` : `tokenSquad/${member.squadId}`;
}
export function tokenUsageMemberFromRef(ref: string | null | undefined): AgentRuntimeTokenUsageMemberIdentity | null {
  if (ref === null || ref === undefined) return null;
  const [prefix, id, ...rest] = ref.split("/");
  if (rest.length > 0 || !id) return null;
  if (prefix === "tokenAgent") return { kind: "agent", agentId: id };
  if (prefix === "tokenSquad") return { kind: "squad", squadId: id };
  return null;
}

/** 趋势桶的时间轴标签:小时桶标时刻,日桶标月-日(与 daemon 本地日切桶一致,按所选时区/格式)。 */
export function bucketAxisLabel(bucketStart: string, bucketMs: number): string {
  if (bucketMs === 3_600_000) return formatTime(bucketStart, { style: "time" }) ?? bucketStart;
  const key = dayKeyOf(bucketStart);
  return key === null ? bucketStart : formatDayKeyLabel(key);
}

/** 行级「未上报」判定:一个也没有上报过、但存在已结算未上报派工 → 显示「未上报」而非 0。 */
export function usageIsUnreported(row: {
  readonly usageReportedDispatches: number;
  readonly usageUnavailableDispatches: number;
}): boolean {
  return row.usageReportedDispatches === 0 && row.usageUnavailableDispatches > 0;
}

/** 行级「无价格」判定:有用量但一行也没有公开价可折算 → 显示「无价格」,金额不是 0 的意思。 */
export function usageIsUnpriced(row: { readonly totalTokens: number; readonly unpricedTokens: number }): boolean {
  return row.totalTokens > 0 && row.unpricedTokens >= row.totalTokens;
}

/** 未计价用量占总量的比例;总量为 0 时没有这个数。 */
export function unpricedShare(totals: {
  readonly totalTokens: number;
  readonly unpricedTokens: number;
}): number | null {
  return totals.totalTokens > 0 ? Math.min(1, totals.unpricedTokens / totals.totalTokens) : null;
}

/** 会话行的 usage 词 → 展示词键(与 SessionsPanel 的 sessionMetricsUnavailable 同一语义)。 */
export function usageStateKey(usage: "reported" | "unavailable" | "pending"): MessageKey {
  return usage === "unavailable"
    ? "agentRuntime.sessionMetricsUnavailable"
    : usage === "pending"
      ? "agentRuntime.tokenUsageUsagePending"
      : "agentRuntime.tokenUsageUsageReported";
}

export const usageOutcomeKey: Readonly<Record<AgentRuntimeTokenUsageOutcome, MessageKey>> = {
  succeeded: "agentRuntime.sessionStatusSucceeded",
  failed: "agentRuntime.sessionStatusFailed",
  aborted: "agentRuntime.tokenUsageOutcomeAborted",
  running: "agentRuntime.sessionStatusRunning",
  unknown: "agentRuntime.sessionStatusUnknown",
};
/** 结果 → 状态色 token(标准 §3):成功绿、失败红、中止暗灰、在跑青、未知中性。 */
export const usageOutcomeColor: Readonly<Record<AgentRuntimeTokenUsageOutcome, string>> = {
  succeeded: "var(--color-status-done)",
  failed: "var(--color-status-blocked)",
  aborted: "var(--color-status-cancelled)",
  running: "var(--color-status-active)",
  unknown: "var(--color-status-planned)",
};

/** 「白花」的部分:以失败或中止收场的会话花掉的 token。 */
export function wastedSpend(
  outcomes: readonly {
    readonly outcome: AgentRuntimeTokenUsageOutcome;
    readonly sessionCount: number;
    readonly totalTokens: number;
  }[],
): { readonly sessionCount: number; readonly totalTokens: number } {
  const wasted = outcomes.filter(({ outcome }) => outcome === "failed" || outcome === "aborted");
  return {
    sessionCount: wasted.reduce((sum, row) => sum + row.sessionCount, 0),
    totalTokens: wasted.reduce((sum, row) => sum + row.totalTokens, 0),
  };
}

/**
 * 四类 token 的全页唯一配色与顺序。daemon 的 inputTokens 含缓存读取与缓存写入
 * (totalTokens = 输入 + 输出),所以构成拆成互不重叠的四段:缓存读取、缓存写入、未命中
 * 缓存的新输入、输出 —— 四段之和等于总量。缓存写入自价格表 2026-10-10 起独立计数;
 * 更早记录与未上报缓存写入的 provider 里,该部分留在新输入段(按 0 计),不估算。
 */
export const tokenKinds = ["cacheRead", "cacheWrite", "freshInput", "output"] as const;
export type TokenKind = (typeof tokenKinds)[number];
export const tokenKindColor: Readonly<Record<TokenKind, string>> = {
  cacheRead: "var(--color-viz-cache)",
  cacheWrite: "var(--color-viz-cache-write)",
  freshInput: "var(--color-viz-input)",
  output: "var(--color-viz-output)",
};
export const tokenKindKey: Readonly<Record<TokenKind, MessageKey>> = {
  cacheRead: "agentRuntime.tokenUsageColCacheRead",
  cacheWrite: "agentRuntime.tokenUsageKindCacheWrite",
  freshInput: "agentRuntime.tokenUsageKindFreshInput",
  output: "agentRuntime.tokenUsageColOutput",
};
export function tokenComposition(counters: {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
}): Readonly<Record<TokenKind, number>> {
  const cacheRead = Math.max(0, Math.min(counters.cacheReadTokens, counters.inputTokens)),
    cacheWrite = Math.max(0, Math.min(counters.cacheWriteTokens, counters.inputTokens - cacheRead));
  return {
    cacheRead,
    cacheWrite,
    freshInput: counters.inputTokens - cacheRead - cacheWrite,
    output: counters.outputTokens,
  };
}
/** 缓存命中率:缓存读取占输入的比例;没有输入时没有这个数。 */
export function cacheHitRate(counters: {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
}): number | null {
  return counters.inputTokens > 0
    ? Math.max(0, Math.min(counters.cacheReadTokens, counters.inputTokens)) / counters.inputTokens
    : null;
}

/** 分系列(按 agent / 按模型)的定序配色:颜色跟着系列在读面里的位次走,「其余」固定为灰。 */
// token 名必须整段写出:样式构建只保留源码里出现过全名的主题变量。
const seriesColors = [
  "var(--color-viz-series-1)",
  "var(--color-viz-series-2)",
  "var(--color-viz-series-3)",
  "var(--color-viz-series-4)",
  "var(--color-viz-series-5)",
];
export function seriesColor(key: string | null, index: number): string {
  return key === null ? "var(--color-viz-rest)" : (seriesColors[index] ?? "var(--color-viz-rest)");
}

/** 环比:相对上一个同长周期的变化率;上一周期为 0 时没有可比基数。 */
export function periodChange(current: number, previous: number): number | null {
  return previous > 0 ? (current - previous) / previous : null;
}

/** 纵轴上限与刻度:取 1/2/5×10ⁿ 的整步长,保证最高柱不超出最上一条刻度线。 */
export function axisScale(peak: number, steps = 4): { readonly max: number; readonly ticks: readonly number[] } {
  if (peak <= 0) return { max: 1, ticks: [0] };
  const rough = peak / steps,
    magnitude = 10 ** Math.floor(Math.log10(rough)),
    step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? rough,
    count = Math.ceil(peak / step);
  return { max: step * count, ticks: Array.from({ length: count + 1 }, (_, index) => index * step) };
}

/**
 * 排行条长的刻度。线性:条长即占比。对数:量级悬殊时(最大是最小的上百倍)小的也看得出
 * 差别 —— 条长只表示量级,数值与占比在右侧并排给出。`floor` 是对数轴的起点(最小非零值的
 * 下一个整十倍),0 没有条。
 */
export type RankScale = "log" | "linear";
export function rankBarShare(value: number, peak: number, floor: number, scale: RankScale): number {
  if (value <= 0 || peak <= 0) return 0;
  if (scale === "linear" || peak <= floor) return value / peak;
  return Math.max(0, Math.log10(value / floor) / Math.log10(peak / floor));
}
export function rankLogFloor(values: readonly number[]): number {
  const smallest = Math.min(...values.filter((value) => value > 0));
  return Number.isFinite(smallest) ? 10 ** Math.floor(Math.log10(smallest)) / 10 : 1;
}
/** 最大值是最小非零值的 100 倍以上:线性条会把小的全压成一根线,默认用对数。 */
export function rankScaleFor(values: readonly number[]): RankScale {
  const positive = values.filter((value) => value > 0);
  return positive.length > 1 && Math.max(...positive) / Math.min(...positive) >= 100 ? "log" : "linear";
}

/** 会话成功率:成功 /(成功 + 失败 + 中止);还没有会话结束时没有这个数。 */
export function successRate(row: {
  readonly succeededSessions: number;
  readonly failedSessions: number;
  readonly abortedSessions: number;
}): number | null {
  const ended = row.succeededSessions + row.failedSessions + row.abortedSessions;
  return ended > 0 ? row.succeededSessions / ended : null;
}
/** 单位产出:每换来一个成功会话,这一行总共花了多少 token(失败与中止的花费也摊进来)。 */
export function tokensPerSuccess(row: {
  readonly totalTokens: number;
  readonly succeededSessions: number;
}): number | null {
  return row.succeededSessions > 0 ? Math.round(row.totalTokens / row.succeededSessions) : null;
}

/** 会话规模档的标签:`<10K`、`10K–100K`、…、`≥100M`。 */
export function sessionBinLabel(ceiling: number | null, floor: number, compact: (value: number) => string): string {
  if (ceiling === null) return `≥${compact(floor)}`;
  return floor === 0 ? `<${compact(ceiling)}` : `${compact(floor)}–${compact(ceiling)}`;
}
