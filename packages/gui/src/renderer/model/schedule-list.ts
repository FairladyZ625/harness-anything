import type { ScheduleGuiListRowDto, ScheduleGuiRowDto } from "@harness-anything/daemon/protocol";
import { t } from "../i18n/index.tsx";
import { dayKeyOf, formatTime } from "./time.ts";

// 定时计划列表的分档、排序与时间写法。全部只读 daemon 给的行事实(状态、健康分类、
// 错过次数、下次运行时间),不重算 cadence/nextRun,也不自己判健康。

const DAY_MS = 86_400_000;

/** 需要关注 = 无效定义,或在跑且健康降级 / 错过运行 / 执行目标不可用。 */
export function needsAttention(row: ScheduleGuiListRowDto): boolean {
  if (row.state === "invalid") return true;
  if (row.state !== "armed") return false;
  return row.health.bucket === "degraded" || row.missed.count > 0 || row.targetState !== undefined;
}

/** 注意力序:无效定义最先(要人修),健康降级次之,再按错过的次数,最后按下次运行时间。 */
function attentionRank(row: ScheduleGuiListRowDto): number {
  if (row.state === "invalid") return 0;
  if (row.health.bucket === "degraded") return 1;
  if (row.missed.count > 0) return 2;
  return 3;
}

const nextRunAtOf = (row: ScheduleGuiListRowDto) => (row.state === "invalid" ? "" : (row.nextRunAt ?? ""));

export interface ScheduleTiers {
  /** 需要关注:大卡,无效定义排最前。 */
  readonly attention: readonly ScheduleGuiListRowDto[];
  /** 运行正常:计划总数不超过 6 个时也用大卡,超过时用小卡。 */
  readonly normal: readonly ScheduleGuiRowDto[];
  readonly normalSize: "large" | "small";
  /** 已暂停:小方块沉底。 */
  readonly paused: readonly ScheduleGuiRowDto[];
}

/** 互斥三档;`total` 是筛选前的计划总数——卡片大小不随筛选跳变。 */
export function scheduleTiers(rows: readonly ScheduleGuiListRowDto[], total: number): ScheduleTiers {
  const byNextRun = (left: ScheduleGuiListRowDto, right: ScheduleGuiListRowDto) =>
    nextRunAtOf(left).localeCompare(nextRunAtOf(right)) || left.scheduleId.localeCompare(right.scheduleId);
  return {
    attention: rows
      .filter(needsAttention)
      .sort((left, right) => attentionRank(left) - attentionRank(right) || byNextRun(left, right)),
    normal: rows
      .filter((row): row is ScheduleGuiRowDto => row.state === "armed" && !needsAttention(row))
      .sort(byNextRun),
    normalSize: total <= 6 ? "large" : "small",
    paused: rows.filter((row): row is ScheduleGuiRowDto => row.state === "paused"),
  };
}

/** 「接下来」一行:已启用且有下次运行时间的计划按时间升序取最近 `limit` 次,其余只报个数。 */
export function upcomingRuns(
  rows: readonly ScheduleGuiListRowDto[],
  limit = 5,
): { readonly next: readonly ScheduleGuiRowDto[]; readonly more: number } {
  const armed = rows
    .filter((row): row is ScheduleGuiRowDto => row.state === "armed" && row.nextRunAt !== null)
    .sort(
      (left, right) =>
        (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? "") || left.scheduleId.localeCompare(right.scheduleId),
    );
  return { next: armed.slice(0, limit), more: Math.max(0, armed.length - limit) };
}

const INTERVAL_UNITS = [
  [DAY_MS, "schedules.trigger.everyDays"],
  [3_600_000, "schedules.trigger.everyHours"],
  [60_000, "schedules.trigger.everyMinutes"],
] as const;

/**
 * 触发规则的人话写法,纯格式化:间隔取能整除的最大单位(「每 6 小时」);cron 只认「分、时
 * 为数字,日/月/周都是 *」这一种(「每天 23:30(时区)」)。其余原样用 daemon 给的 `summary`;
 * 英文文案就是 `{summary}`,所以英文环境始终显示 daemon 原文。
 */
export function triggerLabel(trigger: ScheduleGuiRowDto["trigger"]): string {
  const { summary } = trigger;
  if (trigger.kind === "interval") {
    const unit = INTERVAL_UNITS.find(([ms]) => trigger.everyMs % ms === 0);
    return unit === undefined ? summary : t(unit[1], { count: trigger.everyMs / unit[0], summary });
  }
  const daily = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/u.exec(trigger.expression.trim());
  return daily === null
    ? summary
    : t("schedules.trigger.dailyAt", {
        time: `${daily[2]!.padStart(2, "0")}:${daily[1]!.padStart(2, "0")}`,
        timezone: trigger.timezone,
        summary,
      });
}

export type ScheduleVerdict = "failed" | "degraded" | "ok" | "never";

/** 卡上的结论:上次失败 > 健康降级但上次没失败 > 从未运行 > 正常。 */
export function scheduleVerdict(row: Pick<ScheduleGuiRowDto, "lastRun" | "health">): ScheduleVerdict {
  if (row.lastRun?.outcome === "failed") return "failed";
  if (row.health.bucket === "degraded") return "degraded";
  return row.lastRun === null ? "never" : "ok";
}

/** 本地日历日的序号(用户时区),两个时刻相减即相隔几天。 */
function dayIndex(iso: string): number | null {
  const key = dayKeyOf(iso);
  return key === null ? null : Date.parse(`${key}T00:00:00Z`) / DAY_MS;
}

/**
 * 时刻的短写法:当天只写时分(`today: "named"` 时写「今天 13:07」),前后一天写「明天/昨天 02:00」,
 * 再远写「10-03 02:00」。
 */
export function dayClock(iso: string, now: number, today: "bare" | "named" = "bare"): string {
  const time = formatTime(iso, { style: "time" }),
    day = dayIndex(iso),
    nowDay = dayIndex(new Date(now).toISOString());
  if (time === null || day === null || nowDay === null) return iso;
  if (day === nowDay) return today === "named" ? t("schedules.clock.today", { time }) : time;
  if (day === nowDay + 1) return t("schedules.clock.tomorrow", { time });
  if (day === nowDay - 1) return t("schedules.clock.yesterday", { time });
  return formatTime(iso, { style: "month-day-time", now }) ?? iso;
}

/** 距下次运行还有多久(「3 小时后」);时间已到或已过返回 null,不编一个未来。 */
export function untilLabel(iso: string, now: number): string | null {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 3600) return t("schedules.until.minutes", { minutes: Math.max(1, Math.floor(seconds / 60)) });
  if (seconds < 86_400) return t("schedules.until.hours", { hours: Math.floor(seconds / 3600) });
  return t("schedules.until.days", { days: Math.floor(seconds / 86_400) });
}
