import type { ReactNode } from "react";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import type { AgentRuntimeTokenUsageResult } from "@harness-anything/daemon/protocol";
import { preciseTokens, exactTokens, percentText, usdText } from "../../token-format.ts";
import {
  cacheHitRate,
  periodChange,
  tokenComposition,
  tokenKindColor,
  tokenKindKey,
  tokenKinds,
  tokenUsagePreviousKey,
  unpricedShare,
  usageIsUnreported,
  wastedSpend,
} from "../../token-usage-model.ts";
import { t } from "../../i18n/index.tsx";
import { Region } from "../primitives/Region.tsx";

/**
 * 页首结论区:一个大数字(这段时间一共花了多少)加环比,旁边是三类 token 的构成条,下面四个
 * 关键数字(会话、缓存命中率、白花、未上报)。金额一行紧跟大数字:按 API 公开价折算,不是
 * 实际花费;价格表版本随行,未计价用量占比注明。有派工未上报用量时明说总量是下界。
 */
export function UsageHeadline({ data }: { readonly data: AgentRuntimeTokenUsageResult }) {
  const { totals, previous } = data,
    parts = tokenComposition(totals),
    change = periodChange(totals.totalTokens, previous.totals.totalTokens),
    hitRate = cacheHitRate(totals),
    wasted = wastedSpend(data.outcomes),
    previousLabel = t(tokenUsagePreviousKey[data.range]),
    unpriced = unpricedShare(totals);
  return (
    <Region title={t("agentRuntime.tokenUsageHeadlineTitle")} padded>
      <div data-testid="token-usage-totals" className="flex flex-wrap items-end gap-x-10 gap-y-4 pt-1">
        <div className="min-w-0">
          <p
            className="font-mono text-[44px] font-semibold leading-none tracking-[-0.01em] tabular-nums text-text"
            title={exactTokens(totals.totalTokens)}
          >
            {preciseTokens(totals.totalTokens)}
            <span className="ml-2 font-sans ui-body font-normal tracking-normal text-text-faint">tokens</span>
          </p>
          <p data-testid="token-usage-change" className="mt-2.5 flex flex-wrap items-center gap-x-2 ui-meta">
            {change === null ? (
              <span className="text-text-faint">
                {t("agentRuntime.tokenUsageChangeNoBase", { previous: previousLabel })}
              </span>
            ) : (
              <>
                <span className="inline-flex items-center gap-0.5 rounded-xs bg-text/8 px-1.5 py-px font-mono font-semibold tabular-nums text-text">
                  {change >= 0 ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
                  {percentText(Math.abs(change))}
                </span>
                <span className="text-text-muted">
                  {t(change >= 0 ? "agentRuntime.tokenUsageChangeUp" : "agentRuntime.tokenUsageChangeDown", {
                    previous: previousLabel,
                    tokens: preciseTokens(previous.totals.totalTokens),
                  })}
                </span>
              </>
            )}
          </p>
          <p data-testid="token-usage-cost" className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 ui-meta">
            <span className="font-mono font-semibold tabular-nums text-text">{usdText(totals.costUsd)}</span>
            <span className="text-text-muted">{t("agentRuntime.tokenUsageCostConverted")}</span>
            <span className="text-text-faint">
              {t("agentRuntime.tokenUsageCostVersion", { version: data.pricing.version })}
            </span>
            {unpriced !== null && unpriced > 0 ? (
              <span className="text-status-submitted">
                {t("agentRuntime.tokenUsageCostUnpriced", {
                  share: percentText(unpriced),
                  tokens: preciseTokens(totals.unpricedTokens),
                })}
              </span>
            ) : null}
          </p>
        </div>
        <div className="min-w-[280px] flex-1" data-testid="token-usage-composition">
          <div className="flex h-3 gap-0.5 overflow-hidden rounded-xs bg-text/8" aria-hidden="true">
            {tokenKinds.map((kind) =>
              parts[kind] > 0 ? (
                <span
                  key={kind}
                  className="h-full"
                  style={{ flexGrow: parts[kind], flexBasis: 0, minWidth: 2, background: tokenKindColor[kind] }}
                />
              ) : null,
            )}
          </div>
          <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 @[560px]:grid-cols-4">
            {tokenKinds.map((kind) => (
              <div key={kind} className="min-w-0">
                <dt className="flex items-center gap-1.5 ui-meta text-text-muted">
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-[2px]"
                    style={{ background: tokenKindColor[kind] }}
                  />
                  <span className="truncate">{t(tokenKindKey[kind])}</span>
                </dt>
                <dd className="mt-0.5 flex items-baseline gap-1.5 font-mono tabular-nums">
                  <span className="ui-title font-semibold text-text" title={exactTokens(parts[kind])}>
                    {preciseTokens(parts[kind])}
                  </span>
                  <span className="ui-meta text-text-faint">
                    {percentText(totals.totalTokens > 0 ? parts[kind] / totals.totalTokens : 0)}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
          <p data-testid="token-usage-cache-write-note" className="mt-2 ui-meta text-text-faint">
            {t("agentRuntime.tokenUsageCacheWriteNote")}
          </p>
        </div>
      </div>
      {totals.usageUnavailableDispatches > 0 ? (
        <p data-testid="token-usage-conclusion" className="mt-3 ui-meta text-status-submitted">
          {t(usageIsUnreported(totals) ? "agentRuntime.tokenUsageFloorAll" : "agentRuntime.tokenUsageFloorSome", {
            count: String(totals.usageUnavailableDispatches),
          })}
        </p>
      ) : null}
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-3 @[720px]:grid-cols-4">
        <Figure
          label={t("agentRuntime.tokenUsageTotalsSessions")}
          value={String(totals.sessionCount)}
          note={t("agentRuntime.tokenUsageFigureSessionsNote", {
            average: preciseTokens(data.sessions.averageTokens),
            tools: String(data.sessions.averageToolCalls),
          })}
        />
        <Figure
          label={t("agentRuntime.tokenUsageFigureCacheHit")}
          value={hitRate === null ? "—" : percentText(hitRate)}
          note={t("agentRuntime.tokenUsageFigureCacheHitNote", {
            cache: preciseTokens(parts.cacheRead),
            input: preciseTokens(totals.inputTokens),
          })}
        />
        <Figure
          label={t("agentRuntime.tokenUsageFigureWasted")}
          value={percentText(totals.totalTokens > 0 ? wasted.totalTokens / totals.totalTokens : 0)}
          tone={wasted.totalTokens > 0 ? "var(--color-status-blocked)" : undefined}
          note={t("agentRuntime.tokenUsageFigureWastedNote", {
            sessions: String(wasted.sessionCount),
            tokens: preciseTokens(wasted.totalTokens),
          })}
        />
        <Figure
          label={t("agentRuntime.tokenUsageTotalsUnreported")}
          value={String(totals.usageUnavailableDispatches)}
          tone={totals.usageUnavailableDispatches > 0 ? "var(--color-status-submitted)" : undefined}
          note={t(
            totals.usageUnavailableDispatches > 0
              ? "agentRuntime.tokenUsageFigureUnreportedNote"
              : "agentRuntime.tokenUsageFigureUnreportedNone",
            { reported: String(totals.usageReportedDispatches) },
          )}
        />
      </div>
    </Region>
  );
}

function Figure({
  label,
  value,
  note,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly note: ReactNode;
  readonly tone?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="ui-meta text-text-muted">{label}</p>
      <p
        className="mt-0.5 font-mono ui-heading font-semibold leading-tight tabular-nums text-text"
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </p>
      <p className="mt-0.5 ui-meta text-text-faint">{note}</p>
    </div>
  );
}
