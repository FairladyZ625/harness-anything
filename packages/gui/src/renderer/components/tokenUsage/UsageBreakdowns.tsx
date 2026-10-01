import { useState } from "react";
import type {
  AgentRuntimeTokenUsageAgentRow,
  AgentRuntimeTokenUsageResult,
  AgentRuntimeTokenUsageSessionBin,
} from "@harness-anything/daemon/protocol";
import { preciseTokens, exactTokens, percentText } from "../../token-format.ts";
import { formatDuration } from "../../model/time.ts";
import {
  sessionBinLabel,
  successRate,
  tokensPerSuccess,
  usageOutcomeColor,
  usageOutcomeKey,
  wastedSpend,
} from "../../token-usage-model.ts";
import { t } from "../../i18n/index.tsx";
import { StatusTag, type StatusTone } from "../primitives/StatusTag.tsx";
import { Empty } from "../runtime/parts.tsx";

/**
 * Token 消耗页的三块分析:花在什么事上(任务 / 工作)、单个会话的情况(统计、规模分布、
 * 最大的几个会话)、值不值(按结果分的花费、每个 Worker 的成功率与单位产出、未上报的
 * provider)。数据都来自同一次聚合读,这里只做展示。
 */

const OUTCOME_TONE: Readonly<Record<AgentRuntimeTokenUsageResult["outcomes"][number]["outcome"], StatusTone>> = {
  succeeded: "done",
  failed: "bad",
  aborted: "cancel",
  running: "active",
  unknown: "neutral",
};
const rowClass = "block w-full border-t border-border px-3.5 py-2.5 text-left first:border-t-0";
const linkRowClass = `${rowClass} cursor-pointer hover:bg-text/5 focus-visible:bg-text/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent`;

/** 一根占比条:长度即占窗口总量的比例。 */
function ShareBar({ share, color }: { readonly share: number; readonly color: string }) {
  return (
    <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-text/8" aria-hidden="true">
      <span
        className="block h-full rounded-full transition-[width] duration-200"
        style={{ width: `${Math.min(1, share) * 100}%`, minWidth: share > 0 ? 2 : 0, background: color }}
      />
    </span>
  );
}

/** 花在什么事上:消耗最多的任务或工作,标题可点进任务详情(工作点进它的根任务)。 */
export function UsageSpend({
  data,
  scope,
  onOpenTask,
}: {
  readonly data: AgentRuntimeTokenUsageResult;
  readonly scope: "tasks" | "works";
  readonly onOpenTask: (taskId: string) => void;
}) {
  const total = data.totals.totalTokens,
    rows =
      scope === "tasks"
        ? data.tasks.map((row) => ({
            id: row.taskId,
            title: row.title,
            note:
              row.workId !== null && row.workId !== row.taskId
                ? t("agentRuntime.tokenUsageSpendTaskNote", {
                    work: row.workTitle ?? row.workId,
                    sessions: String(row.sessionCount),
                  })
                : t("agentRuntime.tokenUsageSpendSessions", { sessions: String(row.sessionCount) }),
            totalTokens: row.totalTokens,
          }))
        : data.works.map((row) => ({
            id: row.workId,
            title: row.title,
            note: t("agentRuntime.tokenUsageSpendWorkNote", {
              tasks: String(row.taskCount),
              sessions: String(row.sessionCount),
            }),
            totalTokens: row.totalTokens,
          }));
  if (rows.length === 0) return <Empty>{t("agentRuntime.tokenUsageSpendEmpty")}</Empty>;
  return (
    <ol data-testid={`token-usage-spend-${scope}`} className="max-h-[440px] overflow-y-auto">
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            data-testid={`token-usage-spend-${row.id}`}
            onClick={() => onOpenTask(row.id)}
            title={row.id}
            className={linkRowClass}
          >
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate ui-body text-text">{row.title}</span>
              <span className="font-mono tabular-nums ui-body text-text" title={exactTokens(row.totalTokens)}>
                {preciseTokens(row.totalTokens)}
              </span>
              <span className="w-11 text-right font-mono tabular-nums ui-meta text-text-faint">
                {percentText(total > 0 ? row.totalTokens / total : 0)}
              </span>
            </span>
            <ShareBar share={total > 0 ? row.totalTokens / total : 0} color="var(--color-accent)" />
            <span className="mt-1 block truncate ui-meta text-text-faint">{row.note}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** 单个会话的情况:四个统计数、规模分布、最大的几个会话。 */
export function UsageSessions({
  data,
  onSelectEntity,
}: {
  readonly data: AgentRuntimeTokenUsageResult;
  readonly onSelectEntity: (ref: string) => void;
}) {
  const stats = data.sessions;
  if (data.totals.sessionCount === 0) return <Empty>{t("agentRuntime.tokenUsageEmpty")}</Empty>;
  return (
    <div data-testid="token-usage-sessions">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-3.5 pb-3 @[520px]:grid-cols-4">
        {(
          [
            ["agentRuntime.tokenUsageSessionAverage", stats.averageTokens],
            ["agentRuntime.tokenUsageSessionMedian", stats.medianTokens],
            ["agentRuntime.tokenUsageSessionP90", stats.p90Tokens],
            ["agentRuntime.tokenUsageSessionMax", stats.maxTokens],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="truncate ui-meta text-text-muted">{t(label)}</dt>
            <dd className="font-mono ui-title font-semibold tabular-nums text-text" title={exactTokens(value)}>
              {preciseTokens(value)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="px-3.5 pb-3 ui-meta text-text-faint">
        {t("agentRuntime.tokenUsageSessionBasis", {
          reported: String(stats.reportedSessions),
          duration: formatDuration(stats.averageDurationMs),
          tools: String(stats.averageToolCalls),
        })}
      </p>
      <SessionDistribution bins={stats.distribution} totalTokens={data.totals.totalTokens} />
      {stats.top.length > 0 ? (
        <>
          <p className="border-t border-border px-3.5 pt-2.5 pb-1 ui-meta font-semibold text-text-muted">
            {t("agentRuntime.tokenUsageSessionTopTitle")}
          </p>
          <ol data-testid="token-usage-top-sessions" className="max-h-[300px] overflow-y-auto">
            {stats.top.map((session) => {
              const multiple = stats.medianTokens > 0 ? session.totalTokens / stats.medianTokens : 0;
              return (
                <li key={session.runtimeSessionId}>
                  <button
                    type="button"
                    data-testid={`token-usage-top-session-${session.runtimeSessionId}`}
                    onClick={() => onSelectEntity(`session/${session.runtimeSessionId}`)}
                    title={t("agentRuntime.tokenUsageOpenSession")}
                    className={linkRowClass}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate ui-body text-text">
                        {session.taskTitle ?? session.taskId ?? session.runtimeSessionId}
                      </span>
                      {/* 中位数的 10 倍以上才算离群:标出来,免得一眼把它当成常态。 */}
                      {multiple >= 10 ? (
                        <span className="rounded-xs bg-status-submitted/15 px-1.5 py-px font-mono ui-meta font-semibold tabular-nums text-status-submitted">
                          {t("agentRuntime.tokenUsageSessionOutlier", { multiple: String(Math.round(multiple)) })}
                        </span>
                      ) : null}
                      <span
                        className="font-mono tabular-nums ui-body text-text"
                        title={exactTokens(session.totalTokens)}
                      >
                        {preciseTokens(session.totalTokens)}
                      </span>
                    </span>
                    <span className="mt-1 flex items-center gap-2 ui-meta text-text-faint">
                      <StatusTag tone={OUTCOME_TONE[session.outcome]} label={t(usageOutcomeKey[session.outcome])} />
                      <span className="min-w-0 truncate">
                        {[
                          session.agentName ?? session.agentId,
                          session.model,
                          formatDuration(session.durationMs),
                          t("agentRuntime.tokenUsageSessionTools", { tools: String(session.toolCallCount) }),
                        ]
                          .filter((part) => part !== null && part !== "—")
                          .join(" · ")}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </div>
  );
}

/**
 * 会话规模分布:固定六档的柱(柱高 = 会话数),柱下的细条是这一档花掉的 token 占总量的
 * 比例 —— 多数会话在哪一档、钱又主要花在哪一档,两件事并排看。悬停或聚焦一档给出准确的数。
 */
function SessionDistribution({
  bins,
  totalTokens,
}: {
  readonly bins: readonly AgentRuntimeTokenUsageSessionBin[];
  readonly totalTokens: number;
}) {
  const sessions = bins.reduce((sum, bin) => sum + bin.sessionCount, 0),
    peak = Math.max(...bins.map(({ sessionCount }) => sessionCount), 1),
    busiest = bins.reduce((best, bin, index) => (bin.sessionCount > bins[best]!.sessionCount ? index : best), 0),
    [active, setActive] = useState<number | null>(null),
    shown = active ?? busiest,
    labelOf = (index: number): string =>
      sessionBinLabel(bins[index]!.ceiling, index === 0 ? 0 : (bins[index - 1]!.ceiling ?? 0), preciseTokens),
    bin = bins[shown]!;
  return (
    <div data-testid="token-usage-distribution" className="px-3.5 pb-3">
      <div
        className="grid h-[116px] items-end gap-1.5"
        style={{ gridTemplateColumns: `repeat(${bins.length}, minmax(0, 1fr))` }}
        onPointerLeave={() => setActive(null)}
      >
        {bins.map((item, index) => (
          <button
            key={String(item.ceiling)}
            type="button"
            data-testid={`token-usage-bin-${index}`}
            aria-label={`${labelOf(index)}: ${item.sessionCount}`}
            onPointerEnter={() => setActive(index)}
            onFocus={() => setActive(index)}
            onBlur={() => setActive(null)}
            className="group flex h-full min-w-0 cursor-default flex-col justify-end outline-none"
          >
            <span className="mb-1 text-center font-mono tabular-nums ui-meta text-text-muted">
              {item.sessionCount > 0 ? item.sessionCount : ""}
            </span>
            <span
              className="viz-grow mx-auto block w-full max-w-9 rounded-t-[3px] group-focus-visible:ring-1 group-focus-visible:ring-accent"
              style={{
                height: `${(item.sessionCount / peak) * 76}%`,
                minHeight: item.sessionCount > 0 ? 2 : 0,
                background: "var(--color-accent)",
                opacity: shown === index ? 1 : 0.5,
              }}
            />
          </button>
        ))}
      </div>
      <div
        className="grid gap-1.5 border-t border-border pt-1.5"
        style={{ gridTemplateColumns: `repeat(${bins.length}, minmax(0, 1fr))` }}
      >
        {bins.map((item, index) => (
          <span key={String(item.ceiling)} className="min-w-0">
            <ShareBar
              share={totalTokens > 0 ? item.totalTokens / totalTokens : 0}
              color="var(--color-status-submitted)"
            />
            <span
              className={`mt-1 block truncate text-center font-mono ui-micro ${shown === index ? "text-text" : "text-text-faint"}`}
            >
              {labelOf(index)}
            </span>
          </span>
        ))}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 ui-meta text-text-faint">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-1.5 rounded-t-[2px] bg-accent" />
          {t("agentRuntime.tokenUsageDistributionSessions")}
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-1 w-3 rounded-full bg-status-submitted" />
          {t("agentRuntime.tokenUsageDistributionTokens")}
        </span>
      </p>
      <p data-testid="token-usage-distribution-readout" className="mt-1 ui-meta text-text-muted">
        {t("agentRuntime.tokenUsageDistributionReadout", {
          bin: labelOf(shown),
          sessions: String(bin.sessionCount),
          sessionShare: percentText(sessions > 0 ? bin.sessionCount / sessions : 0),
          tokens: preciseTokens(bin.totalTokens),
          tokenShare: percentText(totalTokens > 0 ? bin.totalTokens / totalTokens : 0),
        })}
      </p>
    </div>
  );
}

/** 值不值:失败或中止的会话花了多少、各结果的花费构成、每个 Worker 的成功率与单位产出。 */
export function UsageWorth({ data }: { readonly data: AgentRuntimeTokenUsageResult }) {
  const total = data.totals.totalTokens,
    wasted = wastedSpend(data.outcomes),
    spent = data.outcomes.filter(({ sessionCount }) => sessionCount > 0),
    workers = data.agents.filter((row) => successRate(row) !== null);
  if (data.totals.sessionCount === 0) return <Empty>{t("agentRuntime.tokenUsageEmpty")}</Empty>;
  return (
    <div data-testid="token-usage-worth">
      <div className="px-3.5 pb-3">
        <p className="flex flex-wrap items-baseline gap-x-2.5">
          <span
            className="font-mono ui-heading font-semibold tabular-nums"
            style={{ color: wasted.totalTokens > 0 ? "var(--color-status-blocked)" : "var(--color-status-done)" }}
          >
            {percentText(total > 0 ? wasted.totalTokens / total : 0)}
          </span>
          <span className="ui-meta text-text-muted">
            {t("agentRuntime.tokenUsageWastedSentence", {
              sessions: String(wasted.sessionCount),
              tokens: preciseTokens(wasted.totalTokens),
            })}
          </span>
        </p>
        <div className="mt-2.5 flex h-2.5 gap-0.5 overflow-hidden rounded-xs bg-text/8" aria-hidden="true">
          {spent.map((row) =>
            row.totalTokens > 0 ? (
              <span
                key={row.outcome}
                className="h-full"
                style={{
                  flexGrow: row.totalTokens,
                  flexBasis: 0,
                  minWidth: 2,
                  background: usageOutcomeColor[row.outcome],
                }}
              />
            ) : null,
          )}
        </div>
        <ul data-testid="token-usage-outcomes" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 ui-meta">
          {spent.map((row) => (
            <li key={row.outcome} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2.5 rounded-[2px]"
                style={{ background: usageOutcomeColor[row.outcome] }}
              />
              <span className="text-text-muted">{t(usageOutcomeKey[row.outcome])}</span>
              <span className="font-mono tabular-nums text-text">{row.sessionCount}</span>
              <span className="font-mono tabular-nums text-text-faint" title={exactTokens(row.totalTokens)}>
                {preciseTokens(row.totalTokens)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {workers.length > 0 ? <WorkerEfficiency workers={workers} /> : null}
    </div>
  );
}

function WorkerEfficiency({ workers }: { readonly workers: readonly AgentRuntimeTokenUsageAgentRow[] }) {
  return (
    <div className="max-h-[320px] overflow-y-auto border-t border-border">
      <table data-testid="token-usage-efficiency" className="w-full border-separate border-spacing-0">
        <thead>
          <tr className="text-left ui-meta text-text-faint">
            <th className="sticky top-0 py-2 pr-2 pl-3.5 font-normal">{t("agentRuntime.tokenUsageSegmentAgents")}</th>
            <th className="sticky top-0 py-2 pr-3 font-normal">{t("agentRuntime.tokenUsageColSuccessRate")}</th>
            <th className="sticky top-0 py-2 pr-3.5 text-right font-normal">
              {t("agentRuntime.tokenUsageColPerSuccess")}
            </th>
          </tr>
        </thead>
        <tbody>
          {workers.map((row) => {
            const rate = successRate(row) ?? 0,
              perSuccess = tokensPerSuccess(row),
              ended = row.succeededSessions + row.failedSessions + row.abortedSessions;
            return (
              <tr key={row.agentId} data-testid={`token-usage-efficiency-${row.agentId}`}>
                <td className="max-w-0 w-[46%] border-t border-border py-2 pr-2 pl-3.5">
                  <span className="block truncate ui-meta text-text" title={row.agentId}>
                    {row.agentName}
                  </span>
                </td>
                <td className="border-t border-border py-2 pr-3">
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-status-blocked/35">
                      <span className="block h-full rounded-full bg-status-done" style={{ width: `${rate * 100}%` }} />
                    </span>
                    <span
                      className="w-[88px] shrink-0 font-mono tabular-nums ui-meta text-text"
                      title={t("agentRuntime.tokenUsageSuccessTip", {
                        succeeded: String(row.succeededSessions),
                        failed: String(row.failedSessions),
                        aborted: String(row.abortedSessions),
                      })}
                    >
                      {percentText(rate)}
                      <span className="ml-1 text-text-faint">
                        {row.succeededSessions}/{ended}
                      </span>
                    </span>
                  </span>
                </td>
                <td
                  className="border-t border-border py-2 pr-3.5 text-right font-mono tabular-nums ui-meta text-text"
                  title={perSuccess === null ? undefined : exactTokens(perSuccess)}
                >
                  {perSuccess === null ? "—" : preciseTokens(perSuccess)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 未上报用量的派工:有多少、是哪些 provider,以及这个数字是什么意思。 */
export function UsageUnreported({ data }: { readonly data: AgentRuntimeTokenUsageResult }) {
  const count = data.totals.usageUnavailableDispatches,
    listed = data.unreported.reduce((sum, row) => sum + row.dispatchCount, 0);
  return (
    <div data-testid="token-usage-unreported">
      <p className="px-3.5 pb-2.5 ui-meta text-text-muted">
        {t("agentRuntime.tokenUsageUnreportedMeaning", {
          count: String(count),
          reported: String(data.totals.usageReportedDispatches),
        })}
      </p>
      <ul>
        {data.unreported.map((row) => (
          <li
            key={`${row.kindId}/${row.instanceId}`}
            className="flex items-baseline gap-2 border-t border-border px-3.5 py-2.5"
          >
            <span className="ui-body text-text">{row.kindId}</span>
            <span className="min-w-0 flex-1 truncate font-mono ui-meta text-text-faint">{row.instanceId}</span>
            <span className="font-mono tabular-nums ui-body text-text">
              {t("agentRuntime.tokenUsageUnreportedCount", { count: String(row.dispatchCount) })}
            </span>
          </li>
        ))}
        {count > listed ? (
          <li className="border-t border-border px-3.5 py-2.5 ui-meta text-text-faint">
            {t("agentRuntime.tokenUsageUnreportedMore", { count: String(count - listed) })}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
