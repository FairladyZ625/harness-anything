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
  usageIsUnpriced,
  usageIsUnreported,
  wastedSpend,
} from "../../token-usage-model.ts";
import { t } from "../../i18n/index.tsx";
import { Region } from "../primitives/Region.tsx";

/**
 * 页首结论区:两个对称主指标(左 token 量、右 API 折算计价)是同一网格行里的两列——
 * 同 44px 主数字、同基线、同列宽,各自的环比徽章与一行说明落在同一位置;金额侧的口径
 * (公开价折算、非实际花费、价格表版本、未计价占比、下界说明)与缓存写口径收进两列下方
 * 一处可折叠的「口径」说明,不再把任何一侧撑高。整卡共用一组分栏线:主指标两列、构成
 * 图例四格、关键数字四栏在 ≥560px 容器下同 breakpoint 同 gap,分栏线互相重合。有派工
 * 未上报用量时明说总量是下界。
 */
export function UsageHeadline({ data }: { readonly data: AgentRuntimeTokenUsageResult }) {
  const { totals, previous } = data,
    parts = tokenComposition(totals),
    change = periodChange(totals.totalTokens, previous.totals.totalTokens),
    costChange = periodChange(totals.costUsd, previous.totals.costUsd),
    hitRate = cacheHitRate(totals),
    wasted = wastedSpend(data.outcomes),
    previousLabel = t(tokenUsagePreviousKey[data.range]),
    unpriced = unpricedShare(totals);
  return (
    <Region title={t("agentRuntime.tokenUsageHeadlineTitle")} padded>
      <div className="grid grid-cols-2 gap-x-6 pt-1 @[560px]:grid-cols-4">
        <div className="col-span-2 min-w-0 @[560px]:col-span-2" data-testid="token-usage-totals">
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
        </div>
        <div className="col-span-2 min-w-0 @[560px]:col-span-2" data-testid="token-usage-cost">
          <p
            className="font-mono text-[44px] font-semibold leading-none tracking-[-0.01em] tabular-nums text-text"
            title={usageIsUnpriced(totals) ? undefined : `$${totals.costUsd.toFixed(4)}`}
          >
            {usageIsUnpriced(totals) ? (
              <span className="font-sans text-[28px] font-semibold leading-none text-status-submitted">
                {t("agentRuntime.tokenUsageCostNoPrice")}
              </span>
            ) : (
              usdText(totals.costUsd)
            )}
            <span className="ml-2 font-sans ui-body font-normal tracking-normal text-text-faint">
              {t("agentRuntime.tokenUsageCostMetricUnit")}
            </span>
          </p>
          <p data-testid="token-usage-cost-change" className="mt-2.5 flex flex-wrap items-center gap-x-2 ui-meta">
            {costChange === null ? (
              <span className="text-text-faint">
                {t("agentRuntime.tokenUsageCostChangeNoBase", { previous: previousLabel })}
              </span>
            ) : (
              <>
                <span className="inline-flex items-center gap-0.5 rounded-xs bg-text/8 px-1.5 py-px font-mono font-semibold tabular-nums text-text">
                  {costChange >= 0 ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
                  {percentText(Math.abs(costChange))}
                </span>
                <span className="text-text-muted">
                  {t(
                    costChange >= 0 ? "agentRuntime.tokenUsageCostChangeUp" : "agentRuntime.tokenUsageCostChangeDown",
                    {
                      previous: previousLabel,
                      cost: usdText(previous.totals.costUsd),
                    },
                  )}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="col-span-2 mt-4 @[560px]:col-span-4" data-testid="token-usage-composition">
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
          <dl className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-2 @[560px]:grid-cols-4">
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
        </div>
        {/* 口径收进一处:可见摘要保留「非实际花费」与价格表版本(以及数据驱动的未计价
            占比),长说明(下界、缓存写口径与实测计数)默认折叠,展开体限 88ch 阅读宽。 */}
        <details data-testid="token-usage-methodology" className="col-span-2 mt-2.5 ui-meta @[560px]:col-span-4">
          <summary className="flex flex-wrap items-baseline gap-x-1.5 text-text-faint">
            <span className="font-semibold text-text-muted">{t("agentRuntime.tokenUsageMethodologyLabel")}</span>
            <span className="text-text-muted">{t("agentRuntime.tokenUsageCostConverted")}</span>
            <span>{t("agentRuntime.tokenUsageCostVersion", { version: data.pricing.version })}</span>
            {unpriced !== null && unpriced > 0 ? (
              <span className="text-status-submitted">
                {t("agentRuntime.tokenUsageCostUnpriced", {
                  share: percentText(unpriced),
                  tokens: preciseTokens(totals.unpricedTokens),
                })}
              </span>
            ) : null}
          </summary>
          <div className="mt-1.5 grid max-w-[88ch] gap-1.5">
            <p data-testid="token-usage-cost-precision" className="text-text-faint">
              {t("agentRuntime.tokenUsageCostPrecision")}
            </p>
            <p data-testid="token-usage-cache-write-note" className="text-text-faint">
              {t("agentRuntime.tokenUsageCacheWriteNote")}
              {totals.cacheWriteUnreportedDispatches > 0 ? (
                <span className="ml-1">
                  {t("agentRuntime.tokenUsageCacheWriteUnreportedCount", {
                    count: String(totals.cacheWriteUnreportedDispatches),
                  })}
                </span>
              ) : null}
              {totals.cacheWriteUnitemizedDispatches > 0 ? (
                <span className="ml-1">
                  {t("agentRuntime.tokenUsageCacheWriteUnitemizedCount", {
                    count: String(totals.cacheWriteUnitemizedDispatches),
                  })}
                </span>
              ) : null}
            </p>
          </div>
        </details>
      </div>
      {totals.usageUnavailableDispatches > 0 ? (
        <p data-testid="token-usage-conclusion" className="mt-3 ui-meta text-status-submitted">
          {t(usageIsUnreported(totals) ? "agentRuntime.tokenUsageFloorAll" : "agentRuntime.tokenUsageFloorSome", {
            count: String(totals.usageUnavailableDispatches),
          })}
        </p>
      ) : null}
      <div
        data-testid="token-usage-figures"
        className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-3 @[560px]:grid-cols-4"
      >
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
