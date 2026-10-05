import { useState } from "react";
import { Play, Plus } from "@phosphor-icons/react";
import type { ScheduleGuiListRowDto, ScheduleGuiRowDto, SchedulesListResult } from "@harness-anything/daemon/protocol";
import { Empty } from "../components/primitives/Empty.tsx";
import { CompletedDivider } from "../components/primitives/CompletedDivider.tsx";
import { FilterChips } from "../components/primitives/FilterChips.tsx";
import { CardReason, SummaryCard, SummaryCardGroup } from "../components/primitives/SummaryCard.tsx";
import type { StatusTone } from "../components/primitives/StatusTag.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { missedReasonLabel, RUN_OUTCOME_META, SPARK_COLOR } from "../components/scheduleRun/runMeta.ts";
import { t, type MessageKey } from "../i18n/index.tsx";
import {
  dayClock,
  needsAttention,
  scheduleTiers,
  scheduleVerdict,
  triggerLabel,
  untilLabel,
  upcomingRuns,
} from "../model/schedule-list.ts";
import type { ScheduleActionReceipt, ScheduleRunOutcomeWord } from "../schedules-client.ts";

// Schedules list (S4/M1): one `schedule-plane` read paints the page — a「接下来」line, then
// one summary card per schedule sized by attention (design: needs-attention large, running
// fine large/small by total, paused as tiles). The pane only groups and formats daemon
// facts. 点卡直接进 `schedule/<id>` 详情 hub(标准 §5.1,不设预览抽屉);卡上唯一的动作是
// 「立即运行」,其余动作仍在详情里。

const TARGET_STATE_KEY: Readonly<Record<NonNullable<ScheduleGuiRowDto["targetState"]>, MessageKey>> = {
  invalid: "agentRuntime.catalogInvalid",
  missing: "agentRuntime.catalogMissing",
};

/** 「本节点可执行」是正常状态,不占标签;只有执行不在本节点时才在卡上说明。 */
const AVAILABILITY_NOTE: Record<
  Exclude<ScheduleGuiRowDto["executionAvailability"], "local">,
  "schedules.availability.claimedElsewhere" | "schedules.availability.notOnThisNode"
> = {
  "claimed-elsewhere": "schedules.availability.claimedElsewhere",
  "not-on-this-node": "schedules.availability.notOnThisNode",
};

type ScheduleFilter = "attn" | "paused" | "all";

export function ScheduleListPane({
  rows,
  data,
  pending,
  busy,
  receipt,
  actionError,
  onOpen,
  onCreate,
  onRunNow,
}: {
  readonly rows: readonly ScheduleGuiListRowDto[];
  readonly data: SchedulesListResult | null;
  readonly pending: boolean;
  readonly busy: boolean;
  readonly receipt: ScheduleActionReceipt | null;
  readonly actionError: string | null;
  readonly onOpen: (scheduleId: string) => void;
  readonly onCreate: () => void;
  readonly onRunNow: (row: ScheduleGuiRowDto) => void;
}) {
  // 默认「全部」:卡片大小已经表达轻重,一屏放得下时不先藏起来。
  const [filter, setFilter] = useState<ScheduleFilter>("all");
  const [search, setSearch] = useState("");
  const now = Date.now();
  const query = search.trim().toLocaleLowerCase();
  const matchesSearch = (row: ScheduleGuiListRowDto) =>
    query.length === 0 ||
    (row.state === "invalid"
      ? `${row.scheduleId} ${row.invalidReason}`.toLocaleLowerCase().includes(query)
      : `${row.name} ${row.scheduleId} ${row.trigger.summary} ${triggerLabel(row.trigger)}`
          .toLocaleLowerCase()
          .includes(query));
  const matchesFilter = (row: ScheduleGuiListRowDto, key: ScheduleFilter) =>
    key === "all" ? true : key === "attn" ? needsAttention(row) : row.state === "paused";
  const visible = rows.filter((row) => matchesSearch(row) && matchesFilter(row, filter)),
    tiers = scheduleTiers(visible, rows.length),
    upcoming = upcomingRuns(rows);
  // 列表页头随列表态渲染(详情态整个卸载,chrome 审计 B1①);汇总句只数本列表的行。
  const total = rows.length,
    attention = rows.filter(needsAttention).length;
  const chips = (
    [
      ["attn", t("schedules.list.filter.attn")],
      ["paused", t("schedules.state.paused")],
      ["all", t("schedules.list.filter.all")],
    ] as const
  ).map(([key, label]) => ({ key, label, count: rows.filter((row) => matchesFilter(row, key)).length }));
  const agentName = (agentId: string) => {
    const option = data?.options.agents.find((agent) => agent.agentId === agentId);
    return option !== undefined && "name" in option ? option.name : agentId;
  };
  const card = (row: ScheduleGuiListRowDto, size: "large" | "small") =>
    row.state === "invalid" ? (
      <SummaryCard
        key={row.scheduleId}
        size="large"
        testId={`schedule-row-${row.scheduleId}`}
        title={row.scheduleId}
        tone="bad"
      >
        <CardReason tone="bad" label={t("schedules.state.invalid")}>
          {row.invalidReason}
        </CardReason>
      </SummaryCard>
    ) : (
      <ScheduleCard
        key={row.scheduleId}
        row={row}
        size={size}
        now={now}
        busy={busy}
        agentName={agentName}
        onOpen={onOpen}
        onRunNow={onRunNow}
      />
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="schedules-list">
      <header className="flex flex-wrap items-baseline gap-3 px-5 py-3">
        <h1 className="text-xl font-semibold text-text">{t("schedules.title")}</h1>
        <span data-testid="schedules-summary" className="min-w-0 truncate text-sm text-text-muted">
          {attention > 0
            ? t("schedules.summaryAttention", { count: total, attention })
            : t("schedules.summary", { count: total })}
        </span>
      </header>
      {upcoming.next.length > 0 && (
        <p data-testid="schedules-upcoming" className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-5 pb-1 ui-meta">
          <span className="font-semibold text-text-muted">{t("schedules.upcoming.label")}</span>
          {upcoming.next.map((row, index) => (
            <span key={row.scheduleId} className="text-text">
              {index > 0 && (
                <span aria-hidden className="mr-2 text-text-faint">
                  →
                </span>
              )}
              <span className="font-mono tabular-nums">{dayClock(row.nextRunAt ?? "", now)}</span> {row.name}
            </span>
          ))}
          {upcoming.more > 0 && (
            <span className="text-text-faint">{t("schedules.upcoming.more", { count: upcoming.more })}</span>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 px-5 py-2" data-testid="schedules-filters">
        <FilterChips chips={chips} value={filter} onChange={setFilter} />
        <input
          type="search"
          aria-label={t("schedules.list.searchLabel")}
          placeholder={t("schedules.list.searchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-[200px] flex-1 rounded-xs border border-border bg-surface-raised px-3 py-1.5 text-text ui-meta outline-none placeholder:text-text-faint focus:border-border-strong"
        />
        <button
          type="button"
          data-testid="schedule-action-create"
          disabled={busy || data === null || !data.actions.create.available}
          title={
            data?.actions.create.available === false
              ? (data.actions.create.nextAction ?? data.actions.create.code ?? undefined)
              : undefined
          }
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 rounded-xs border border-accent bg-accent px-2.5 py-1 ui-meta font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          <Plus weight="bold" aria-hidden />
          {t("schedules.action.new")}
        </button>
      </div>
      {/* 卡上「立即运行」的结果就地显示,与详情页同一条回执/错误文案。 */}
      {actionError !== null && (
        <p
          role="alert"
          data-testid="schedule-action-error"
          className="px-5 pb-1 font-mono ui-micro text-status-blocked"
        >
          {actionError}
        </p>
      )}
      {receipt !== null && (
        <p role="status" data-testid="schedule-action-receipt" className="px-5 pb-1 font-mono ui-micro text-text-faint">
          {t("schedules.receipt", { command: receipt.command, outcome: receipt.outcome, opId: receipt.opId })}
          {receipt.nextAction !== null ? ` · ${receipt.nextAction}` : ""}
        </p>
      )}
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 pb-6 pt-1" data-testid="schedules-matrix">
        {pending ? (
          <Empty>{t("schedules.loading")}</Empty>
        ) : rows.length === 0 ? (
          <Empty>{t("schedules.empty")}</Empty>
        ) : visible.length === 0 ? (
          <Empty>{t("schedules.list.emptyFiltered")}</Empty>
        ) : (
          <>
            {tiers.normalSize === "large" ? (
              // 两档同为大卡时连成一个网格,需要关注的排在前面,不另起组标题。
              tiers.attention.length + tiers.normal.length > 0 && (
                <SummaryCardGroup size="large">
                  {[...tiers.attention, ...tiers.normal].map((row) => card(row, "large"))}
                </SummaryCardGroup>
              )
            ) : (
              <>
                {tiers.attention.length > 0 && (
                  <SummaryCardGroup
                    size="large"
                    title={t("schedules.list.filter.attn")}
                    count={tiers.attention.length}
                    testId="schedules-tier-attention"
                  >
                    {tiers.attention.map((row) => card(row, "large"))}
                  </SummaryCardGroup>
                )}
                {tiers.normal.length > 0 && (
                  <SummaryCardGroup
                    size="small"
                    title={t("schedules.list.tierNormal")}
                    count={tiers.normal.length}
                    testId="schedules-tier-normal"
                  >
                    {tiers.normal.map((row) => card(row, "small"))}
                  </SummaryCardGroup>
                )}
              </>
            )}
            {tiers.paused.length > 0 && (
              <div>
                <CompletedDivider>{t("schedules.list.pausedDivider", { count: tiers.paused.length })}</CompletedDivider>
                <SummaryCardGroup size="tile" testId="schedules-tier-paused">
                  {tiers.paused.map((row) => (
                    <SummaryCard
                      key={row.scheduleId}
                      size="tile"
                      testId={`schedule-row-${row.scheduleId}`}
                      title={row.name}
                      subtitle={triggerLabel(row.trigger)}
                      onOpen={() => onOpen(row.scheduleId)}
                    />
                  ))}
                </SummaryCardGroup>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 结论段的标签:上次失败红、健康降级琥珀、正常绿、从未运行灰。 */
const VERDICT_TAG: Record<
  ReturnType<typeof scheduleVerdict>,
  { readonly tone: StatusTone; readonly label: MessageKey }
> = {
  failed: { tone: "bad", label: "schedules.outcome.failed" },
  degraded: { tone: "wait", label: "schedules.health.degraded" },
  ok: { tone: "done", label: "schedules.verdict.ok" },
  never: { tone: "neutral", label: "schedules.verdict.never" },
};

function ScheduleCard({
  row,
  size,
  now,
  busy,
  agentName,
  onOpen,
  onRunNow,
}: {
  readonly row: ScheduleGuiRowDto;
  readonly size: "large" | "small";
  readonly now: number;
  readonly busy: boolean;
  readonly agentName: (agentId: string) => string;
  readonly onOpen: (scheduleId: string) => void;
  readonly onRunNow: (row: ScheduleGuiRowDto) => void;
}) {
  const { health, missed, lastRun } = row,
    history = <RunHistory scheduleId={row.scheduleId} outcomes={health.recent} />;
  if (size === "small")
    return (
      <SummaryCard
        size="small"
        testId={`schedule-row-${row.scheduleId}`}
        title={row.name}
        subtitle={triggerLabel(row.trigger)}
        onOpen={() => onOpen(row.scheduleId)}
      >
        {history}
        <p className="truncate text-text-faint ui-meta">
          {row.activeRun !== null
            ? t("schedules.activeRun")
            : row.nextRunAt === null
              ? "—"
              : t("schedules.card.next", { time: dayClock(row.nextRunAt, now) })}
        </p>
      </SummaryCard>
    );
  const verdict = scheduleVerdict(row),
    lastAt = lastRun === null ? null : t("schedules.card.lastAt", { time: dayClock(lastRun.endedAt, now, "named") }),
    // 健康降级可能只因为错过运行:没有失败时不写「近 N 次失败 0」,错过数在历史条下面报。
    verdictText =
      verdict === "degraded" && health.failedCount > 0
        ? [t("schedules.card.recentFailed", { runs: health.recent.length, failed: health.failedCount }), lastAt]
            .filter((part) => part !== null)
            .join(" · ")
        : (lastAt ?? undefined),
    // `lastFailureDetail` 是最近一次失败的详情:上次运行就是失败时直接给,否则写明是「最近一次
    // 失败」的。是人能读的文字就给出来;是 artifact 引用就不显示引用本身。
    inDetail = health.lastFailureDetail?.startsWith("artifact:") === true,
    failureDetail =
      verdict === "ok" || verdict === "never" || health.lastFailureDetail === null
        ? null
        : verdict === "failed"
          ? inDetail
            ? t("schedules.card.failureInDetail")
            : health.lastFailureDetail
          : inDetail
            ? t("schedules.card.lastFailureInDetail")
            : t("schedules.card.lastFailure", { detail: health.lastFailureDetail }),
    until = row.nextRunAt === null ? null : untilLabel(row.nextRunAt, now),
    { target } = row;
  return (
    <SummaryCard
      size="large"
      testId={`schedule-row-${row.scheduleId}`}
      title={row.name}
      subtitle={triggerLabel(row.trigger)}
      // 竖线:上次失败红,健康降级、有错过或执行目标不可用琥珀,正常不加。
      tone={
        verdict === "failed"
          ? "bad"
          : verdict === "degraded" || missed.count > 0 || row.targetState !== undefined
            ? "wait"
            : undefined
      }
      onOpen={() => onOpen(row.scheduleId)}
      action={
        <Button
          size="sm"
          testId={`schedule-run-now-${row.scheduleId}`}
          disabled={busy || !row.actions.runNow.available}
          tip={
            row.actions.runNow.available
              ? undefined
              : (row.actions.runNow.nextAction ?? row.actions.runNow.code ?? undefined)
          }
          onClick={() => onRunNow(row)}
        >
          <Play weight="bold" aria-hidden />
          {t("schedules.action.runNow")}
        </Button>
      }
    >
      <div data-testid={`schedule-verdict-${row.scheduleId}`} className="space-y-1.5">
        {row.activeRun !== null && <CardReason tone="active" label={t("schedules.activeRun")} />}
        <CardReason tone={VERDICT_TAG[verdict].tone} label={t(VERDICT_TAG[verdict].label)}>
          {verdictText}
        </CardReason>
        {failureDetail !== null && <p className="line-clamp-2 break-words text-text-muted ui-meta">{failureDetail}</p>}
      </div>
      {health.recent.length > 0 && (
        <div className="space-y-1">
          {history}
          {(health.failedCount > 0 || missed.count > 0) && (
            <p className="text-text-faint ui-meta">
              {/* 为 0 的计数不显示。 */}
              {[
                health.failedCount > 0 ? t("schedules.card.failedCount", { count: health.failedCount }) : null,
                missed.count > 0
                  ? t("schedules.missedCount", { count: missed.count }) +
                    (missed.lastMissedReason === null
                      ? ""
                      : t("schedules.card.missedReason", { reason: missedReasonLabel(missed.lastMissedReason) }))
                  : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </p>
          )}
        </div>
      )}
      {/* 两格放不下时上下叠放。 */}
      <div className="flex flex-wrap gap-x-10 gap-y-2">
        <div className="min-w-0">
          <p className="text-text-faint ui-meta">{t("schedules.fields.nextRun")}</p>
          <p className="font-mono tabular-nums text-text ui-body">
            {row.nextRunAt === null ? "—" : dayClock(row.nextRunAt, now)}
          </p>
          {until !== null && <p className="text-text-faint ui-meta">{until}</p>}
        </div>
        <div className="min-w-0 flex-1 basis-40">
          <p className="text-text-faint ui-meta">{t("schedules.card.executor")}</p>
          <p className="break-words text-text ui-body">
            {target.kind === "agent"
              ? agentName(target.agentId)
              : target.kind === "squad"
                ? target.squadId
                : target.kind === "builtin"
                  ? target.builtinId
                  : "—"}
          </p>
          {target.kind === "agent" && target.model !== null && (
            <p className="font-mono text-text-faint ui-meta">{target.model}</p>
          )}
          {target.kind === "builtin" && (
            <p className="text-text-faint ui-meta">
              {t("schedules.executor.builtin")} · {t("schedules.builtin.preset")}
            </p>
          )}
          {row.targetState !== undefined && (
            <p data-tip={row.targetError?.hint} className="text-status-blocked ui-meta">
              {t(TARGET_STATE_KEY[row.targetState])}
            </p>
          )}
          {row.executionAvailability !== "local" && (
            <p className="text-status-submitted ui-meta">{t(AVAILABILITY_NOTE[row.executionAvailability])}</p>
          )}
        </div>
      </div>
      {row.mission.trim() !== "" && <p className="line-clamp-2 break-words text-text-faint ui-meta">{row.mission}</p>}
    </SummaryCard>
  );
}

/** 运行历史条:每次结果一个实心色块,旧 → 新;失败与错过红,成功绿,运行中青。 */
function RunHistory({
  scheduleId,
  outcomes,
}: {
  readonly scheduleId: string;
  readonly outcomes: readonly ScheduleRunOutcomeWord[];
}) {
  if (outcomes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="text-text-faint ui-meta">{t("schedules.card.recentRuns", { count: outcomes.length })}</span>
      <span className="flex flex-wrap items-center gap-1" data-testid={`schedule-spark-${scheduleId}`}>
        {outcomes.map((outcome, index) => (
          <span
            key={`${index}-${outcome}`}
            title={t(RUN_OUTCOME_META[outcome].key)}
            data-outcome={outcome}
            className="h-5 w-3.5 rounded-xs"
            style={{ background: outcome === "missed" ? SPARK_COLOR.failed : SPARK_COLOR[outcome] }}
          />
        ))}
      </span>
    </div>
  );
}
