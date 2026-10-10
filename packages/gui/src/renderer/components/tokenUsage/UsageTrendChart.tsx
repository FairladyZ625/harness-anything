import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type {
  AgentRuntimeTokenUsageBucket,
  AgentRuntimeTokenUsageTrendSeries,
} from "@harness-anything/daemon/protocol";
import { preciseTokens, exactTokens, percentText, usdText } from "../../token-format.ts";
import {
  axisScale,
  bucketAxisLabel,
  cacheHitRate,
  seriesColor,
  tokenComposition,
  tokenKindColor,
  tokenKindKey,
  tokenKinds,
} from "../../token-usage-model.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 消耗趋势的两种图(手写 SVG,仓库没有图表库):柱状按 daemon 的时间桶堆叠,折线每层一条
 * 线,都铺满容器宽度。层可切:四类 token(缓存读取 / 缓存写入 / 新输入 / 输出),或读面给的
 * 分系列(按 agent、按模型,各自与桶一一对齐)。纵轴取整步长刻度,最高点不会超出最上一条
 * 刻度线;柱状只有最高柱直接标值,其余的值在悬停明细与表格视图里。
 * 悬停或键盘左右键选中一个桶,给出该桶每一层的数值与占比。
 */

export interface TrendLayer {
  readonly key: string;
  readonly name: string;
  readonly color: string;
  /** 与桶一一对齐。 */
  readonly values: readonly number[];
}

/** 三类 token 的层:全页同色同序。 */
export function tokenKindLayers(buckets: readonly AgentRuntimeTokenUsageBucket[]): readonly TrendLayer[] {
  const composed = buckets.map(tokenComposition);
  return tokenKinds.map((kind) => ({
    key: kind,
    name: t(tokenKindKey[kind]),
    color: tokenKindColor[kind],
    values: composed.map((parts) => parts[kind]),
  }));
}
/** 读面分系列的层:颜色跟位次走,key 为 null 的是其余合并项。 */
export function seriesLayers(series: readonly AgentRuntimeTokenUsageTrendSeries[]): readonly TrendLayer[] {
  return series.map(({ key, name, totalTokens }, index) => ({
    key: key ?? "",
    name: key === null ? t("agentRuntime.tokenUsageSeriesRest") : name,
    color: seriesColor(key, index),
    values: totalTokens,
  }));
}

const PLOT_HEIGHT = 208,
  TOP = 20,
  AXIS = 24,
  GUTTER = 46,
  // 没量到宽度(首帧、无布局的测试环境)时的图宽;量到之后以容器为准。
  FALLBACK_WIDTH = 720;

/** 容器宽度测量:两种图共用,宽度没变就不触发更新(观察器在首次观察时总会回调一次)。 */
function useMeasuredWidth(): readonly [RefObject<HTMLDivElement | null>, number] {
  const host = useRef<HTMLDivElement | null>(null),
    [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    const element = host.current;
    if (element === null) return;
    const measure = () => setMeasured((current) => (current === element.clientWidth ? current : element.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  return [host, measured];
}

export function UsageTrendChart({
  buckets,
  bucketMs,
  layers,
}: {
  readonly buckets: readonly AgentRuntimeTokenUsageBucket[];
  readonly bucketMs: number;
  readonly layers: readonly TrendLayer[];
}) {
  const [host, measured] = useMeasuredWidth(),
    [active, setActive] = useState<number | null>(null);
  if (buckets.length === 0)
    return (
      <p data-testid="token-usage-trend-empty" className="py-1 ui-meta text-text-faint">
        {t("agentRuntime.tokenUsageTrendEmpty")}
      </p>
    );
  const width = measured > 0 ? measured : FALLBACK_WIDTH,
    plotWidth = width - GUTTER,
    band = plotWidth / buckets.length,
    barWidth = Math.max(3, Math.min(36, band * 0.62)),
    totals = buckets.map(({ totalTokens }) => totalTokens),
    peak = Math.max(...totals),
    peakIndex = totals.indexOf(peak),
    { max, ticks } = axisScale(peak),
    baseline = TOP + PLOT_HEIGHT,
    scale = (value: number): number => (value / max) * PLOT_HEIGHT,
    labelEvery = Math.max(1, Math.ceil(48 / band)),
    labelOf = (index: number): string => bucketAxisLabel(buckets[index]!.bucketStart, bucketMs),
    activeBucket = active === null ? undefined : buckets[active],
    onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.key === "ArrowLeft" ? -1 : 1;
      setActive((current) => Math.max(0, Math.min(buckets.length - 1, (current ?? peakIndex) + step)));
    };
  return (
    <div ref={host} data-testid="token-usage-trend" className="relative min-w-0">
      <svg
        width={width}
        height={baseline + AXIS}
        className="block outline-none focus-visible:ring-1 focus-visible:ring-accent"
        role="img"
        aria-label={t("agentRuntime.tokenUsageTrendLabel")}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((current) => current ?? peakIndex)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((tick) => {
          const y = baseline - scale(tick);
          return (
            <g key={tick}>
              <line x1={GUTTER} x2={width} y1={y} y2={y} stroke="var(--color-border)" opacity={tick === 0 ? 1 : 0.55} />
              <text
                x={GUTTER - 8}
                y={y + 3.5}
                textAnchor="end"
                className="font-mono tabular-nums"
                fontSize={11}
                fill="var(--color-text-faint)"
              >
                {preciseTokens(tick)}
              </text>
            </g>
          );
        })}
        {buckets.map((bucket, index) => {
          const center = GUTTER + band * index + band / 2,
            label = labelOf(index);
          let top = baseline;
          return (
            <g key={bucket.bucketStart} data-testid={`token-usage-trend-bar-${label}`}>
              {active === index ? (
                <rect
                  x={GUTTER + band * index}
                  y={TOP - 6}
                  width={band}
                  height={PLOT_HEIGHT + 6}
                  fill="var(--color-text)"
                  opacity={0.06}
                />
              ) : null}
              <g className="viz-grow" opacity={active === null || active === index ? 1 : 0.6}>
                {layers.map((layer) => {
                  const height = scale(layer.values[index] ?? 0);
                  top -= height;
                  // 段与段之间留 1px 图面色缝;不足 3px 的薄段不留缝,否则就看不见了。
                  return height <= 0 ? null : (
                    <rect
                      key={layer.key}
                      x={center - barWidth / 2}
                      y={top}
                      width={barWidth}
                      height={height > 3 ? height - 1 : height}
                      fill={layer.color}
                      rx={1.5}
                    />
                  );
                })}
              </g>
              {index === peakIndex && peak > 0 ? (
                <text
                  x={center}
                  y={baseline - scale(peak) - 6}
                  textAnchor="middle"
                  className="font-mono tabular-nums"
                  fontSize={11}
                  fontWeight={600}
                  fill="var(--color-text)"
                >
                  {preciseTokens(peak)}
                </text>
              ) : null}
              {index % labelEvery === 0 ? (
                <text
                  x={center}
                  y={baseline + 16}
                  textAnchor="middle"
                  className="font-mono tabular-nums"
                  fontSize={11}
                  fill={active === index ? "var(--color-text)" : "var(--color-text-faint)"}
                >
                  {label}
                </text>
              ) : null}
              {/* 命中区是整条带,不是画出来的那根柱:零量的桶也能选中。 */}
              <rect
                x={GUTTER + band * index}
                y={0}
                width={band}
                height={baseline + AXIS}
                fill="transparent"
                onPointerEnter={() => setActive(index)}
                onPointerMove={() => setActive(index)}
              />
            </g>
          );
        })}
      </svg>
      {activeBucket !== undefined && active !== null ? (
        <TrendReadout
          bucket={activeBucket}
          label={labelOf(active)}
          layers={layers}
          index={active}
          // 明细框跟着选中的带走,靠右半边时翻到带的左侧,不出图。
          style={
            GUTTER + band * active + band / 2 > width / 2
              ? { right: width - (GUTTER + band * active) + 6 }
              : { left: GUTTER + band * (active + 1) + 6 }
          }
        />
      ) : null}
      <TrendLegend layers={layers} total={totals.reduce((sum, value) => sum + value, 0)} />
    </div>
  );
}

/**
 * 趋势的折线呈现:每个层一条线(多天窗口即按天折线,今天为按小时),看重的是走势形状而
 * 不是构成占比 —— 构成看柱状。纵轴以最高的单层值为峰;全零的层不画线。悬停/键盘与
 * 柱状同一条路:选中一个桶,明细给出该桶每一层的数值与占比。
 */
export function UsageTrendLine({
  buckets,
  bucketMs,
  layers,
}: {
  readonly buckets: readonly AgentRuntimeTokenUsageBucket[];
  readonly bucketMs: number;
  readonly layers: readonly TrendLayer[];
}) {
  const [host, measured] = useMeasuredWidth(),
    [active, setActive] = useState<number | null>(null);
  if (buckets.length === 0)
    return (
      <p data-testid="token-usage-trend-empty" className="py-1 ui-meta text-text-faint">
        {t("agentRuntime.tokenUsageTrendEmpty")}
      </p>
    );
  const width = measured > 0 ? measured : FALLBACK_WIDTH,
    plotWidth = width - GUTTER,
    band = plotWidth / buckets.length,
    drawn = layers.filter((layer) => layer.values.some((value) => value > 0)),
    peak = Math.max(...drawn.flatMap((layer) => layer.values), 0),
    { max, ticks } = axisScale(peak),
    baseline = TOP + PLOT_HEIGHT,
    scale = (value: number): number => (value / max) * PLOT_HEIGHT,
    labelEvery = Math.max(1, Math.ceil(48 / band)),
    labelOf = (index: number): string => bucketAxisLabel(buckets[index]!.bucketStart, bucketMs),
    totals = buckets.map(({ totalTokens }) => totalTokens),
    peakIndex = totals.indexOf(Math.max(...totals)),
    activeBucket = active === null ? undefined : buckets[active],
    onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.key === "ArrowLeft" ? -1 : 1;
      setActive((current) => Math.max(0, Math.min(buckets.length - 1, (current ?? peakIndex) + step)));
    };
  return (
    <div ref={host} data-testid="token-usage-trend-line" className="relative min-w-0">
      <svg
        width={width}
        height={baseline + AXIS}
        className="block outline-none focus-visible:ring-1 focus-visible:ring-accent"
        role="img"
        aria-label={t("agentRuntime.tokenUsageTrendLineLabel")}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((current) => current ?? peakIndex)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((tick) => {
          const y = baseline - scale(tick);
          return (
            <g key={tick}>
              <line x1={GUTTER} x2={width} y1={y} y2={y} stroke="var(--color-border)" opacity={tick === 0 ? 1 : 0.55} />
              <text
                x={GUTTER - 8}
                y={y + 3.5}
                textAnchor="end"
                className="font-mono tabular-nums"
                fontSize={11}
                fill="var(--color-text-faint)"
              >
                {preciseTokens(tick)}
              </text>
            </g>
          );
        })}
        {drawn.map((layer) => (
          <g key={layer.key} data-testid={`token-usage-trend-line-${layer.key}`} opacity={active === null ? 1 : 0.85}>
            <polyline
              points={buckets
                .map(
                  (_bucket, index) =>
                    `${GUTTER + band * index + band / 2},${baseline - scale(layer.values[index] ?? 0)}`,
                )
                .join(" ")}
              fill="none"
              stroke={layer.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {buckets.map((_bucket, index) => (
              <circle
                key={index}
                cx={GUTTER + band * index + band / 2}
                cy={baseline - scale(layer.values[index] ?? 0)}
                r={active === index ? 3 : 2}
                fill={active === index ? "var(--color-surface)" : layer.color}
                stroke={layer.color}
                strokeWidth={active === index ? 2 : 0}
              />
            ))}
          </g>
        ))}
        {buckets.map((bucket, index) => {
          const label = labelOf(index);
          return (
            <g key={bucket.bucketStart}>
              {active === index ? (
                <line
                  x1={GUTTER + band * index + band / 2}
                  x2={GUTTER + band * index + band / 2}
                  y1={TOP - 6}
                  y2={baseline}
                  stroke="var(--color-text)"
                  opacity={0.25}
                />
              ) : null}
              {index % labelEvery === 0 ? (
                <text
                  x={GUTTER + band * index + band / 2}
                  y={baseline + 16}
                  textAnchor="middle"
                  className="font-mono tabular-nums"
                  fontSize={11}
                  fill={active === index ? "var(--color-text)" : "var(--color-text-faint)"}
                >
                  {label}
                </text>
              ) : null}
              {/* 命中区是整条带,不是画出来的点:零量的桶也能选中。 */}
              <rect
                x={GUTTER + band * index}
                y={0}
                width={band}
                height={baseline + AXIS}
                fill="transparent"
                onPointerEnter={() => setActive(index)}
                onPointerMove={() => setActive(index)}
              />
            </g>
          );
        })}
      </svg>
      {activeBucket !== undefined && active !== null ? (
        <TrendReadout
          bucket={activeBucket}
          label={labelOf(active)}
          layers={layers}
          index={active}
          style={
            GUTTER + band * active + band / 2 > width / 2
              ? { right: width - (GUTTER + band * active) + 6 }
              : { left: GUTTER + band * (active + 1) + 6 }
          }
        />
      ) : null}
      <TrendLegend layers={layers} total={totals.reduce((sum, value) => sum + value, 0)} />
    </div>
  );
}

function TrendReadout({
  bucket,
  label,
  layers,
  index,
  style,
}: {
  readonly bucket: AgentRuntimeTokenUsageBucket;
  readonly label: string;
  readonly layers: readonly TrendLayer[];
  readonly index: number;
  readonly style: { readonly left?: number; readonly right?: number };
}) {
  const hitRate = cacheHitRate(bucket);
  return (
    <div
      data-testid="token-usage-trend-readout"
      className="glass pointer-events-none absolute top-1 z-10 min-w-[188px] max-w-[280px] rounded-sm px-2.5 py-2"
      style={style}
    >
      <p className="flex items-baseline justify-between gap-3">
        <span className="font-mono ui-meta text-text-muted">{label}</span>
        <b className="font-mono tabular-nums ui-body" title={exactTokens(bucket.totalTokens)}>
          {preciseTokens(bucket.totalTokens)}
        </b>
      </p>
      <ul className="mt-1.5 flex flex-col gap-0.5 border-t border-border pt-1.5">
        {layers
          .filter((layer) => (layer.values[index] ?? 0) > 0)
          .map((layer) => {
            const value = layer.values[index] ?? 0;
            return (
              <li
                key={layer.key}
                className="grid grid-cols-[10px_minmax(0,1fr)_auto_auto] items-center gap-x-2 ui-meta"
              >
                <span aria-hidden="true" className="h-[3px] w-2.5 rounded-full" style={{ background: layer.color }} />
                <span className="truncate text-text-muted">{layer.name}</span>
                <span className="font-mono tabular-nums text-text">{preciseTokens(value)}</span>
                <span className="w-10 text-right font-mono tabular-nums text-text-faint">
                  {percentText(bucket.totalTokens > 0 ? value / bucket.totalTokens : 0)}
                </span>
              </li>
            );
          })}
      </ul>
      <p className="mt-1.5 border-t border-border pt-1.5 ui-meta text-text-faint">
        {t("agentRuntime.tokenUsageReadoutDispatches", { count: String(bucket.dispatchCount) })}
        {hitRate === null ? "" : ` · ${t("agentRuntime.tokenUsageReadoutCacheHit", { rate: percentText(hitRate) })}`}
        {bucket.usageUnavailableDispatches > 0
          ? ` · ${t("agentRuntime.tokenUsageReadoutUnreported", { count: String(bucket.usageUnavailableDispatches) })}`
          : ""}
        {` · ${t("agentRuntime.tokenUsageReadoutCost", { cost: usdText(bucket.costUsd) })}`}
      </p>
    </div>
  );
}

/** 图例带窗口合计与占比:颜色之外,每一层都有名字和数。 */
function TrendLegend({ layers, total }: { readonly layers: readonly TrendLayer[]; readonly total: number }) {
  return (
    <ul data-testid="token-usage-trend-legend" className="mt-1 flex flex-wrap gap-x-4 gap-y-1 pl-[46px] ui-meta">
      {layers.map((layer) => {
        const value = layer.values.reduce((sum, item) => sum + item, 0);
        return (
          <li key={layer.key} className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[2px]" style={{ background: layer.color }} />
            <span className="truncate text-text-muted">{layer.name}</span>
            <span className="font-mono tabular-nums text-text">{preciseTokens(value)}</span>
            <span className="font-mono tabular-nums text-text-faint">{percentText(total > 0 ? value / total : 0)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** 趋势的表格等价视图:同一批桶、同一组层,每层一列。 */
export function UsageTrendTable({
  buckets,
  bucketMs,
  layers,
}: {
  readonly buckets: readonly AgentRuntimeTokenUsageBucket[];
  readonly bucketMs: number;
  readonly layers: readonly TrendLayer[];
}) {
  if (buckets.length === 0)
    return <p className="py-1 ui-meta text-text-faint">{t("agentRuntime.tokenUsageTrendEmpty")}</p>;
  const cell = "border-b border-border py-1.5 pr-3 text-right font-mono tabular-nums ui-meta";
  return (
    <div className="bounded-content overflow-auto">
      <table data-testid="token-usage-trend-table" className="w-full border-separate border-spacing-0">
        <thead>
          <tr className="text-left ui-meta text-text-faint">
            <th className="border-b border-border pb-1.5 pr-3 font-normal">{t("agentRuntime.tokenUsageColBucket")}</th>
            <th className="border-b border-border pb-1.5 pr-3 text-right font-normal">
              {t("agentRuntime.tokenUsageColDispatches")}
            </th>
            {layers.map((layer) => (
              <th key={layer.key} className="border-b border-border pb-1.5 pr-3 text-right font-normal">
                {layer.name}
              </th>
            ))}
            <th className="border-b border-border pb-1.5 pr-3 text-right font-normal">
              {t("agentRuntime.tokenUsageColTotal")}
            </th>
            <th className="border-b border-border pb-1.5 text-right font-normal">
              {t("agentRuntime.tokenUsageColCost")}
            </th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket, index) => (
            <tr key={bucket.bucketStart} className="hover:bg-text/5">
              <td className="border-b border-border py-1.5 pr-3 font-mono ui-meta">
                {bucketAxisLabel(bucket.bucketStart, bucketMs)}
              </td>
              <td className={cell}>{bucket.dispatchCount}</td>
              {layers.map((layer) => (
                <td key={layer.key} className={cell} title={exactTokens(layer.values[index] ?? 0)}>
                  {preciseTokens(layer.values[index] ?? 0)}
                </td>
              ))}
              <td
                className="border-b border-border py-1.5 pr-3 text-right font-mono font-semibold tabular-nums ui-meta"
                title={exactTokens(bucket.totalTokens)}
              >
                {preciseTokens(bucket.totalTokens)}
              </td>
              <td className={cell}>{usdText(bucket.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
