import { useState } from "react";
import type { AgentRuntimeTokenUsageTotals } from "@harness-anything/daemon/protocol";
import { preciseTokens, exactTokens, percentText, usdText } from "../../token-format.ts";
import { seriesColor, usageIsUnpriced, usageIsUnreported } from "../../token-usage-model.ts";
import { t } from "../../i18n/index.tsx";
import { Empty } from "../primitives/Empty.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import type { RankingRow } from "./UsageRanking.tsx";

/**
 * 「谁花的」的环形呈现:弧长 = 该成员占窗口总量的比例,口径可切 token 量 / 折算金额 ——
 * 两个数在同一图里同层级出现(环心给窗口总量与总金额,图例每行金额、token、占比并排)。
 * 环是带底的:排行是归因视图,各行之和不一定等于窗口总量,归因不到的部分留在底环上,
 * 不摊进任何成员。超过五个成员后其余合并为灰段(与分系列配色同规则)。图例行即键盘
 * 路径:聚焦一行高亮对应的弧;弧本身也可悬停。
 */

export type ShareBasis = "tokens" | "cost";

const SIZE = 148,
  CENTER = SIZE / 2,
  RADIUS = 56,
  CIRCUMFERENCE = 2 * Math.PI * RADIUS,
  NAMED_SLICES = 5,
  REST_ID = "__rest__";

/** 图例与弧共用的一条显示行:金额与 token 量是同层级的两个数。 */
interface ShareEntry {
  readonly key: string;
  readonly name: string;
  readonly title: string | undefined;
  readonly color: string;
  /** 进弧的成员才非零:弧长占窗口总量的比例,0 = 只进图例不进环。 */
  readonly arcLength: number;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly unpricedTokens: number;
  readonly usageReportedDispatches: number;
  readonly usageUnavailableDispatches: number;
  /** 成员行才有:点行打开成员详情。 */
  readonly member?: RankingRow;
}

export function UsageShareDonut({
  rows,
  totals,
  basis,
  onSelect,
}: {
  readonly rows: readonly RankingRow[];
  readonly totals: AgentRuntimeTokenUsageTotals;
  readonly basis: ShareBasis;
  readonly onSelect?: (row: RankingRow) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  if (rows.length === 0) return <Empty>{t("agentRuntime.tokenUsageEmpty")}</Empty>;
  const valueOf = (row: RankingRow): number => (basis === "tokens" ? row.totalTokens : row.costUsd),
    windowTotal = basis === "tokens" ? totals.totalTokens : totals.costUsd,
    ordered = [...rows].sort((a, b) => valueOf(b) - valueOf(a)),
    positive = ordered.filter((row) => valueOf(row) > 0),
    named = positive.slice(0, NAMED_SLICES),
    restRows = positive.slice(NAMED_SLICES),
    restValue = restRows.reduce((sum, row) => sum + valueOf(row), 0),
    arcLengthOf = (value: number): number => (windowTotal > 0 ? (value / windowTotal) * CIRCUMFERENCE : 0),
    restEntry: ShareEntry | null =
      restRows.length > 0
        ? {
            key: REST_ID,
            name: t("agentRuntime.tokenUsageSeriesRest"),
            title: undefined,
            color: seriesColor(null, named.length),
            arcLength: arcLengthOf(restValue),
            costUsd: restRows.reduce((sum, row) => sum + row.costUsd, 0),
            totalTokens: restRows.reduce((sum, row) => sum + row.totalTokens, 0),
            unpricedTokens: restRows.reduce((sum, row) => sum + row.unpricedTokens, 0),
            usageReportedDispatches: restRows.reduce((sum, row) => sum + row.usageReportedDispatches, 0),
            usageUnavailableDispatches: restRows.reduce((sum, row) => sum + row.usageUnavailableDispatches, 0),
          }
        : null,
    // 弧从 12 点钟起顺时针铺;只有进弧的成员(正值)占弧长,图例则列全部成员:零值成员
    // 也是信息(「无价格」/「未上报」),只是没有弧。
    arcOrder = new Map(
      [...named.map((row) => row.id), ...(restEntry === null ? [] : [REST_ID])].map((key, index) => [
        key,
        seriesColor(key === REST_ID ? null : key, index),
      ]),
    ),
    entries: readonly ShareEntry[] = [
      ...ordered.map((row) => ({
        key: row.id,
        name: row.name,
        title: row.id,
        color: named.includes(row) ? (arcOrder.get(row.id) as string) : seriesColor(null, named.length),
        arcLength: named.includes(row) ? arcLengthOf(valueOf(row)) : 0,
        costUsd: row.costUsd,
        totalTokens: row.totalTokens,
        unpricedTokens: row.unpricedTokens,
        usageReportedDispatches: row.usageReportedDispatches,
        usageUnavailableDispatches: row.usageUnavailableDispatches,
        member: row,
      })),
      ...(restEntry === null ? [] : [restEntry]),
    ],
    entryValue = (entry: ShareEntry): number => (basis === "tokens" ? entry.totalTokens : entry.costUsd);
  let consumed = 0;
  return (
    <div data-testid="token-usage-share" className="flex flex-wrap items-center gap-x-5 gap-y-3 px-3.5 pb-3">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={t("agentRuntime.tokenUsageShareLabel")}
        >
          <g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke="var(--color-text)"
              opacity={0.08}
              strokeWidth={16}
            />
            {entries
              .filter((entry) => entry.arcLength > 0)
              .map((entry) => {
                const offset = consumed;
                consumed += entry.arcLength;
                return (
                  <circle
                    key={entry.key}
                    data-testid={`token-usage-share-arc-${entry.key}`}
                    cx={CENTER}
                    cy={CENTER}
                    r={RADIUS}
                    fill="none"
                    stroke={entry.color}
                    strokeWidth={active === entry.key ? 19 : 16}
                    strokeDasharray={`${entry.arcLength} ${CIRCUMFERENCE - entry.arcLength}`}
                    strokeDashoffset={-offset}
                    opacity={active === null || active === entry.key ? 1 : 0.45}
                    onPointerEnter={() => setActive(entry.key)}
                    onPointerLeave={() => setActive(null)}
                  />
                );
              })}
          </g>
        </svg>
        <div
          data-testid="token-usage-share-center"
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center"
        >
          <span
            className="font-mono ui-heading font-semibold tabular-nums text-text"
            title={exactTokens(totals.totalTokens)}
          >
            {preciseTokens(totals.totalTokens)}
          </span>
          <span className="ui-micro text-text-faint">tokens</span>
          <span className="mt-0.5 font-mono ui-meta tabular-nums text-text-muted">{usdText(totals.costUsd)}</span>
        </div>
      </div>
      <ol className="min-w-[220px] flex-1">
        {entries.map((entry) => (
          <li key={entry.key}>
            <ShareLegendRow
              entry={entry}
              share={percentText(windowTotal > 0 ? entryValue(entry) / windowTotal : 0)}
              active={active === entry.key}
              onSelect={onSelect}
              onActivate={() => setActive(entry.key)}
              onDeactivate={() => setActive(null)}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 图例行:颜色、名称、金额、token、占比同一基线并排;键盘聚焦即高亮对应的弧。 */
function ShareLegendRow({
  entry,
  share,
  active,
  onSelect,
  onActivate,
  onDeactivate,
}: {
  readonly entry: ShareEntry;
  readonly share: string;
  readonly active: boolean;
  readonly onSelect?: (row: RankingRow) => void;
  readonly onActivate: () => void;
  readonly onDeactivate: () => void;
}) {
  const unreported = usageIsUnreported(entry),
    openable = onSelect !== undefined && entry.member !== undefined,
    className =
      "flex w-full items-baseline gap-x-2 border-t border-border px-1 py-1.5 text-left first:border-t-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent";
  const body = (
      <>
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 self-center rounded-[2px]"
          style={entry.arcLength > 0 ? { background: entry.color } : { boxShadow: `inset 0 0 0 1px ${entry.color}` }}
        />
        <span className="min-w-0 flex-1 truncate ui-meta text-text" title={entry.title}>
          {entry.name}
        </span>
        {unreported ? (
          <StatusTag
            status="cancelled"
            mono
            tip={t("agentRuntime.tokenUsageUnreportedTip")}
            label={t("agentRuntime.tokenUsageUnreported")}
          />
        ) : (
          <>
            {usageIsUnpriced(entry) ? (
              <span className="text-status-submitted">{t("agentRuntime.tokenUsageCostNoPrice")}</span>
            ) : (
              <span
                className="font-mono tabular-nums ui-meta text-text-muted"
                title={t("agentRuntime.tokenUsageColCost")}
              >
                {usdText(entry.costUsd)}
              </span>
            )}
            <span className="font-mono tabular-nums ui-meta text-text" title={exactTokens(entry.totalTokens)}>
              {preciseTokens(entry.totalTokens)}
            </span>
            <span className="w-11 text-right font-mono tabular-nums ui-meta text-text-faint">{share}</span>
          </>
        )}
      </>
    ),
    activeClass = active ? " bg-text/5" : "",
    handlers = {
      onPointerEnter: onActivate,
      onPointerLeave: onDeactivate,
      onFocus: onActivate,
      onBlur: onDeactivate,
    };
  return openable ? (
    <button
      type="button"
      data-testid={`token-usage-share-row-${entry.key}`}
      aria-pressed={active}
      onClick={() => onSelect!(entry.member!)}
      title={t("agentRuntime.tokenUsageOpenDetail", { name: entry.name })}
      className={`${className}${activeClass} cursor-pointer`}
      {...handlers}
    >
      {body}
    </button>
  ) : (
    <div
      data-testid={`token-usage-share-row-${entry.key}`}
      tabIndex={0}
      className={`${className}${activeClass}`}
      {...handlers}
    >
      {body}
    </div>
  );
}
