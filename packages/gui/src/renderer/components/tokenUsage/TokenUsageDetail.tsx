import { Notice } from "../primitives/Notice";
import { SegCtl } from "../primitives/SegCtl.tsx";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "@phosphor-icons/react";
import type {
  AgentRuntimeTokenUsageMemberIdentity,
  AgentRuntimeTokenUsageRange,
  AgentRuntimeTokenUsageSessionRow,
} from "@harness-anything/daemon/protocol";
import type { SnapshotStatus } from "../../model/types";
import { agentRuntimeClient, runtimeQueryKeys } from "../../agent-runtime-client.ts";
import { compactTokens, exactTokens, preciseTokens, usdText } from "../../token-format.ts";
import { formatDuration, formatTime } from "../../model/time.ts";
import { usageIsUnreported, usageOutcomeKey, usageStateKey } from "../../token-usage-model.ts";
import { t } from "../../i18n/index.tsx";
import { QUERY_PACING_MS } from "../../query-pacing.ts";
import { Card, CardBody, CardHead, CardTitle, Right } from "../runtime/parts.tsx";
import { Chip } from "../primitives/Chip.tsx";
import { KV, KVRow } from "../primitives/Fields.tsx";
import { Empty } from "../primitives/Empty.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import { tokenKindLayers, UsageTrendChart, UsageTrendTable } from "./UsageTrendChart.tsx";

const OUTCOME_TONE: Readonly<Record<AgentRuntimeTokenUsageSessionRow["outcome"], SnapshotStatus>> = {
  succeeded: "done",
  failed: "blocked",
  aborted: "cancelled",
  running: "active",
  unknown: "unknown",
};

/**
 * 成员(单 Worker / 小队)消耗详情:头部总量与构成、该成员自己的趋势、会话列表。
 * 会话行可跳会话页(session/<id>),task 可跳任务详情;返回列表走调用方的 onExit。
 */
export function TokenUsageDetail({
  repoId,
  member,
  range,
  onSelectEntity,
  onOpenTask,
  onExit,
}: {
  readonly repoId: string;
  readonly member: AgentRuntimeTokenUsageMemberIdentity;
  readonly range: AgentRuntimeTokenUsageRange;
  readonly onSelectEntity: (ref: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onExit: () => void;
}) {
  const [trendAsTable, setTrendAsTable] = useState(false),
    detail = useQuery({
      queryKey: runtimeQueryKeys.tokenUsageDetail(repoId, member, range),
      queryFn: () => agentRuntimeClient.tokenUsageDetail(repoId, member, range),
      refetchInterval: QUERY_PACING_MS.tokenUsage,
    }),
    data = detail.data;
  return (
    <div data-testid="token-usage-detail" className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6">
      <button
        type="button"
        data-testid="token-usage-detail-back"
        onClick={onExit}
        className="mb-1.5 inline-flex items-center gap-1 ui-micro text-text-faint hover:text-accent"
      >
        <ArrowLeft />
        {t("agentRuntime.tokenUsageBackToOverview")}
      </button>
      {detail.isError ? (
        <Notice tone="bad" variant="panel" testId="runtime-read-error">
          {t("agentRuntime.readFailed", {
            error: detail.error instanceof Error ? detail.error.message : String(detail.error),
          })}
        </Notice>
      ) : null}
      {detail.isPending || data === undefined ? (
        <Empty>{t("agentRuntime.loading")}</Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
            <div className="min-w-0">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <b className="ui-body font-[650]">
                  {data.member.kind === "squad" ? data.member.squadName : data.member.agentName}
                </b>
                <Chip tone="mono">
                  {data.member.kind === "squad"
                    ? `${t("agentRuntime.tokenUsageSegmentSquads")} · ${data.member.squadId}`
                    : `${t("agentRuntime.tokenUsageSegmentAgents")} · ${data.member.agentId}`}
                </Chip>
                {usageIsUnreported(data.totals ?? { usageReportedDispatches: 1, usageUnavailableDispatches: 0 }) ? (
                  <StatusTag
                    status="cancelled"
                    mono
                    tip={t("agentRuntime.tokenUsageUnreportedTip")}
                    label={t("agentRuntime.tokenUsageUnreported")}
                  />
                ) : null}
              </div>
              <p className="font-mono ui-micro text-text-faint">
                {t("agentRuntime.tokenUsageSince", {
                  since: formatTime(new Date(data.since ?? 0).toISOString(), { style: "date-time" }) ?? "—",
                })}
              </p>
            </div>
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-[4fr_8fr]">
            <Card testId="token-usage-detail-totals">
              <CardHead>
                <CardTitle>{t("agentRuntime.tokenUsageTotalsTitle")}</CardTitle>
              </CardHead>
              <CardBody>
                <KV>
                  <KVRow name={t("agentRuntime.tokenUsageColSessions")}>{String(data.totals.sessionCount ?? 0)}</KVRow>
                  <KVRow name={t("agentRuntime.tokenUsageColInput")}>{exactTokens(data.totals.inputTokens ?? 0)}</KVRow>
                  <KVRow name={t("agentRuntime.tokenUsageColCacheRead")}>
                    {exactTokens(data.totals.cacheReadTokens ?? 0)}
                  </KVRow>
                  <KVRow name={t("agentRuntime.tokenUsageColOutput")}>
                    {exactTokens(data.totals.outputTokens ?? 0)}
                  </KVRow>
                  <KVRow name={t("agentRuntime.tokenUsageColTotal")}>{exactTokens(data.totals.totalTokens ?? 0)}</KVRow>
                  <KVRow name={t("agentRuntime.tokenUsageColCost")}>
                    {usdText(data.totals.costUsd ?? 0)}
                    {data.totals.totalTokens !== undefined &&
                    data.totals.totalTokens > 0 &&
                    data.totals.unpricedTokens !== undefined &&
                    data.totals.unpricedTokens > 0
                      ? ` · ${t("agentRuntime.tokenUsageCostUnpricedCount", {
                          tokens: preciseTokens(data.totals.unpricedTokens),
                        })}`
                      : ""}
                  </KVRow>
                  <KVRow name={t("agentRuntime.tokenUsageColTools")}>{String(data.totals.toolCallCount ?? 0)}</KVRow>
                  <KVRow name={t("agentRuntime.tokenUsageColUsage")}>
                    {t("agentRuntime.tokenUsageReportedCount", {
                      reported: String(data.totals.usageReportedDispatches ?? 0),
                      unavailable: String(data.totals.usageUnavailableDispatches ?? 0),
                    })}
                  </KVRow>
                </KV>
              </CardBody>
            </Card>
            <div className="min-w-0">
              <Card testId="token-usage-detail-trend">
                <CardHead>
                  <CardTitle>{t("agentRuntime.tokenUsageTrendTitle")}</CardTitle>
                  <Right>
                    <SegCtl
                      label={t("agentRuntime.tokenUsageViewLabel")}
                      value={trendAsTable ? "table" : "chart"}
                      onChange={(value) => setTrendAsTable(value === "table")}
                      options={[
                        { value: "chart", label: t("agentRuntime.tokenUsageViewChart") },
                        { value: "table", label: t("agentRuntime.tokenUsageViewTable") },
                      ]}
                    />
                  </Right>
                </CardHead>
                <CardBody>
                  {trendAsTable ? (
                    <UsageTrendTable
                      buckets={data.buckets}
                      bucketMs={data.bucketMs}
                      layers={tokenKindLayers(data.buckets)}
                    />
                  ) : (
                    <UsageTrendChart
                      buckets={data.buckets}
                      bucketMs={data.bucketMs}
                      layers={tokenKindLayers(data.buckets)}
                    />
                  )}
                </CardBody>
              </Card>
              <Card testId="token-usage-detail-sessions">
                <CardHead>
                  <CardTitle>{t("agentRuntime.tokenUsageSessionsTitle")}</CardTitle>
                  <Right>
                    <Chip tone="mono">
                      {t("agentRuntime.tokenUsageSessionsCount", { count: String(data.sessions.length ?? 0) })}
                    </Chip>
                  </Right>
                </CardHead>
                <CardBody>
                  {(data.sessions.length ?? 0) === 0 ? (
                    <Empty>{t("agentRuntime.tokenUsageEmpty")}</Empty>
                  ) : (
                    <table data-testid="token-usage-sessions-table" className="w-full border-separate border-spacing-0">
                      <thead>
                        <tr className="text-left font-mono ui-micro uppercase tracking-[0.06em] text-text-faint">
                          <th className="border-b border-border pb-1 pr-3">{t("agentRuntime.tokenUsageColSession")}</th>
                          <th className="border-b border-border pb-1 pr-3">{t("agentRuntime.tokenUsageColTask")}</th>
                          <th className="border-b border-border pb-1 pr-3">{t("agentRuntime.tokenUsageColStarted")}</th>
                          <th className="border-b border-border pb-1 pr-3 text-right">
                            {t("agentRuntime.tokenUsageColDuration")}
                          </th>
                          <th className="border-b border-border pb-1 pr-3">{t("agentRuntime.tokenUsageColOutcome")}</th>
                          <th className="border-b border-border pb-1 pr-3 text-right">
                            {t("agentRuntime.tokenUsageColTotal")}
                          </th>
                          <th className="border-b border-border pb-1 pr-3 text-right">
                            {t("agentRuntime.tokenUsageColTools")}
                          </th>
                          <th className="border-b border-border pb-1 text-right">
                            {t("agentRuntime.tokenUsageColUsage")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data.sessions ?? []).map((session) => (
                          <tr
                            key={session.dispatchId}
                            data-testid={`token-usage-session-${session.dispatchId}`}
                            className="hover:bg-surface-raised"
                          >
                            <td className="border-b border-border py-1 pr-3">
                              <button
                                type="button"
                                onClick={() => onSelectEntity(`session/${session.runtimeSessionId}`)}
                                className="font-mono ui-micro text-accent hover:underline"
                                title={t("agentRuntime.tokenUsageOpenSession")}
                              >
                                {session.runtimeSessionId}
                              </button>
                            </td>
                            <td className="border-b border-border py-1 pr-3">
                              {session.taskId === null ? (
                                <span className="ui-micro text-text-faint">—</span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => onOpenTask(session.taskId!)}
                                  className="font-mono ui-micro text-accent hover:underline"
                                >
                                  {session.taskId}
                                </button>
                              )}
                            </td>
                            <td className="border-b border-border py-1 pr-3 font-mono ui-micro">
                              {formatTime(session.startedAt, { style: "month-day-time" }) ?? session.startedAt}
                            </td>
                            <td className="border-b border-border py-1 pr-3 text-right font-mono ui-micro">
                              {formatDuration(session.durationMs)}
                            </td>
                            <td className="border-b border-border py-1 pr-3">
                              <StatusTag
                                status={OUTCOME_TONE[session.outcome]}
                                mono
                                label={t(usageOutcomeKey[session.outcome])}
                              />
                            </td>
                            <td
                              className="border-b border-border py-1 pr-3 text-right font-mono ui-micro"
                              title={exactTokens(session.totalTokens)}
                            >
                              {compactTokens(session.totalTokens)}
                            </td>
                            <td className="border-b border-border py-1 pr-3 text-right font-mono ui-micro">
                              {session.toolCallCount}
                            </td>
                            <td className="border-b border-border py-1 text-right">
                              <span
                                className={`font-mono ui-micro ${session.usage === "unavailable" ? "text-status-cancelled" : session.usage === "pending" ? "text-text-faint" : "text-text-muted"}`}
                              >
                                {t(usageStateKey(session.usage))}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardBody>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
