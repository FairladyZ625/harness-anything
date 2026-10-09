import type {
  AgentRuntimeTokenUsageAgentRow,
  AgentRuntimeTokenUsageModelRow,
  AgentRuntimeTokenUsageSquadRow,
} from "@harness-anything/daemon/protocol";
import { preciseTokens, exactTokens, percentText, usdText } from "../../token-format.ts";
import {
  rankBarShare,
  rankLogFloor,
  successRate,
  tokenComposition,
  tokenKindColor,
  tokenKinds,
  tokensPerSuccess,
  usageIsUnreported,
  usageIsUnpriced,
  type RankScale,
} from "../../token-usage-model.ts";
import { t } from "../../i18n/index.tsx";
import { Empty } from "../primitives/Empty.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";

/**
 * 「谁花的」排行(单 Worker / 小队 / 模型):每行名称完整一行,数值与占比并排在右,下面一根
 * 条。条按三类 token 分段(与全页同色);条长可切对数刻度 —— 量级差上百倍时线性条会把小的
 * 全压成一根线,对数条只表示量级,准确的数在右侧。Worker 与小队的行可点进成员详情;
 * 模型没有详情读面,行不可点。「未上报」成员显示徽标而不是 0。
 */

export type RankingRow = (
  | AgentRuntimeTokenUsageAgentRow
  | AgentRuntimeTokenUsageSquadRow
  | AgentRuntimeTokenUsageModelRow
) & {
  readonly id: string;
  readonly name: string;
};

export function UsageRanking({
  rows,
  total,
  scale,
  onSelect,
}: {
  readonly rows: readonly RankingRow[];
  /** 窗口总量:占比的分母(排行行是归因视图,各行之和不一定等于它)。 */
  readonly total: number;
  readonly scale: RankScale;
  readonly onSelect?: (row: RankingRow) => void;
}) {
  if (rows.length === 0) return <Empty>{t("agentRuntime.tokenUsageEmpty")}</Empty>;
  const peak = Math.max(...rows.map(({ totalTokens }) => totalTokens)),
    floor = rankLogFloor(rows.map(({ totalTokens }) => totalTokens));
  return (
    <ol data-testid="token-usage-ranking" className="bounded-content overflow-y-auto">
      {rows.map((row) => {
        const unreported = usageIsUnreported(row),
          parts = tokenComposition(row),
          body = (
            <>
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate ui-body text-text" title={row.id}>
                  {row.name}
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
                    <span className="font-mono tabular-nums ui-body text-text" title={exactTokens(row.totalTokens)}>
                      {preciseTokens(row.totalTokens)}
                    </span>
                    <span className="w-11 text-right font-mono tabular-nums ui-meta text-text-faint">
                      {percentText(total > 0 ? row.totalTokens / total : 0)}
                    </span>
                  </>
                )}
              </span>
              <span className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-text/8" aria-hidden="true">
                <span
                  className="flex h-full gap-px transition-[width] duration-200"
                  style={{ width: `${rankBarShare(row.totalTokens, peak, floor, scale) * 100}%` }}
                >
                  {tokenKinds.map((kind) =>
                    parts[kind] > 0 ? (
                      <span
                        key={kind}
                        className="h-full first:rounded-l-full last:rounded-r-full"
                        style={{ flexGrow: parts[kind], flexBasis: 0, background: tokenKindColor[kind] }}
                      />
                    ) : null,
                  )}
                </span>
              </span>
              <span className="mt-1 block truncate ui-meta text-text-faint">
                {t("agentRuntime.tokenUsageRankMeta", {
                  sessions: String(row.sessionCount),
                  tools: String(row.toolCallCount),
                })}
                {usageIsUnpriced(row) ? (
                  <span className="ml-1.5 text-status-submitted">{t("agentRuntime.tokenUsageCostNoPrice")}</span>
                ) : (
                  <span className="ml-1.5 font-mono tabular-nums">{usdText(row.costUsd)}</span>
                )}
              </span>
            </>
          ),
          className = "block w-full border-t border-border px-3.5 py-2.5 text-left first:border-t-0";
        return (
          <li key={row.id}>
            {onSelect === undefined ? (
              <div data-testid={`token-usage-rank-${row.id}`} className={className}>
                {body}
              </div>
            ) : (
              <button
                type="button"
                data-testid={`token-usage-rank-${row.id}`}
                onClick={() => onSelect(row)}
                title={t("agentRuntime.tokenUsageOpenDetail", { name: row.name })}
                className={`${className} cursor-pointer hover:bg-text/5 focus-visible:bg-text/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent`}
              >
                {body}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 排行的表格等价视图:同一批行、同一排序,补齐全部计数列与成功率、单位产出。 */
export function UsageRankingTable({
  rows,
  onSelect,
  testId,
}: {
  readonly rows: readonly RankingRow[];
  readonly onSelect?: (row: RankingRow) => void;
  readonly testId: string;
}) {
  if (rows.length === 0) return <Empty>{t("agentRuntime.tokenUsageEmpty")}</Empty>;
  const head = "border-b border-border pb-1.5 pr-3 text-right font-normal",
    cell = "border-b border-border py-1.5 pr-3 text-right font-mono tabular-nums ui-meta";
  return (
    <div className="bounded-content overflow-auto px-3.5 pb-2">
      <table data-testid={testId} className="w-full border-separate border-spacing-0">
        <thead>
          <tr className="text-left ui-meta text-text-faint">
            <th className="border-b border-border pb-1.5 pr-3 font-normal">{t("agentRuntime.tokenUsageColName")}</th>
            <th className={head}>{t("agentRuntime.tokenUsageColSessions")}</th>
            <th className={head}>{t("agentRuntime.tokenUsageColInput")}</th>
            <th className={head}>{t("agentRuntime.tokenUsageColCacheRead")}</th>
            <th className={head}>{t("agentRuntime.tokenUsageColOutput")}</th>
            <th className={head}>{t("agentRuntime.tokenUsageColTotal")}</th>
            <th className={head}>{t("agentRuntime.tokenUsageColCost")}</th>
            <th className={head}>{t("agentRuntime.tokenUsageColTools")}</th>
            <th className={head}>{t("agentRuntime.tokenUsageColSuccessRate")}</th>
            <th className={head}>{t("agentRuntime.tokenUsageColPerSuccess")}</th>
            <th className="border-b border-border pb-1.5 text-right font-normal">
              {t("agentRuntime.tokenUsageColUsage")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rate = successRate(row),
              perSuccess = tokensPerSuccess(row);
            return (
              <tr
                key={row.id}
                data-testid={`token-usage-row-${row.id}`}
                className={onSelect === undefined ? "hover:bg-text/5" : "cursor-pointer hover:bg-text/5"}
                onClick={onSelect === undefined ? undefined : () => onSelect(row)}
              >
                <td className="border-b border-border py-1.5 pr-3 ui-meta">
                  <span className="font-[550] text-text">{row.name}</span>
                  {row.id === row.name ? null : <span className="ml-1.5 font-mono text-text-faint">{row.id}</span>}
                </td>
                <td className={cell}>{row.sessionCount}</td>
                <td className={cell} title={exactTokens(row.inputTokens)}>
                  {preciseTokens(row.inputTokens)}
                </td>
                <td className={cell} title={exactTokens(row.cacheReadTokens)}>
                  {preciseTokens(row.cacheReadTokens)}
                </td>
                <td className={cell} title={exactTokens(row.outputTokens)}>
                  {preciseTokens(row.outputTokens)}
                </td>
                <td className={`${cell} font-semibold text-text`} title={exactTokens(row.totalTokens)}>
                  {preciseTokens(row.totalTokens)}
                </td>
                <td className={cell}>
                  {usageIsUnpriced(row) ? (
                    <span className="text-status-submitted">{t("agentRuntime.tokenUsageCostNoPrice")}</span>
                  ) : (
                    usdText(row.costUsd)
                  )}
                </td>
                <td className={cell}>{row.toolCallCount}</td>
                <td className={cell}>{rate === null ? "—" : percentText(rate)}</td>
                <td className={cell} title={perSuccess === null ? undefined : exactTokens(perSuccess)}>
                  {perSuccess === null ? "—" : preciseTokens(perSuccess)}
                </td>
                <td className="border-b border-border py-1.5 text-right">
                  {usageIsUnreported(row) ? (
                    <StatusTag
                      status="cancelled"
                      mono
                      tip={t("agentRuntime.tokenUsageUnreportedTip")}
                      label={t("agentRuntime.tokenUsageUnreported")}
                    />
                  ) : (
                    <span className="font-mono ui-meta text-text-faint">
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
    </div>
  );
}
