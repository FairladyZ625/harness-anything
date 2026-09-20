import { memo, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import {
  OBSERVE_WINDOW_15M_BUCKETS,
  type ObserveStats,
  type ObserveTimeSlice,
  type ObserveWindowSpan,
} from "../../daemon-observe-stats.ts";

/**
 * 观察页顶部时序吞吐 HUD:轻量 SVG 柱状吞吐条(普通行用强调色、异常脉冲叠红),
 * 15m/1h 窗口切换;点击单柱选中该 10s 时段、拖拽框选连续时段,选中后下行流水按
 * 时段即时过滤,再次点击同一柱或「清除时段」恢复。不做 canvas、不引可视化库,
 * 柱数 ≤ 360 且只在行集版本变化时重算(统计在数据面增量完成,见 observeStatsLog)。
 */

export type ObserveHudWindow = ObserveWindowSpan;

const VIEW_WIDTH = 720,
  VIEW_HEIGHT = 40;

export interface ObserveTimeSelection {
  readonly fromMs: number;
  readonly toMs: number;
}

const rangeChip = (ms: number): string =>
  formatTime(new Date(ms).toISOString(), { style: "time-seconds" }) ?? String(ms);

const RANGE_GROUP = "inline-flex shrink-0 overflow-hidden rounded border border-border-strong",
  SELECTION_CHIP = [
    "inline-flex shrink-0 items-center gap-1 rounded border border-accent/40",
    "bg-accent/10 px-1.5 py-0.5 font-mono ui-micro text-accent",
  ].join(" ");

const windowOptionClass = (selected: boolean) =>
  [
    "px-1.5 py-0.5 ui-micro",
    selected ? "bg-accent font-semibold text-accent-fg" : "text-text-muted hover:bg-surface",
  ].join(" ");

export const ObserveHudStrip = memo(function ObserveHudStrip({
  testId,
  stats,
  window,
  onWindowChange,
  selection,
  onSelectRange,
}: {
  /** data-testid 前缀(pane 传 observe-hud-<kind>);柱面派生 `-bars`。 */
  readonly testId: string;
  readonly stats: ObserveStats;
  readonly window: ObserveHudWindow;
  readonly onWindowChange: (window: ObserveHudWindow) => void;
  readonly selection: ObserveTimeSelection | null;
  readonly onSelectRange: (selection: ObserveTimeSelection | null) => void;
}) {
  const buckets = window === "15m" ? stats.buckets.slice(-OBSERVE_WINDOW_15M_BUCKETS) : stats.buckets,
    [drag, setDrag] = useState<{ anchor: number; current: number } | null>(null),
    svgRef = useRef<SVGSVGElement>(null),
    totals = buckets.reduce(
      (acc, bucket) => ({ count: acc.count + bucket.count, anomalies: acc.anomalies + bucket.anomalies }),
      { count: 0, anomalies: 0 },
    ),
    peak = Math.max(1, ...buckets.map((bucket) => bucket.count)),
    dragLow = drag === null ? 0 : Math.min(drag.anchor, drag.current),
    dragHigh = drag === null ? -1 : Math.max(drag.anchor, drag.current);
  const bucketAt = (event: PointerEvent | React.PointerEvent): number | null => {
    // 布局未量出(测试环境/隐藏面板)时忽略指针,不做除零映射。
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0 || buckets.length === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH,
      index = Math.floor((x / VIEW_WIDTH) * buckets.length);
    return Math.min(buckets.length - 1, Math.max(0, index));
  };
  const selected = (bucket: ObserveTimeSlice): boolean =>
    selection !== null && bucket.endMs > selection.fromMs && bucket.startMs < selection.toMs;
  return (
    <div data-testid={testId} className="flex items-center gap-2 border-b border-border px-3 py-1.5">
      <span role="group" aria-label={t("views.daemonObserve.hudLabel")} className={RANGE_GROUP}>
        {(["15m", "1h"] as const).map((option) => (
          <button
            key={option}
            type="button"
            data-testid={`${testId}-range-${option}`}
            aria-pressed={option === window}
            onClick={() => onWindowChange(option)}
            className={windowOptionClass(option === window)}
          >
            {option === "15m" ? t("views.daemonObserve.hudRange15m") : t("views.daemonObserve.hudRange1h")}
          </button>
        ))}
      </span>
      {buckets.length === 0 ? (
        <span className="min-w-0 flex-1 truncate font-mono ui-micro text-text-faint">
          {t("views.daemonObserve.hudEmpty")}
        </span>
      ) : (
        <svg
          ref={svgRef}
          data-testid={`${testId}-bars`}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          aria-label={t("views.daemonObserve.hudLabel")}
          className="h-9 min-w-0 flex-1 cursor-crosshair touch-none"
          onPointerDown={(event) => {
            const index = bucketAt(event);
            if (index === null) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({ anchor: index, current: index });
          }}
          onPointerMove={(event) => {
            if (drag === null) return;
            const index = bucketAt(event);
            if (index !== null && index !== drag.current) setDrag({ ...drag, current: index });
          }}
          onPointerUp={() => {
            if (drag === null) return;
            const low = buckets[Math.min(drag.anchor, drag.current)]!,
              high = buckets[Math.max(drag.anchor, drag.current)]!,
              solo = drag.anchor === drag.current,
              toggled = solo && selection !== null && selection.fromMs === low.startMs && selection.toMs === high.endMs;
            setDrag(null);
            onSelectRange(toggled ? null : { fromMs: low.startMs, toMs: high.endMs });
          }}
          onPointerCancel={() => setDrag(null)}
        >
          {buckets.map((bucket, index) => {
            const barWidth = VIEW_WIDTH / buckets.length,
              normal = Math.round(((bucket.count - bucket.anomalies) / peak) * (VIEW_HEIGHT - 2)),
              anomaly = Math.round((bucket.anomalies / peak) * (VIEW_HEIGHT - 2)),
              highlighted = (drag !== null && index >= dragLow && index <= dragHigh) || selected(bucket);
            return (
              <g key={bucket.startMs}>
                <rect
                  x={index * barWidth + 0.5}
                  y={VIEW_HEIGHT - normal}
                  width={Math.max(0.5, barWidth - 1)}
                  height={normal}
                  className="fill-accent/50"
                />
                {anomaly > 0 ? (
                  <rect
                    x={index * barWidth + 0.5}
                    y={VIEW_HEIGHT - normal - anomaly}
                    width={Math.max(0.5, barWidth - 1)}
                    height={anomaly}
                    className="fill-status-blocked"
                  />
                ) : null}
                {highlighted ? (
                  <rect x={index * barWidth} y={0} width={barWidth} height={VIEW_HEIGHT} className="fill-accent/15" />
                ) : null}
              </g>
            );
          })}
        </svg>
      )}
      <span className="shrink-0 font-mono ui-micro text-text-faint">
        {t("views.daemonObserve.hudWindowCount", { count: String(totals.count) })}
      </span>
      <span
        data-testid={`${testId}-anomalies`}
        className={`shrink-0 font-mono ui-micro ${totals.anomalies > 0 ? "text-status-blocked" : "text-text-faint"}`}
      >
        {t("views.daemonObserve.hudAnomalies", { count: String(totals.anomalies) })}
      </span>
      {selection === null ? null : (
        <button
          type="button"
          data-testid={`${testId}-clear`}
          onClick={() => onSelectRange(null)}
          title={t("views.daemonObserve.hudRangeClear")}
          className={SELECTION_CHIP}
        >
          {t("views.daemonObserve.hudSelected", { from: rangeChip(selection.fromMs), to: rangeChip(selection.toMs) })}
          <X />
        </button>
      )}
    </div>
  );
});
