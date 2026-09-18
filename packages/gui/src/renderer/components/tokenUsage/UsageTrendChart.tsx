import type { AgentRuntimeTokenUsageBucket } from "../../../../../daemon/src/agent-runtime-token-usage.ts";
import { compactTokens, exactTokens } from "../../token-format.ts";
import { bucketAxisLabel } from "../../token-usage-model.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 消耗趋势图(手写 SVG):输入/缓存读取/输出三段堆叠柱,按 daemon 侧时间桶排布。
 * 每根柱带 `<title>` 精确值与柱顶紧凑总量(文字等价物);同卡片可切表格视图。
 * 无动效 —— 数据刷新直接换柱,不引入过渡。
 */

const LAYER_COLORS = {
  input: "var(--color-status-active)",
  cacheRead: "var(--color-status-planned)",
  output: "var(--color-accent)",
} as const;

const BAR_WIDTH = 26,
  BAR_GAP = 8,
  CHART_HEIGHT = 132,
  AXIS_HEIGHT = 18,
  GRID_COUNT = 2;

export function UsageTrendChart({
  buckets,
  bucketMs,
}: {
  readonly buckets: readonly AgentRuntimeTokenUsageBucket[];
  readonly bucketMs: number;
}) {
  if (buckets.length === 0)
    return (
      <p data-testid="token-usage-trend-empty" className="py-1 ui-micro text-text-faint">
        {t("agentRuntime.tokenUsageTrendEmpty")}
      </p>
    );
  const peak = Math.max(...buckets.map(({ totalTokens }) => totalTokens), 1),
    width = buckets.length * (BAR_WIDTH + BAR_GAP),
    scale = (value: number): number => (value / peak) * CHART_HEIGHT,
    axisEvery = buckets.length > 12 ? 3 : buckets.length > 8 ? 2 : 1;
  return (
    <div
      data-testid="token-usage-trend"
      className="overflow-x-auto"
      role="img"
      aria-label={t("agentRuntime.tokenUsageTrendLabel")}
    >
      <svg width={width} height={CHART_HEIGHT + AXIS_HEIGHT + 6} className="block">
        {/* 水平网格:峰值与半峰值两条,带紧凑数值(颜色之外的第二通道)。 */}
        {Array.from({ length: GRID_COUNT + 1 }, (_, index) => {
          const value = peak - (peak / GRID_COUNT) * index,
            y = AXIS_HEIGHT + 6 + CHART_HEIGHT - scale(value);
          return (
            <g key={`grid-${index}`}>
              <line x1={0} x2={width} y1={y} y2={y} stroke="var(--color-border)" strokeDasharray="2 4" opacity={0.5} />
              <text x={2} y={y - 3} className="font-mono" fontSize={9} fill="var(--color-text-faint)">
                {compactTokens(Math.round(value))}
              </text>
            </g>
          );
        })}
        {buckets.map((bucket, index) => {
          const x = index * (BAR_WIDTH + BAR_GAP),
            input = scale(bucket.inputTokens),
            cacheRead = scale(bucket.cacheReadTokens),
            output = scale(bucket.outputTokens),
            baseY = AXIS_HEIGHT + 6 + CHART_HEIGHT,
            label = bucketAxisLabel(bucket.bucketStart, bucketMs);
          return (
            <g key={bucket.bucketStart} data-testid={`token-usage-trend-bar-${label}`}>
              <title>
                {`${label} · ${t("agentRuntime.tokenUsageColTotal")} ${exactTokens(bucket.totalTokens)} · ${t(
                  "agentRuntime.tokenUsageColInput",
                )} ${exactTokens(bucket.inputTokens)} · ${t("agentRuntime.tokenUsageColCacheRead")} ${exactTokens(
                  bucket.cacheReadTokens,
                )} · ${t("agentRuntime.tokenUsageColOutput")} ${exactTokens(bucket.outputTokens)} · ${t(
                  "agentRuntime.tokenUsageColDispatches",
                )} ${String(bucket.dispatchCount)}`}
              </title>
              <rect
                x={x}
                y={baseY - input - cacheRead - output}
                width={BAR_WIDTH}
                height={input}
                fill={LAYER_COLORS.input}
                rx={1}
              />
              <rect
                x={x}
                y={baseY - cacheRead - output}
                width={BAR_WIDTH}
                height={cacheRead}
                fill={LAYER_COLORS.cacheRead}
                rx={1}
              />
              <rect x={x} y={baseY - output} width={BAR_WIDTH} height={output} fill={LAYER_COLORS.output} rx={1} />
              {bucket.totalTokens > 0 ? (
                <text
                  x={x + BAR_WIDTH / 2}
                  y={baseY - input - cacheRead - output - 3}
                  textAnchor="middle"
                  className="font-mono"
                  fontSize={9}
                  fill="var(--color-text-muted)"
                >
                  {compactTokens(bucket.totalTokens)}
                </text>
              ) : null}
              {index % axisEvery === 0 ? (
                <text
                  x={x + BAR_WIDTH / 2}
                  y={CHART_HEIGHT + AXIS_HEIGHT + 4}
                  textAnchor="middle"
                  className="font-mono"
                  fontSize={9}
                  fill="var(--color-text-faint)"
                >
                  {label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {/* 图例:三段颜色各自是什么,复用表格视图的列名。 */}
      <ul data-testid="token-usage-trend-legend" className="mt-1 flex gap-3 font-mono ui-micro text-text-muted">
        {(
          [
            ["input", "agentRuntime.tokenUsageColInput"],
            ["cacheRead", "agentRuntime.tokenUsageColCacheRead"],
            ["output", "agentRuntime.tokenUsageColOutput"],
          ] as const
        ).map(([layer, label]) => (
          <li key={layer} className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-[1px]"
              style={{ background: LAYER_COLORS[layer] }}
            />
            {t(label)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 趋势的文字等价视图:同一批桶的紧凑表(与 SVG 图可互切)。 */
export function UsageTrendTable({
  buckets,
  bucketMs,
}: {
  readonly buckets: readonly AgentRuntimeTokenUsageBucket[];
  readonly bucketMs: number;
}) {
  if (buckets.length === 0)
    return <p className="py-1 ui-micro text-text-faint">{t("agentRuntime.tokenUsageTrendEmpty")}</p>;
  return (
    <table data-testid="token-usage-trend-table" className="w-full border-separate border-spacing-0">
      <thead>
        <tr className="text-left font-mono ui-micro uppercase tracking-[0.06em] text-text-faint">
          <th className="border-b border-border pb-1 pr-3">{t("agentRuntime.tokenUsageColBucket")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColDispatches")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColInput")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColCacheRead")}</th>
          <th className="border-b border-border pb-1 pr-3 text-right">{t("agentRuntime.tokenUsageColOutput")}</th>
          <th className="border-b border-border pb-1 text-right">{t("agentRuntime.tokenUsageColTotal")}</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((bucket) => (
          <tr key={bucket.bucketStart} className="hover:bg-surface-raised">
            <td className="border-b border-border py-1 pr-3 font-mono ui-micro">
              {bucketAxisLabel(bucket.bucketStart, bucketMs)}
            </td>
            <td className="border-b border-border py-1 pr-3 text-right font-mono ui-micro">{bucket.dispatchCount}</td>
            <td
              className="border-b border-border py-1 pr-3 text-right font-mono ui-micro"
              title={exactTokens(bucket.inputTokens)}
            >
              {compactTokens(bucket.inputTokens)}
            </td>
            <td
              className="border-b border-border py-1 pr-3 text-right font-mono ui-micro"
              title={exactTokens(bucket.cacheReadTokens)}
            >
              {compactTokens(bucket.cacheReadTokens)}
            </td>
            <td
              className="border-b border-border py-1 pr-3 text-right font-mono ui-micro"
              title={exactTokens(bucket.outputTokens)}
            >
              {compactTokens(bucket.outputTokens)}
            </td>
            <td
              className="border-b border-border py-1 text-right font-mono ui-micro font-semibold"
              title={exactTokens(bucket.totalTokens)}
            >
              {compactTokens(bucket.totalTokens)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
