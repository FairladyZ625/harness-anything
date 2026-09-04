import { t, type MessageKey } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import type { ScheduleRunOutcomeWord } from "../../schedules-client.ts";

// 运行历史共享词表:outcome → 标签/色调/spark 颜色,missed 原因词表,duration/时间
// 格式化。列表 hub(ScheduleDetailView)与单次运行详情(ScheduleRunDetail)同源,
// 不各自维护一份映射。

export const RUN_OUTCOME_META: Record<ScheduleRunOutcomeWord, { readonly key: MessageKey; readonly tone: string }> = {
  running: { key: "schedules.outcome.running", tone: "active" },
  succeeded: { key: "schedules.outcome.succeeded", tone: "done" },
  failed: { key: "schedules.outcome.failed", tone: "blocked" },
  missed: { key: "schedules.outcome.missed", tone: "planned" },
  cancelled: { key: "schedules.outcome.cancelled", tone: "cancelled" },
  unknown: { key: "schedules.outcome.unknown", tone: "unknown" },
};

export const SPARK_COLOR: Record<ScheduleRunOutcomeWord, string> = {
  running: "var(--color-status-active)",
  succeeded: "var(--color-status-done)",
  failed: "var(--color-status-blocked)",
  missed: "var(--color-status-planned)",
  cancelled: "var(--color-status-cancelled)",
  unknown: "var(--color-status-unknown)",
};

const MISSED_REASON_META: Record<string, MessageKey> = {
  scheduler_unavailable: "schedules.missedReason.schedulerUnavailable",
  single_flight: "schedules.missedReason.singleFlight",
};

// Word → label lookups stay total: an unknown daemon word renders as its own
// text (missed reasons), never a crash.
export const missedReasonLabel = (reason: string | null): string =>
  reason === null ? "—" : reason in MISSED_REASON_META ? t(MISSED_REASON_META[reason]) : reason;

export const time = (iso: string | null): string =>
  iso === null ? "—" : (formatTime(iso, { style: "date-time" }) ?? iso);

export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60),
    seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  const hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}
