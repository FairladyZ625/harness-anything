import { memo } from "react";
import { t } from "../../i18n/index.tsx";
import { observePercentile, type ObserveStats } from "../../daemon-observe-model.ts";

/**
 * 命令与事件调用量图形化看板:
 *  - 展示各命令/RPC 方法(日志流)或事件类型(事件流)的调用频次排行与流量占比;
 *  - 每一项配备图形化水平比例条(以最大调用量为 100% 满格,直观展现长尾 vs 头部集中度);
 *  - 点击方法/事件名可将当前透镜或搜索条件收敛至该项,联动下方流水进行下钻;
 *  - 对于包含耗时记录的 RPC,同时展示 P50 延迟指示。
 */

export const OBSERVE_VOLUME_TOP = 8;

export const ObserveCallVolumeBoard = memo(function ObserveCallVolumeBoard({
  testId,
  isLogPane,
  stats,
  onFocusItem,
}: {
  /** data-testid 前缀(如 `observe-volume-repo-log`) */
  readonly testId: string;
  readonly isLogPane: boolean;
  readonly stats: ObserveStats;
  readonly onFocusItem: (name: string) => void;
}) {
  const topVolumes = stats.volumes.slice(0, OBSERVE_VOLUME_TOP);
  if (topVolumes.length === 0)
    return (
      <p data-testid={testId} className="px-3 py-2 font-mono ui-micro text-text-faint">
        {t("views.daemonObserve.volumeEmpty")}
      </p>
    );

  const maxCount = topVolumes[0]?.count ?? 1,
    // 快速索引 RPC 的 P50 耗时
    opsMap = new Map(stats.ops.map((op) => [op.method, op]));

  return (
    <div data-testid={testId} className="px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1">
        <span className="ui-meta font-semibold">
          {isLogPane ? t("views.daemonObserve.volumeTitleOps") : t("views.daemonObserve.volumeTitleEvents")}
        </span>
        <span className="font-mono ui-micro text-text-faint">
          {t("views.daemonObserve.volumeSummary", {
            types: String(stats.volumes.length),
            total: String(stats.total),
          })}
        </span>
      </div>
      <ol className="mt-2 flex flex-col gap-1.5">
        {topVolumes.map((item) => {
          const ratio = Math.max(2, Math.round((item.count / maxCount) * 100)),
            op = opsMap.get(item.name),
            p50 = op ? observePercentile(op.durations, 0.5) : null;
          return (
            <li key={item.name} className="flex flex-col gap-0.5 font-mono ui-micro">
              <div className="flex items-baseline justify-between gap-2">
                <button
                  type="button"
                  data-testid={`${testId}-item`}
                  title={t("views.daemonObserve.volumeFocusTip")}
                  onClick={() => onFocusItem(item.name)}
                  className="min-w-0 truncate text-left text-accent hover:underline"
                >
                  {item.name}
                </button>
                <div className="flex shrink-0 items-baseline gap-2 text-text-muted">
                  {p50 !== null ? (
                    <span className="text-text-faint" title="P50 latency">
                      P50 {Math.round(p50)}ms
                    </span>
                  ) : null}
                  <span className="font-semibold text-text">×{item.count}</span>
                  <span className="w-12 text-right text-text-faint">{item.percentage.toFixed(1)}%</span>
                </div>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
                <div
                  data-testid={`${testId}-bar`}
                  className="h-full rounded-full bg-accent/70 transition-all duration-300"
                  style={{ width: `${ratio}%` }}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
});
