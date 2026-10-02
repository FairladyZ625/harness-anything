import { SegCtl } from "../components/primitives/SegCtl.tsx";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentRuntimeTokenUsageResult } from "@harness-anything/daemon/protocol";
import { agentRuntimeClient, runtimeQueryKeys } from "../agent-runtime-client.ts";
import { t } from "../i18n/index.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { StatusTag } from "../components/primitives/StatusTag.tsx";
import { Region } from "../components/primitives/Region.tsx";
import { QUERY_PACING_MS } from "../query-pacing.ts";
import {
  rankScaleFor,
  tokenUsageMemberFromRef,
  tokenUsageRanges,
  tokenUsageRangeKey,
  type RankScale,
  type TokenUsageRange,
} from "../token-usage-model.ts";
import {
  seriesLayers,
  tokenKindLayers,
  UsageTrendChart,
  UsageTrendTable,
} from "../components/tokenUsage/UsageTrendChart.tsx";
import { UsageRanking, UsageRankingTable, type RankingRow } from "../components/tokenUsage/UsageRanking.tsx";
import { UsageHeadline } from "../components/tokenUsage/UsageHeadline.tsx";
import { UsageSessions, UsageSpend, UsageUnreported, UsageWorth } from "../components/tokenUsage/UsageBreakdowns.tsx";
import { TokenUsageDetail } from "../components/tokenUsage/TokenUsageDetail.tsx";

/**
 * 系统 Tab 的「Token 消耗」页:所选时间范围(今天 / 7 天 / 30 天)内的消耗分析。按问题顺序
 * 排:一共花了多少、比上一段多还是少 → 花在哪类 token 上 → 随时间怎么变、高峰是谁造成的 →
 * 谁花的 → 花在什么事上 → 单个会话的情况 → 值不值 → 哪些派工没上报用量。
 * 数据全部来自 daemon 的一次聚合读(repo.agentRuntime.tokenUsage),renderer 只做展示;成员
 * 详情另走 tokenUsageDetail,经 focusedEntityRef(tokenAgent/<id> · tokenSquad/<id>)推栈。
 * 区域用 Region 框,栏数只看内容区自己的宽度(容器查询):宽时两栏,窄时单列。
 */
type Segment = "agents" | "squads" | "models";
type Stack = "kinds" | "agents" | "models";
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
    member = tokenUsageMemberFromRef(focusedEntityRef),
    usage = useQuery({
      queryKey: runtimeQueryKeys.tokenUsage(repoId, range),
      queryFn: () => agentRuntimeClient.tokenUsage(repoId, range),
      enabled: REPO_ID.test(repoId),
      // 派工流的 runtime_metrics 增长不推进台账 cut,页面自持低频轮询(见 query-pacing)。
      refetchInterval: QUERY_PACING_MS.tokenUsage,
    }),
    data = usage.data;
  return (
    <section data-testid="token-usage-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex min-h-[42px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-surface-raised px-3.5">
        <b className="ui-body tracking-[0.02em]">{t("agentRuntime.tokenUsageTitle")}</b>
        <SegCtl
          label={t("agentRuntime.tokenUsageRangeLabel")}
          value={range}
          onChange={(value) => setRange(value)}
          options={tokenUsageRanges.map((value) => ({ value, label: t(tokenUsageRangeKey[value]) }))}
        />
        <span className="flex-1" />
        {data?.status === "pending" ? (
          <StatusTag status="planned" label={t("agentRuntime.tokenUsageProjectionPending")} />
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
        <main className="@container min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6">
          {usage.isPending || data === undefined ? (
            <Empty>{t("agentRuntime.loading")}</Empty>
          ) : (
            <UsageAnalysis
              data={data}
              onFocusMember={onFocusMember}
              onSelectEntity={onSelectEntity}
              onOpenTask={onOpenTask}
            />
          )}
        </main>
      )}
    </section>
  );
}

function UsageAnalysis({
  data,
  onFocusMember,
  onSelectEntity,
  onOpenTask,
}: {
  readonly data: AgentRuntimeTokenUsageResult;
  readonly onFocusMember: (ref: string | null) => void;
  readonly onSelectEntity: (ref: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const [stack, setStack] = useState<Stack>("kinds"),
    [trendAs, setTrendAs] = useState<Presentation>("chart"),
    [segment, setSegment] = useState<Segment>("agents"),
    [rankingAs, setRankingAs] = useState<Presentation>("chart"),
    // 条长刻度默认跟数据走(量级悬殊用对数),用户点过之后以用户的选择为准。
    [chosenScale, setChosenScale] = useState<RankScale | null>(null),
    [spendScope, setSpendScope] = useState<"tasks" | "works">("tasks");
  const rows: readonly RankingRow[] =
      segment === "agents"
        ? data.agents.map((row) => ({ ...row, id: row.agentId, name: row.agentName }))
        : segment === "squads"
          ? data.squads.map((row) => ({ ...row, id: row.squadId, name: row.squadName }))
          : data.models.map((row) => ({ ...row, id: row.model, name: row.model })),
    scale = chosenScale ?? rankScaleFor(rows.map(({ totalTokens }) => totalTokens)),
    openMember =
      segment === "models"
        ? undefined
        : (row: RankingRow) => onFocusMember(segment === "agents" ? `tokenAgent/${row.id}` : `tokenSquad/${row.id}`),
    layers =
      stack === "kinds"
        ? tokenKindLayers(data.buckets)
        : seriesLayers(stack === "agents" ? data.trend.agents : data.trend.models),
    viewOptions = [
      { value: "chart" as const, label: t("agentRuntime.tokenUsageViewChart") },
      { value: "table" as const, label: t("agentRuntime.tokenUsageViewTable") },
    ];
  return (
    // 网格项默认 min-width 是内容的 min-content,宽表格会把整页撑出横向滚动:每格 min-w-0,
    // 宽内容在格内自滚。两栏断点量的是内容区(@container),不是窗口。
    <div className="grid grid-cols-1 gap-3 @[900px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] [&>*]:min-w-0">
      <div className="@container col-span-full">
        <UsageHeadline data={data} />
      </div>
      <div className="col-span-full" data-testid="token-usage-trend-card">
        <Region title={t("agentRuntime.tokenUsageTrendTitle")}>
          <Controls>
            <SegCtl
              label={t("agentRuntime.tokenUsageStackLabel")}
              value={stack}
              onChange={setStack}
              options={[
                { value: "kinds", label: t("agentRuntime.tokenUsageStackKinds") },
                { value: "agents", label: t("agentRuntime.tokenUsageStackAgents") },
                { value: "models", label: t("agentRuntime.tokenUsageStackModels") },
              ]}
            />
            <SegCtl
              label={t("agentRuntime.tokenUsageViewLabel")}
              value={trendAs}
              onChange={setTrendAs}
              options={viewOptions}
            />
          </Controls>
          <div className="px-3.5 pb-3">
            {trendAs === "table" ? (
              <UsageTrendTable buckets={data.buckets} bucketMs={data.bucketMs} layers={layers} />
            ) : (
              <UsageTrendChart buckets={data.buckets} bucketMs={data.bucketMs} layers={layers} />
            )}
          </div>
        </Region>
      </div>
      <div data-testid="token-usage-ranking-card">
        <Region title={t("agentRuntime.tokenUsageRankingTitle")}>
          <Controls>
            <SegCtl
              label={t("agentRuntime.tokenUsageSegmentLabel")}
              value={segment}
              onChange={setSegment}
              options={[
                { value: "agents", label: t("agentRuntime.tokenUsageSegmentAgents") },
                { value: "squads", label: t("agentRuntime.tokenUsageSegmentSquads") },
                { value: "models", label: t("agentRuntime.tokenUsageSegmentModels") },
              ]}
            />
            {rankingAs === "chart" ? (
              <SegCtl
                label={t("agentRuntime.tokenUsageScaleLabel")}
                value={scale}
                onChange={setChosenScale}
                options={[
                  {
                    value: "log",
                    label: t("agentRuntime.tokenUsageScaleLog"),
                    tip: t("agentRuntime.tokenUsageScaleLogTip"),
                  },
                  { value: "linear", label: t("agentRuntime.tokenUsageScaleLinear") },
                ]}
              />
            ) : null}
            <SegCtl
              label={t("agentRuntime.tokenUsageViewLabel")}
              value={rankingAs}
              onChange={setRankingAs}
              options={viewOptions}
            />
          </Controls>
          {rankingAs === "table" ? (
            <UsageRankingTable rows={rows} onSelect={openMember} testId={`token-usage-${segment}-table`} />
          ) : (
            <UsageRanking rows={rows} total={data.totals.totalTokens} scale={scale} onSelect={openMember} />
          )}
        </Region>
      </div>
      <div>
        <Region title={t("agentRuntime.tokenUsageSpendTitle")}>
          <Controls>
            <SegCtl
              label={t("agentRuntime.tokenUsageSpendScopeLabel")}
              value={spendScope}
              onChange={setSpendScope}
              options={[
                { value: "tasks", label: t("agentRuntime.tokenUsageSpendTasks") },
                { value: "works", label: t("agentRuntime.tokenUsageSpendWorks") },
              ]}
            />
          </Controls>
          <UsageSpend data={data} scope={spendScope} onOpenTask={onOpenTask} />
        </Region>
      </div>
      <div className="@container">
        <Region title={t("agentRuntime.tokenUsageSessionsRegionTitle")}>
          <UsageSessions data={data} onSelectEntity={onSelectEntity} />
        </Region>
      </div>
      <div className="flex flex-col gap-3">
        <Region title={t("agentRuntime.tokenUsageWorthTitle")}>
          <UsageWorth data={data} />
        </Region>
        {data.totals.usageUnavailableDispatches > 0 ? (
          <Region title={t("agentRuntime.tokenUsageTotalsUnreported")} edge="wait">
            <UsageUnreported data={data} />
          </Region>
        ) : null}
      </div>
    </div>
  );
}

/** 区域内的控件行:Region 的标题行不放动作,切换控件放在行体第一行,靠右、放不下时折行。 */
function Controls({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 px-3.5 pb-2.5">{children}</div>;
}
