import { memo } from "react";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import type { ObserveAnomalyStat } from "../../daemon-observe-stats.ts";

/**
 * 异常与缺口指纹聚类:同类失败(方法+失败码)与保留缺口去重后的计数、最近一次
 * 时间与根因样本(悬停 detail)。成百上千行相同报错收敛成一行指纹,点击聚类把
 * pane 过滤框收敛到该指纹的检索词,只看这一类异常。
 */

const gapReasonText = (reason: string): string =>
  reason === "cursor-offset-out-of-range"
    ? t("views.daemonObserve.gapOutOfRange")
    : t("views.daemonObserve.gapNotRetained");

// G36:长 Tailwind 串按段拼装,单行不超过 120 列。
const CLUSTER_LIST = "flex flex-col gap-0.5 px-3 py-2",
  CLUSTER_ITEM = [
    "flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left",
    "font-mono ui-micro hover:bg-surface-raised/60",
  ].join(" ");

const lastAtText = (at: string | null): string =>
  at === null ? "" : (formatTime(at, { style: "time-seconds" }) ?? at);

export const ObserveAnomalyCluster = memo(function ObserveAnomalyCluster({
  testId,
  clusters,
  onFocusCluster,
}: {
  /** data-testid 前缀(pane 传 observe-anomalies-<kind>);条目派生 `-item`。 */
  readonly testId: string;
  readonly clusters: readonly ObserveAnomalyStat[];
  readonly onFocusCluster: (matchText: string) => void;
}) {
  if (clusters.length === 0)
    return (
      <p data-testid={testId} className="px-3 py-2 font-mono ui-micro text-text-faint">
        {t("views.daemonObserve.anomalyEmpty")}
      </p>
    );
  return (
    <ol data-testid={testId} className={CLUSTER_LIST} title={t("views.daemonObserve.anomalyFocusTip")}>
      {clusters.map((cluster) => (
        <li key={cluster.key}>
          <button
            type="button"
            data-testid={`${testId}-item`}
            title={cluster.sample === "" ? cluster.label : cluster.sample}
            onClick={() => onFocusCluster(cluster.matchText)}
            className={CLUSTER_ITEM}
          >
            <span className="shrink-0 rounded bg-status-blocked/10 px-1 text-status-blocked">×{cluster.count}</span>
            <span className="min-w-0 flex-1 truncate text-status-blocked">
              {cluster.kind === "gap"
                ? `${t("views.daemonObserve.anomalyGapLabel")} · ${gapReasonText(cluster.reason ?? "")}`
                : cluster.label}
            </span>
            {cluster.lastAt === null ? null : (
              <span className="shrink-0 text-text-faint">
                {t("views.daemonObserve.anomalyLastAt", { at: lastAtText(cluster.lastAt) })}
              </span>
            )}
          </button>
        </li>
      ))}
    </ol>
  );
});
