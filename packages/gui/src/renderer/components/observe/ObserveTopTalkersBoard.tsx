import { memo } from "react";
import { t } from "../../i18n/index.tsx";
import type { ObserveStats, ObserveWindowSpan } from "../../daemon-observe-stats.ts";

/**
 * 热点主体排行榜(Top Talkers):当前窗口内请求量/事件量最高的主体(taskId 优先,
 * 日志行退到 executor 调用方或连接标识;提取在 observeEventRow/observeLogRow 的
 * subject 位)。紧凑水平比例条 + 次数与占比,点击主体把透镜(或过滤框)收敛到该
 * 主体,双栏流水一起下钻。数据来自 stats.windows[window],与 HUD 选窗同步。
 */

export const OBSERVE_TALKER_TOP = 5;

export const ObserveTopTalkersBoard = memo(function ObserveTopTalkersBoard({
  testId,
  stats,
  window,
  onFocusSubject,
}: {
  /** data-testid 前缀(pane 传 observe-talkers-<kind>);条目派生 `-item`、比例条 `-bar`。 */
  readonly testId: string;
  readonly stats: ObserveStats;
  readonly window: ObserveWindowSpan;
  readonly onFocusSubject: (subject: string) => void;
}) {
  const talkers = stats.windows[window].talkers;
  if (talkers.length === 0)
    return (
      <p data-testid={testId} className="px-3 py-2 font-mono ui-micro text-text-faint">
        {t("views.daemonObserve.talkersEmpty")}
      </p>
    );
  const maxCount = talkers[0]?.count ?? 1;
  return (
    <div data-testid={testId} className="px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1">
        <span className="ui-meta font-semibold">{t("views.daemonObserve.talkersTitle")}</span>
        <span className="font-mono ui-micro text-text-faint">
          {t("views.daemonObserve.talkersSummary", {
            window: window === "15m" ? t("views.daemonObserve.hudRange15m") : t("views.daemonObserve.hudRange1h"),
          })}
        </span>
      </div>
      <ol className="mt-2 flex flex-col gap-1.5">
        {talkers.slice(0, OBSERVE_TALKER_TOP).map((talker) => {
          const ratio = Math.max(2, Math.round((talker.count / maxCount) * 100));
          return (
            <li key={talker.subject} className="flex flex-col gap-0.5 font-mono ui-micro">
              <div className="flex items-baseline justify-between gap-2">
                <button
                  type="button"
                  data-testid={`${testId}-item`}
                  title={t("views.daemonObserve.talkersFocusTip")}
                  onClick={() => onFocusSubject(talker.subject)}
                  className="min-w-0 truncate text-left text-accent hover:underline"
                >
                  {talker.subject}
                </button>
                <div className="flex shrink-0 items-baseline gap-2 text-text-muted">
                  <span className="font-semibold text-text">×{talker.count}</span>
                  <span className="w-12 text-right text-text-faint">{talker.percentage.toFixed(1)}%</span>
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
