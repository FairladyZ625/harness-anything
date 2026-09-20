import { memo } from "react";
import { t } from "../../i18n/index.tsx";
import { observePercentile, type ObserveStats } from "../../daemon-observe-stats.ts";

/**
 * 慢操作排行榜:整体 P50/P95/Max 分位卡片 + Top 5 慢 RPC 列表(按单次最大耗时排序,
 * 每行给该方法的 P50/P95/Max 与调用次数)。>1000ms 的长尾以阻塞色曝光——单写队列的
 * 瓶颈(如近 5s 的 task.adjudicate)一眼可见。点击方法名把双栏过滤收敛到该方法
 * (透镜,见 DaemonTailPane 的 lens)。分位点在渲染时对 Top 5 的耗时序列排序,
 * 序列有界(≤ 已加载行数),不随轮询增长重算历史。
 */

/** 长尾曝光阈值:单次耗时超过 1s 视为慢操作(checkpoint 判据同源)。 */
export const OBSERVE_SLOW_OP_MS = 1_000,
  OBSERVE_SLOW_TOP = 5;

const ms = (value: number | null): string => (value === null ? "—" : `${Math.round(value)}ms`),
  toneFor = (value: number): string => (value > OBSERVE_SLOW_OP_MS ? "text-status-blocked" : "text-text-muted");

export const ObserveSlowOpsBoard = memo(function ObserveSlowOpsBoard({
  testId,
  stats,
  onFocusMethod,
}: {
  /** data-testid 前缀(pane 传 observe-slowops-<kind>);方法行派生 `-method`。 */
  readonly testId: string;
  readonly stats: ObserveStats;
  readonly onFocusMethod: (method: string) => void;
}) {
  if (stats.maxMs === null)
    return (
      <p data-testid={testId} className="px-3 py-2 font-mono ui-micro text-text-faint">
        {t("views.daemonObserve.slowEmpty")}
      </p>
    );
  const cards: [label: string, value: number | null][] = [
    ["P50", stats.p50Ms],
    ["P95", stats.p95Ms],
    ["Max", stats.maxMs],
  ];
  return (
    <div data-testid={testId} className="px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="ui-meta font-semibold">{t("views.daemonObserve.slowTitle")}</span>
        {cards.map(([label, value]) => (
          <span key={label} className="font-mono ui-micro text-text-muted">
            <span className="text-text-faint">{label} </span>
            <span className={toneFor(value ?? 0)}>{ms(value)}</span>
          </span>
        ))}
      </div>
      <ol className="mt-1 flex flex-col gap-0.5">
        {stats.ops.slice(0, OBSERVE_SLOW_TOP).map((op) => {
          const p95 = observePercentile(op.durations, 0.95);
          return (
            <li key={op.method} className="flex items-baseline gap-2 font-mono ui-micro">
              <button
                type="button"
                data-testid={`${testId}-method`}
                title={t("views.daemonObserve.slowFocusTip")}
                onClick={() => onFocusMethod(op.method)}
                className="min-w-0 flex-1 truncate text-left text-accent hover:underline"
              >
                {op.method}
              </button>
              <span className="shrink-0 text-text-faint">
                {t("views.daemonObserve.slowCalls", { count: String(op.count) })}
              </span>
              <span className={`shrink-0 ${toneFor(op.maxMs)}`}>
                <span className="text-text-faint">P50 </span>
                {ms(observePercentile(op.durations, 0.5))}
                <span className="text-text-faint"> · P95 </span>
                {ms(p95)}
                <span className="text-text-faint"> · Max </span>
                {ms(op.maxMs)}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
});
