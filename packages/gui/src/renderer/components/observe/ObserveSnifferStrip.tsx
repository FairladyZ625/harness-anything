import { memo } from "react";
import { ArrowClockwise, CheckCircle, Lock, WarningCircle } from "@phosphor-icons/react";
import { t } from "../../i18n/index.tsx";
import {
  OBSERVE_SLOW_LOCK_MS,
  type ObserveSmellStat,
  type ObserveStats,
  type ObserveWindowSpan,
} from "../../daemon-observe-stats.ts";

/**
 * 智能异味嗅探条(数据推导在 daemon-observe-stats 的 deriveWindow,组件只呈现):
 *  - 慢锁写操作 / 频密轮询 / 失败毛刺被嗅探到时展示彩色警报 Tag,点击 Tag 把透镜
 *    (或过滤框)收敛到该病灶方法;无异味时展示清爽的「运行平稳 (Healthy)」;
 *  - 右侧常驻三枚系统级指示徽标:单写锁争用级别 + 读写比 + 信噪比(产出 vs 机械巡检),
 *    全部与 HUD 的 15m/1h 窗口同步;
 *  - 日志栏才有读写/争用语义(事件流没有 commandClass/耗时),事件栏只显示嗅探与信噪。
 */

const SMELL_TONE: Record<ObserveSmellStat["kind"], string> = {
    slow_lock_holder: "border-status-blocked/40 bg-status-blocked/10 text-status-blocked",
    spinloop_polling: "border-stale/40 bg-stale/10 text-stale",
    spike_failures: "border-status-blocked/40 bg-status-blocked/10 text-status-blocked",
  },
  LEVEL_TONE = {
    smooth: "border-status-done/40 bg-status-done/10 text-status-done",
    mild: "border-stale/40 bg-stale/10 text-stale",
    contended: "border-status-blocked/40 bg-status-blocked/10 text-status-blocked",
  } as const,
  METRIC_CHIP = "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono",
  SMELL_CHIP = [
    "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono",
    "max-w-[26ch] hover:brightness-125",
  ].join(" "),
  LEVEL_KEY = {
    smooth: "views.daemonObserve.contentionSmooth",
    mild: "views.daemonObserve.contentionMild",
    contended: "views.daemonObserve.contentionContended",
  } as const;

const smellText = (smell: ObserveSmellStat): string => {
  switch (smell.kind) {
    case "slow_lock_holder":
      return t("views.daemonObserve.smellSlowLock", {
        method: smell.label,
        ms: String(Math.round(smell.value)),
      });
    case "spinloop_polling":
      return t("views.daemonObserve.smellPolling", {
        method: smell.label,
        rate: String(Math.round(smell.value * 10) / 10),
      });
    default:
      return t("views.daemonObserve.smellFailures", { pct: String(Math.round(smell.value)) });
  }
};

const SmellIcon = ({ kind }: { readonly kind: ObserveSmellStat["kind"] }) =>
  kind === "slow_lock_holder" ? (
    <Lock aria-hidden />
  ) : kind === "spinloop_polling" ? (
    <ArrowClockwise aria-hidden />
  ) : (
    <WarningCircle aria-hidden />
  );

export const ObserveSnifferStrip = memo(function ObserveSnifferStrip({
  testId,
  stats,
  window,
  isLogPane,
  onFocusSmell,
}: {
  /** data-testid 前缀(pane 传 observe-sniffer-<kind>);异味派生 `-smell`、健康 `-healthy`。 */
  readonly testId: string;
  readonly stats: ObserveStats;
  readonly window: ObserveWindowSpan;
  readonly isLogPane: boolean;
  readonly onFocusSmell: (matchText: string) => void;
}) {
  const derived = stats.windows[window],
    contention = derived.contention,
    signal = derived.signal,
    classified = contention.writeOps + contention.readOps,
    writePct = classified > 0 ? `${Math.round(contention.writePct)}%` : "—",
    progressPct = signal.progress + signal.overhead > 0 ? `${Math.round(signal.progressPct)}%` : "—",
    levelLabel = t(LEVEL_KEY[contention.level]);
  return (
    <div
      data-testid={testId}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1 font-mono ui-micro"
    >
      <span className="shrink-0 text-text-faint">{t("views.daemonObserve.sniffLabel")}</span>
      {derived.smells.length === 0 ? (
        <span
          data-testid={`${testId}-healthy`}
          className={`${METRIC_CHIP} ${LEVEL_TONE.smooth}`}
          title={t("views.daemonObserve.sniffHealthyTip")}
        >
          <CheckCircle aria-hidden />
          {t("views.daemonObserve.sniffHealthy")}
        </span>
      ) : (
        derived.smells.map((smell) =>
          smell.matchText === "" ? (
            <span key={smell.kind} className={`${METRIC_CHIP} ${SMELL_TONE[smell.kind]}`}>
              <SmellIcon kind={smell.kind} />
              <span className="truncate">{smellText(smell)}</span>
            </span>
          ) : (
            <button
              key={smell.kind}
              type="button"
              data-testid={`${testId}-smell`}
              title={t("views.daemonObserve.smellFocusTip")}
              onClick={() => onFocusSmell(smell.matchText)}
              className={`${SMELL_CHIP} ${SMELL_TONE[smell.kind]}`}
            >
              <SmellIcon kind={smell.kind} />
              <span className="truncate">{smellText(smell)}</span>
            </button>
          ),
        )
      )}
      <span className="ml-auto flex flex-wrap items-center gap-2">
        {isLogPane ? (
          <span
            data-testid={`${testId}-contention`}
            className={`${METRIC_CHIP} ${LEVEL_TONE[contention.level]}`}
            title={t("views.daemonObserve.contentionTip", {
              slow: String(contention.slowWrites),
              overlap: String(contention.overlap),
              threshold: String(OBSERVE_SLOW_LOCK_MS),
            })}
          >
            <Lock aria-hidden />
            {t("views.daemonObserve.contentionLabel")} {levelLabel}
          </span>
        ) : null}
        {isLogPane ? (
          <span
            data-testid={`${testId}-rw`}
            className={`${METRIC_CHIP} border-border text-text-muted`}
            title={t("views.daemonObserve.rwTip")}
          >
            {t("views.daemonObserve.rwSummary", {
              write: String(contention.writeOps),
              read: String(contention.readOps),
              pct: writePct,
            })}
          </span>
        ) : null}
        <span
          data-testid={`${testId}-signal`}
          className={`${METRIC_CHIP} border-border text-text-muted`}
          title={t("views.daemonObserve.signalTip", {
            progress: String(signal.progress),
            overhead: String(signal.overhead),
          })}
        >
          {t("views.daemonObserve.signalSummary", { pct: progressPct })}
        </span>
      </span>
    </div>
  );
});
