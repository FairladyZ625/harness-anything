import { memo } from "react";
import { t } from "../../i18n/index.tsx";
import { observePercentile, type ObserveStats } from "../../daemon-observe-stats.ts";
import { formatDuration } from "../../model/time.ts";

/** 执行请求排行与长等待分开。attach 的耗时是订阅建立，仍参与执行分位和慢请求提示。 */
/** 长尾曝光阈值:单次耗时超过 1s 视为慢操作(checkpoint 判据同源)。 */
export const OBSERVE_SLOW_OP_MS = 1_000,
  OBSERVE_SLOW_TOP = 5;

const toneFor = (value: number): string => (value > OBSERVE_SLOW_OP_MS ? "text-status-blocked" : "text-text-muted");

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
  const cards: [label: string, value: number | null][] = [
    ["P50", stats.p50Ms],
    ["P95", stats.p95Ms],
    ["Max", stats.maxMs],
  ];
  return (
    <div data-testid={testId} className="px-3 py-2">
      <p className="font-mono ui-micro text-text-faint">{t("views.daemonObserve.durationScope")}</p>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="ui-meta font-semibold">{t("views.daemonObserve.slowTitle")}</span>
        {cards.map(([label, value]) => (
          <span key={label} className="font-mono ui-micro text-text-muted">
            <span className="text-text-faint">{label} </span>
            <span className={toneFor(value ?? 0)}>{formatDuration(value)}</span>
          </span>
        ))}
      </div>
      {stats.maxMs === null ? (
        <p className="font-mono ui-micro text-text-faint">{t("views.daemonObserve.slowEmpty")}</p>
      ) : null}
      {[
        {
          kind: "execution",
          label: null,
          ops: stats.ops.filter((op) => !isAttach(op.method)).slice(0, OBSERVE_SLOW_TOP),
          waiting: false,
        },
        {
          kind: "attach",
          label: t("views.daemonObserve.attachDuration"),
          ops: stats.ops.filter((op) => isAttach(op.method)),
          waiting: false,
        },
        { kind: "waits", label: t("views.daemonObserve.waitDuration"), ops: stats.waits, waiting: true },
      ]
        .filter((group) => group.ops.length > 0)
        .map((group) => (
          <div key={group.kind} data-testid={`${testId}-${group.kind}`}>
            {group.label === null ? null : <p className="mt-2 font-mono ui-micro text-text-muted">{group.label}</p>}
            <ol className="mt-1 flex flex-col gap-0.5">
              {group.ops.map((op) => {
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
                    <span className={`shrink-0 ${group.waiting ? "text-text-muted" : toneFor(op.maxMs)}`}>
                      <span className="text-text-faint">P50 </span>
                      {formatDuration(observePercentile(op.durations, 0.5))}
                      <span className="text-text-faint"> · P95 </span>
                      {formatDuration(p95)}
                      <span className="text-text-faint"> · Max </span>
                      {formatDuration(op.maxMs)}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
    </div>
  );
});

const isAttach = (method: string): boolean =>
  method === "repo.agentRuntime.attach" || method === "repo.terminal.attach";
