import type { AgentRuntimeTokenUsageAgentRow, AgentRuntimeTokenUsageSquadRow } from "@harness-anything/daemon/protocol";
import { compactTokens, exactTokens } from "../../token-format.ts";
import {
  rankingMetricOf,
  rankingMetrics,
  rankingMetricKey,
  usageIsUnreported,
  type RankingMetric,
} from "../../token-usage-model.ts";
import { t } from "../../i18n/index.tsx";
import { Badge, Empty } from "../runtime/parts.tsx";

/**
 * 成员排行(单 Worker / 小队):每行整行是 button —— 柱长(CSS 宽度比例)与数值并排,
 * 键盘可达、focus 可见;「未上报」成员不显示 0 而显示徽标。指标可四选一。
 * 同卡片可切完整表格等价视图。
 */

export type RankingRow = (AgentRuntimeTokenUsageAgentRow | AgentRuntimeTokenUsageSquadRow) & {
  readonly id: string;
  readonly name: string;
};

export function UsageRanking({
  rows,
  metric,
  onSelect,
}: {
  readonly rows: readonly RankingRow[];
  readonly metric: RankingMetric;
  readonly onSelect: (row: RankingRow) => void;
}) {
  if (rows.length === 0) return <Empty>{t("agentRuntime.tokenUsageEmpty")}</Empty>;
  const ordered = [...rows].sort(
      (left, right) =>
        rankingMetricOf(right, metric) - rankingMetricOf(left, metric) || left.id.localeCompare(right.id),
    ),
    peak = Math.max(...ordered.map((row) => rankingMetricOf(row, metric)), 1);
  return (
    <ol data-testid="token-usage-ranking" className="flex flex-col gap-0.5" aria-label={t(rankingMetricKey[metric])}>
      {ordered.map((row) => {
        const value = rankingMetricOf(row, metric),
          unreported = usageIsUnreported(row),
          ratio = value / peak;
        return (
          <li key={row.id}>
            <button
              type="button"
              data-testid={`token-usage-rank-${row.id}`}
              onClick={() => onSelect(row)}
              title={t("agentRuntime.tokenUsageOpenDetail", { name: row.name })}
              className="flex w-full items-center gap-2.5 rounded px-1.5 py-1 text-left hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              <span className="w-[150px] shrink-0 truncate ui-micro" data-tip={row.id}>
                <span className="font-[550]">{row.name}</span>
                <span className="ml-1.5 font-mono text-text-faint">{row.id}</span>
              </span>
              <span className="h-3.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-surface" aria-hidden>
                <span
                  className="block h-full rounded-sm transition-[width] duration-200 motion-reduce:transition-none"
                  style={{
                    width: `${Math.max(ratio * 100, value > 0 ? 2 : 0)}%`,
                    background: unreported ? "var(--color-status-cancelled)" : "var(--color-accent)",
                  }}
                />
              </span>
              {unreported ? (
                <Badge status="cancelled" tip={t("agentRuntime.tokenUsageUnreportedTip")}>
                  {t("agentRuntime.tokenUsageUnreported")}
                </Badge>
              ) : null}
              <span
                className="w-[64px] shrink-0 text-right font-mono ui-micro tabular-nums"
                title={metric === "sessionCount" || metric === "toolCallCount" ? String(value) : exactTokens(value)}
              >
                {metric === "sessionCount" || metric === "toolCallCount" ? value : compactTokens(value)}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** 排行的完整表格等价视图:与柱状图同一数据、同一排序,补齐全部计数列。 */
export function UsageRankingTable({
  rows,
  onSelect,
  testId,
}: {
  readonly rows: readonly RankingRow[];
  readonly onSelect: (row: RankingRow) => void;
  readonly testId: string;
}) {
  if (rows.length === 0) return <Empty>{t("agentRuntime.tokenUsageEmpty")}</Empty>;
  return (
    <table data-testid={testId} className="w-full border-separate border-spacing-0">
      <thead>
        <tr className="text-left font-mono ui-micro uppercase tracking-[0.06em] text-text-faint">
          <th className="border-b border-border pb-1 pr-3">{t("agentRuntime.tokenUsageColName")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColSessions")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColInput")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColCacheRead")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColOutput")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColTotal")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColTools")}</th>
          <th className="border-b border-border pb-1 text-right">{t("agentRuntime.tokenUsageColUsage")}</th>
        </tr>
      </thead>
      <tbody>
        {[...rows]
          .sort((left, right) => right.totalTokens - left.totalTokens || left.id.localeCompare(right.id))
          .map((row) => {
            const unreported = usageIsUnreported(row);
            return (
              <tr
                key={row.id}
                data-testid={`token-usage-row-${row.id}`}
                className="cursor-pointer hover:bg-surface-raised"
                onClick={() => onSelect(row)}
              >
                <td className="border-b border-border py-1 pr-3 ui-micro">
                  <span className="font-[550]">{row.name}</span>
                  <span className="ml-1.5 font-mono text-text-faint">{row.id}</span>
                </td>
                <td className="border-b border-border py-1 pr-3 text-right font-mono ui-micro">{row.sessionCount}</td>
                <td
                  className="border-b border-border py-1 pr-3 text-right font-mono ui-micro"
                  title={exactTokens(row.inputTokens)}
                >
                  {compactTokens(row.inputTokens)}
                </td>
                <td
                  className="border-b border-border py-1 pr-3 text-right font-mono ui-micro"
                  title={exactTokens(row.cacheReadTokens)}
                >
                  {compactTokens(row.cacheReadTokens)}
                </td>
                <td
                  className="border-b border-border py-1 pr-3 text-right font-mono ui-micro"
                  title={exactTokens(row.outputTokens)}
                >
                  {compactTokens(row.outputTokens)}
                </td>
                <td
                  className="border-b border-border py-1 pr-3 text-right font-mono ui-micro font-semibold"
                  title={exactTokens(row.totalTokens)}
                >
                  {compactTokens(row.totalTokens)}
                </td>
                <td className="border-b border-border py-1 pr-3 text-right font-mono ui-micro">{row.toolCallCount}</td>
                <td className="border-b border-border py-1 text-right">
                  {unreported ? (
                    <Badge status="cancelled" tip={t("agentRuntime.tokenUsageUnreportedTip")}>
                      {t("agentRuntime.tokenUsageUnreported")}
                    </Badge>
                  ) : (
                    <span className="font-mono ui-micro text-text-faint">
                      {t("agentRuntime.tokenUsageReportedCount", {
                        reported: String(row.usageReportedDispatches),
                        unavailable: String(row.usageUnavailableDispatches),
                      })}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}

export function RankingMetricControl({
  metric,
  onMetric,
}: {
  readonly metric: RankingMetric;
  readonly onMetric: (metric: RankingMetric) => void;
}) {
  return (
    <span role="group" aria-label={t("agentRuntime.tokenUsageMetricLabel")} className="inline-flex flex-wrap gap-1">
      {rankingMetrics.map((item) => (
        <button
          key={item}
          type="button"
          data-testid={`token-usage-metric-${item}`}
          aria-pressed={metric === item}
          onClick={() => onMetric(item)}
          className={`rounded border px-2 py-0.5 ui-micro ${
            metric === item
              ? "border-accent bg-accent/15 font-semibold text-accent"
              : "border-border text-text-muted hover:border-border-strong hover:text-text"
          }`}
        >
          {t(rankingMetricKey[item])}
        </button>
      ))}
    </span>
  );
}
