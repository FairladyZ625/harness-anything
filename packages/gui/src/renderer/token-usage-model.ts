import type {
  AgentRuntimeTokenUsageBucket,
  AgentRuntimeTokenUsageMemberIdentity,
  AgentRuntimeTokenUsageRange,
} from "../../../daemon/src/agent-runtime-token-usage.ts";
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

/** 排行柱状图可切的指标:每个都回答「谁花得多」的一个具体侧面。 */
export type RankingMetric = "totalTokens" | "outputTokens" | "toolCallCount" | "sessionCount";
export const rankingMetrics: readonly RankingMetric[] = [
  "totalTokens",
  "outputTokens",
  "toolCallCount",
  "sessionCount",
];
export const rankingMetricKey: Readonly<Record<RankingMetric, MessageKey>> = {
  totalTokens: "agentRuntime.tokenUsageMetricTotal",
  outputTokens: "agentRuntime.tokenUsageMetricOutput",
  toolCallCount: "agentRuntime.tokenUsageMetricTools",
  sessionCount: "agentRuntime.tokenUsageMetricSessions",
};
export const rankingMetricOf = (
  row: {
    readonly totalTokens: number;
    readonly outputTokens: number;
    readonly toolCallCount: number;
    readonly sessionCount: number;
  },
  metric: RankingMetric,
): number => row[metric];

/** 趋势桶的时间轴标签:小时桶标 HH:00,日桶标 MM-DD(与 daemon 本地日切桶一致)。 */
export function bucketAxisLabel(bucketStart: string, bucketMs: number): string {
  const at = new Date(bucketStart);
  return bucketMs === 3_600_000
    ? `${String(at.getHours()).padStart(2, "0")}:00`
    : `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** 行级「未上报」判定:一个也没有上报过、但存在已结算未上报派工 → 显示「未上报」而非 0。 */
export function usageIsUnreported(row: {
  readonly usageReportedDispatches: number;
  readonly usageUnavailableDispatches: number;
}): boolean {
  return row.usageReportedDispatches === 0 && row.usageUnavailableDispatches > 0;
}

/** 会话行的 usage 词 → 展示词键(与 SessionsPanel 的 sessionMetricsUnavailable 同一语义)。 */
export function usageStateKey(usage: "reported" | "unavailable" | "pending"): MessageKey {
  return usage === "unavailable"
    ? "agentRuntime.sessionMetricsUnavailable"
    : usage === "pending"
      ? "agentRuntime.tokenUsageUsagePending"
      : "agentRuntime.tokenUsageUsageReported";
}

export function bucketTotal(bucket: AgentRuntimeTokenUsageBucket): number {
  return bucket.totalTokens;
}
