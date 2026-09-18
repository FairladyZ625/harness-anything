import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentRuntimeClient, runtimeQueryKeys } from "../agent-runtime-client.ts";
import { t } from "../i18n/index.tsx";
import { Badge, Card, CardBody, CardHead, CardTitle, Empty, Right, SegCtl } from "../components/runtime/parts.tsx";
import { QUERY_PACING_MS } from "../query-pacing.ts";
import { compactTokens, exactTokens } from "../token-format.ts";
import {
  tokenUsageMemberFromRef,
  tokenUsageRanges,
  tokenUsageRangeKey,
  usageIsUnreported,
  type RankingMetric,
  type TokenUsageRange,
} from "../token-usage-model.ts";
import { UsageTrendChart, UsageTrendTable } from "../components/tokenUsage/UsageTrendChart.tsx";
import {
  RankingMetricControl,
  UsageRanking,
  UsageRankingTable,
  type RankingRow,
} from "../components/tokenUsage/UsageRanking.tsx";
import { TokenUsageDetail } from "../components/tokenUsage/TokenUsageDetail.tsx";

/**
 * 系统 Tab 的「Token 消耗」页(task_7a1bd444 重做):所选时间范围(今天/7 天/30 天)内
 * 的总量与构成、时间趋势、成员排行与可下钻的成员详情。数据全部来自 daemon 侧两条
 * 聚合读(repo.agentRuntime.tokenUsage / tokenUsageDetail),renderer 只做展示投影;
 * 「未上报用量」与「用量为 0」分开展示(zcode/claude 类 provider 当前不上报 token)。
 * 成员详情走 focusedEntityRef(tokenAgent/<id> · tokenSquad/<id>)推栈,前进后退原路返回。
 */
type Segment = "agents" | "squads";
type Presentation = "chart" | "table";

const REPO_ID = /^[a-z][a-z0-9-]{0,62}$/u;

export function TokenUsageView({
  repoId,
  focusedEntityRef,
  onFocusMember,
  onSelectEntity,
  onOpenTask,
}: {
  readonly repoId: string;
  /** `tokenAgent/<id>` / `tokenSquad/<id>`:详情落点,空 = 总览。 */
  readonly focusedEntityRef: string | null;
  readonly onFocusMember: (ref: string | null) => void;
  readonly onSelectEntity: (ref: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const [range, setRange] = useState<TokenUsageRange>("today"),
    [segment, setSegment] = useState<Segment>("agents"),
    [metric, setMetric] = useState<RankingMetric>("totalTokens"),
    [trendAsTable, setTrendAsTable] = useState<Presentation>("chart"),
    [rankingAsTable, setRankingAsTable] = useState<Presentation>("chart"),
    member = tokenUsageMemberFromRef(focusedEntityRef),
    usage = useQuery({
      queryKey: runtimeQueryKeys.tokenUsage(repoId, range),
      queryFn: () => agentRuntimeClient.tokenUsage(repoId, range),
      enabled: REPO_ID.test(repoId),
      // 派工流的 runtime_metrics 增长不推进台账 cut,页面自持低频轮询(见 query-pacing)。
      refetchInterval: QUERY_PACING_MS.tokenUsage,
    }),
    data = usage.data;
  const rows: readonly RankingRow[] =
    data === undefined
      ? []
      : segment === "agents"
        ? data.agents.map((row) => ({ ...row, id: row.agentId, name: row.agentName }))
        : data.squads.map((row) => ({ ...row, id: row.squadId, name: row.squadName }));
  const openMember = (row: RankingRow) =>
    onFocusMember(segment === "agents" ? `tokenAgent/${row.id}` : `tokenSquad/${row.id}`);
  return (
    <section data-testid="token-usage-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-surface-raised px-3.5">
        <b className="ui-body tracking-[0.02em]">{t("agentRuntime.tokenUsageTitle")}</b>
        <SegCtl
          label={t("agentRuntime.tokenUsageRangeLabel")}
          value={range}
          onChange={(value) => setRange(value)}
          options={tokenUsageRanges.map((value) => ({ value, label: t(tokenUsageRangeKey[value]) }))}
        />
        <span className="flex-1" />
        <Badge tip={data?.since}>{t(tokenUsageRangeKey[range])}</Badge>
        {data?.status === "pending" ? (
          <Badge status="planned">{t("agentRuntime.tokenUsageProjectionPending")}</Badge>
        ) : null}
      </header>
      {usage.isError ? (
        <p
          role="alert"
          data-testid="runtime-read-error"
          className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono ui-micro
        text-status-blocked"
        >
          {t("agentRuntime.readFailed", {
            error: usage.error instanceof Error ? usage.error.message : String(usage.error),
          })}
        </p>
      ) : null}
      {member !== null ? (
        <TokenUsageDetail
          repoId={repoId}
          member={member}
          range={range}
          onSelectEntity={onSelectEntity}
          onOpenTask={onOpenTask}
          onExit={() => onFocusMember(null)}
        />
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6">
          {usage.isPending || data === undefined ? (
            <Empty>{t("agentRuntime.loading")}</Empty>
          ) : (
            <>
              <TotalsStrip totals={data.totals} testId="token-usage-totals" />
              <div className="mt-3 grid gap-3">
                <Card testId="token-usage-trend-card">
                  <CardHead>
                    <CardTitle>{t("agentRuntime.tokenUsageTrendTitle")}</CardTitle>
                    <Right>
                      <SegCtl
                        label={t("agentRuntime.tokenUsageViewLabel")}
                        value={trendAsTable}
                        onChange={(value) => setTrendAsTable(value)}
                        options={[
                          { value: "chart", label: t("agentRuntime.tokenUsageViewChart") },
                          { value: "table", label: t("agentRuntime.tokenUsageViewTable") },
                        ]}
                      />
                    </Right>
                  </CardHead>
                  <CardBody>
                    {trendAsTable === "table" ? (
                      <UsageTrendTable buckets={data.buckets} bucketMs={data.bucketMs} />
                    ) : (
                      <UsageTrendChart buckets={data.buckets} bucketMs={data.bucketMs} />
                    )}
                  </CardBody>
                </Card>
                <Card testId="token-usage-ranking-card">
                  <CardHead>
                    <CardTitle>{t("agentRuntime.tokenUsageRankingTitle")}</CardTitle>
                    <Right>
                      <div className="flex flex-wrap items-center gap-2">
                        <SegCtl
                          label={t("agentRuntime.tokenUsageSegmentLabel")}
                          value={segment}
                          onChange={(value) => setSegment(value)}
                          options={[
                            { value: "agents", label: t("agentRuntime.tokenUsageSegmentAgents") },
                            { value: "squads", label: t("agentRuntime.tokenUsageSegmentSquads") },
                          ]}
                        />
                        <RankingMetricControl metric={metric} onMetric={setMetric} />
                        <SegCtl
                          label={t("agentRuntime.tokenUsageViewLabel")}
                          value={rankingAsTable}
                          onChange={(value) => setRankingAsTable(value)}
                          options={[
                            { value: "chart", label: t("agentRuntime.tokenUsageViewChart") },
                            { value: "table", label: t("agentRuntime.tokenUsageViewTable") },
                          ]}
                        />
                      </div>
                    </Right>
                  </CardHead>
                  <CardBody>
                    {rankingAsTable === "table" ? (
                      <UsageRankingTable
                        rows={rows}
                        onSelect={openMember}
                        testId={segment === "agents" ? "token-usage-agents-table" : "token-usage-squads-table"}
                      />
                    ) : (
                      <UsageRanking rows={rows} metric={metric} onSelect={openMember} />
                    )}
                  </CardBody>
                </Card>
              </div>
            </>
          )}
        </main>
      )}
    </section>
  );
}

/** 窗口指标条:总量与构成、会话、工具调用、未上报派工数(数据可信度直接可见)。 */
function TotalsStrip({
  totals,
  testId,
}: {
  readonly totals: {
    readonly sessionCount: number;
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly toolCallCount: number;
    readonly usageReportedDispatches: number;
    readonly usageUnavailableDispatches: number;
  };
  readonly testId: string;
}) {
  const unreported = usageIsUnreported(totals);
  return (
    <div data-testid={testId} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded border border-border bg-surface px-3 py-2">
        <p className="font-mono ui-micro uppercase tracking-[0.08em] text-text-faint">
          {t("agentRuntime.tokenUsageTotalsTokens")}
        </p>
        <p className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums" title={exactTokens(totals.totalTokens)}>
          {compactTokens(totals.totalTokens)}
        </p>
        <p className="mt-0.5 font-mono ui-micro text-text-faint">
          {t("agentRuntime.tokenUsageColInput")} {compactTokens(totals.inputTokens)} ·{" "}
          {t("agentRuntime.tokenUsageColCacheRead")} {compactTokens(totals.cacheReadTokens)} ·{" "}
          {t("agentRuntime.tokenUsageColOutput")} {compactTokens(totals.outputTokens)}
        </p>
      </div>
      <div className="rounded border border-border bg-surface px-3 py-2">
        <p className="font-mono ui-micro uppercase tracking-[0.08em] text-text-faint">
          {t("agentRuntime.tokenUsageTotalsSessions")}
        </p>
        <p className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums">{totals.sessionCount}</p>
      </div>
      <div className="rounded border border-border bg-surface px-3 py-2">
        <p className="font-mono ui-micro uppercase tracking-[0.08em] text-text-faint">
          {t("agentRuntime.tokenUsageTotalsTools")}
        </p>
        <p className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums">{totals.toolCallCount}</p>
      </div>
      <div className="rounded border border-border bg-surface px-3 py-2">
        <p className="font-mono ui-micro uppercase tracking-[0.08em] text-text-faint">
          {t("agentRuntime.tokenUsageTotalsUnreported")}
        </p>
        <p
          className={`mt-0.5 font-mono text-[15px] font-semibold tabular-nums ${totals.usageUnavailableDispatches > 0 ? "text-status-cancelled" : ""}`}
        >
          {totals.usageUnavailableDispatches}
        </p>
        {unreported ? (
          <p className="mt-0.5 ui-micro text-status-cancelled">{t("agentRuntime.tokenUsageUnreported")}</p>
        ) : null}
      </div>
    </div>
  );
}
