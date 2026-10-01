import { consumeKnownError } from "../../api/error-consumption.ts";
import { currentLocale, t } from "../i18n/core.ts";

/**
 * renderer 时间显示的唯一实现:绝对时间、相对时间、时长、列表时间、日键都从这里出,
 * 别处不得再自拼写法(eslint no-restricted-syntax 禁 renderer 的 toLocale 系与 Date getter)。
 * daemon 给的时间一律是 UTC,这里换算到用户所选时区;偏好存本机 localStorage,不进仓库设置。
 */

export type TimeStyle = "date" | "date-time" | "date-time-seconds" | "month-day-time" | "time" | "time-seconds";
export type DateFormatPref = "iso" | "month-day" | "long";
export type ListTimeStyle = "relative" | "absolute";

export interface TimeDisplayPrefs {
  /** null = 跟随系统;否则为已验证的 IANA 时区。 */
  readonly timeZone: string | null;
  readonly dateFormat: DateFormatPref;
  readonly hour12: boolean;
  readonly listStyle: ListTimeStyle;
}

export interface FormatTimeOptions {
  readonly style: TimeStyle;
  readonly tz?: string;
  readonly now?: string | number;
  readonly prefs?: TimeDisplayPrefs;
}

type TimeZoneStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const TIME_DISPLAY_STORAGE_KEY = "harness:gui:time-display";
export const DEFAULT_TIME_DISPLAY_PREFS: TimeDisplayPrefs = {
  timeZone: null,
  dateFormat: "iso",
  hour12: false,
  listStyle: "relative",
};

const DATE_FORMATS: readonly DateFormatPref[] = ["iso", "month-day", "long"];
const formatters = new Map<string, Intl.DateTimeFormat>();
const validTimeZones = new Set<string>();

/** 绝对时间:形状由 style(要哪些部件)+ 偏好(日期写法、12/24 小时制、时区)决定;同一天省略日期(「今天 19:02」)。 */
export function formatTime(iso: string, options: FormatTimeOptions): string | null {
  const date = new Date(iso),
    wantsDate = !options.style.startsWith("time"),
    wantsTime = options.style !== "date",
    wantsSeconds = options.style.endsWith("seconds");
  if (!Number.isFinite(date.getTime())) return null;
  const prefs = options.prefs ?? readTimeDisplayPrefs(),
    timeZone = resolveTimeZone(options.tz ?? prefs.timeZone);
  if (wantsDate && wantsTime) {
    const now = new Date(options.now === undefined ? Date.now() : toMs(options.now));
    if (dayKeyFromDate(date, timeZone) === dayKeyFromDate(now, timeZone)) {
      return t("model.time.todayAt", { time: timePart(date, wantsSeconds, timeZone, prefs) });
    }
  }
  const dateShape = options.style === "month-day-time" ? "month-day" : prefs.dateFormat,
    datePart = wantsDate ? datePartOf(date, dateShape, timeZone) : "",
    clockPart = wantsTime ? timePart(date, wantsSeconds, timeZone, prefs) : "";
  return [datePart, clockPart].filter(Boolean).join(" ");
}

/** 本地日历日的键(用户时区的 `YYYY-MM-DD`),用于分组与今天/昨天比较;显示写法用 formatDayKeyLabel。 */
export function dayKeyOf(
  iso: string,
  options: { readonly tz?: string; readonly prefs?: TimeDisplayPrefs } = {},
): string | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const prefs = options.prefs ?? readTimeDisplayPrefs();
  return dayKeyFromDate(date, resolveTimeZone(options.tz ?? prefs.timeZone));
}

/** 日键的人读写法(不带年份):`10-01` / `10月1日`(随日期格式偏好)。 */
export function formatDayKeyLabel(dayKey: string, prefs: TimeDisplayPrefs = readTimeDisplayPrefs()): string {
  if (prefs.dateFormat !== "long") return dayKey.slice(5);
  const ms = Date.parse(`${dayKey}T00:00:00Z`);
  return Number.isFinite(ms) ? longDateOf(new Date(ms), "UTC") : dayKey;
}

/** 相对时间(一种写法):刚刚 / N 分钟前 / N 小时前 / N 天前,超过 30 天回落绝对时间。 */
export function formatRelative(
  at: string | number,
  options: { readonly now?: string | number; readonly tz?: string; readonly prefs?: TimeDisplayPrefs } = {},
): string {
  const atMs = toMs(at);
  if (!Number.isFinite(atMs)) return typeof at === "string" ? at : "—";
  const nowMs = options.now === undefined ? Date.now() : toMs(options.now),
    seconds = Math.max(0, Math.round((nowMs - atMs) / 1_000));
  if (seconds < 60) return t("model.time.justNow");
  if (seconds < 3_600) return t("model.time.minutesAgo", { minutes: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t("model.time.hoursAgo", { hours: Math.floor(seconds / 3_600) });
  if (seconds < 30 * 86_400) return t("model.time.daysAgo", { days: Math.floor(seconds / 86_400) });
  return (
    formatTime(typeof at === "string" ? at : new Date(atMs).toISOString(), {
      style: "date-time",
      tz: options.tz,
      now: nowMs,
      prefs: options.prefs,
    }) ?? (typeof at === "string" ? at : "—")
  );
}

/** 列表行尾的时间:按偏好选相对或绝对;悬停的绝对时间用 formatTime(date-time-seconds)。 */
export function formatListTime(
  at: string | number,
  options: { readonly now?: string | number; readonly tz?: string; readonly prefs?: TimeDisplayPrefs } = {},
): string {
  const prefs = options.prefs ?? readTimeDisplayPrefs();
  return prefs.listStyle === "relative"
    ? formatRelative(at, options)
    : ((typeof at === "string"
        ? formatTime(at, { style: "date-time", tz: options.tz, now: options.now, prefs })
        : formatTime(new Date(toMs(at)).toISOString(), {
            style: "date-time",
            tz: options.tz,
            now: options.now,
            prefs,
          })) ?? (typeof at === "string" ? at : "—"));
}

/** 时长(一种紧凑写法):`45ms` / `1.6s` / `45s` / `4m 45s` / `2h 30m` / `1d 2h`;未知(NaN/负数/缺投影)回落占位词。 */
export function formatDuration(uptimeMs: number | null | undefined, unknown = "—"): string {
  if (typeof uptimeMs !== "number" || !Number.isFinite(uptimeMs) || uptimeMs < 0) return unknown;
  const msRounded = Math.round(uptimeMs),
    totalSeconds = Math.round(uptimeMs / 1_000);
  if (totalSeconds === 0) return msRounded === 0 ? "0s" : `${msRounded}ms`;
  // 1–10 秒保留一位小数:慢操作看板的 P50/P95 在这一段,取整会抹掉差异。
  if (totalSeconds < 10) return `${(msRounded / 1_000).toFixed(1)}s`;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60),
    seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60),
    restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  const days = Math.floor(hours / 24),
    restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

export const systemTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function readTimeDisplayPrefs(storage: TimeZoneStorage | null = browserStorage()): TimeDisplayPrefs {
  if (storage === null) return DEFAULT_TIME_DISPLAY_PREFS;
  let raw: string | null;
  try {
    raw = storage.getItem(TIME_DISPLAY_STORAGE_KEY);
  } catch (error) {
    consumeKnownError(error);
    return DEFAULT_TIME_DISPLAY_PREFS;
  }
  if (raw === null) return DEFAULT_TIME_DISPLAY_PREFS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return DEFAULT_TIME_DISPLAY_PREFS;
    const value = parsed as Partial<TimeDisplayPrefs>;
    return {
      timeZone: typeof value.timeZone === "string" && validTimeZone(value.timeZone) ? value.timeZone : null,
      dateFormat: DATE_FORMATS.includes(value.dateFormat as DateFormatPref)
        ? (value.dateFormat as DateFormatPref)
        : "iso",
      hour12: value.hour12 === true,
      listStyle: value.listStyle === "absolute" ? "absolute" : "relative",
    };
  } catch (error) {
    consumeKnownError(error);
    return DEFAULT_TIME_DISPLAY_PREFS;
  }
}

export function writeTimeDisplayPrefs(
  prefs: TimeDisplayPrefs,
  storage: TimeZoneStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  if (prefs.timeZone !== null && !validTimeZone(prefs.timeZone)) {
    throw new Error(`Unsupported time zone: ${prefs.timeZone}`);
  }
  storage.setItem(
    TIME_DISPLAY_STORAGE_KEY,
    JSON.stringify({
      timeZone: prefs.timeZone,
      dateFormat: DATE_FORMATS.includes(prefs.dateFormat) ? prefs.dateFormat : "iso",
      hour12: prefs.hour12 === true,
      listStyle: prefs.listStyle === "absolute" ? "absolute" : "relative",
    }),
  );
}

export function supportedTimeZones(): readonly string[] {
  return ["UTC", ...Intl.supportedValuesOf("timeZone").filter((value) => value !== "UTC")];
}

function toMs(at: string | number): number {
  return typeof at === "number" ? at : Date.parse(at);
}

function resolveTimeZone(explicit: string | null | undefined): string {
  const timeZone = explicit ?? systemTimeZone();
  if (!validTimeZone(timeZone)) throw new Error(`Unsupported time zone: ${timeZone}`);
  return timeZone;
}

function dayKeyFromDate(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    cachedFormatter(`date-key\u0000${timeZone}`, () => numericDateOptions(timeZone))
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function datePartOf(date: Date, shape: DateFormatPref, timeZone: string): string {
  if (shape === "long") return longDateOf(date, timeZone);
  const parts = Object.fromEntries(
    cachedFormatter(`date-part\u0000${timeZone}`, () => numericDateOptions(timeZone))
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return shape === "iso" ? `${parts.year}-${parts.month}-${parts.day}` : `${parts.month}-${parts.day}`;
}

function numericDateOptions(timeZone: string): Intl.DateTimeFormatOptions {
  return { year: "numeric", month: "2-digit", day: "2-digit", timeZone };
}

/** 人话长日期:zh 手工拼「10月1日」(Intl 的数字月日是 10/1),en 用短月名「Oct 1」。 */
function longDateOf(date: Date, timeZone: string): string {
  if (currentLocale() === "zh-CN") {
    const parts = Object.fromEntries(
      cachedFormatter(`date-part\u0000${timeZone}`, () => numericDateOptions(timeZone))
        .formatToParts(date)
        .map(({ type, value }) => [type, value]),
    );
    return `${Number(parts.month)}月${Number(parts.day)}日`;
  }
  return cachedFormatter(`date-long\u0000${timeZone}`, () => ({
    month: "short" as const,
    day: "numeric" as const,
    timeZone,
  })).format(date);
}

function timePart(date: Date, wantsSeconds: boolean, timeZone: string, prefs: TimeDisplayPrefs): string {
  const locale = currentLocale(),
    formatter = cachedFormatter(
      `time\u0000${timeZone}\u0000${locale}\u0000${prefs.hour12 ? "h12" : "h23"}\u0000${wantsSeconds ? "s" : ""}`,
      () => ({
        hour: "2-digit",
        minute: "2-digit",
        ...(wantsSeconds ? { second: "2-digit" as const } : {}),
        hourCycle: prefs.hour12 ? ("h12" as const) : ("h23" as const),
        timeZone,
      }),
    ),
    parts = formatter.formatToParts(date),
    by = Object.fromEntries(parts.map(({ type, value }) => [type, value])),
    clock = `${by.hour}:${by.minute}${wantsSeconds ? `:${by.second}` : ""}`,
    dayPeriodIndex = parts.findIndex(({ type }) => type === "dayPeriod");
  if (dayPeriodIndex < 0 || by.dayPeriod === undefined) return clock;
  // zh 的时段在数字前(「下午7:02」),en 在后(「7:02 PM」);按 Intl 部件顺序拼。
  return dayPeriodIndex < parts.findIndex(({ type }) => type === "hour")
    ? `${by.dayPeriod}${clock}`
    : `${clock} ${by.dayPeriod}`;
}

function cachedFormatter(key: string, options: () => Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cached = formatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(currentLocale(), options());
  formatters.set(key, formatter);
  return formatter;
}

function validTimeZone(value: string): boolean {
  if (validTimeZones.has(value)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    validTimeZones.add(value);
    return true;
  } catch (error) {
    consumeKnownError(error);
    return false;
  }
}

function browserStorage(): TimeZoneStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}
