import { consumeKnownError } from "../../api/error-consumption.ts";

export type TimeStyle = "date" | "date-time" | "date-time-seconds" | "month-day-time" | "time" | "time-seconds";
export interface FormatTimeOptions {
  readonly tz?: string;
  readonly style: TimeStyle;
}
type TimeZoneStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const TIME_ZONE_STORAGE_KEY = "harness:gui:time-zone";

export function formatTime(iso: string, options: FormatTimeOptions): string | null {
  const date = new Date(iso),
    wantsDate = !options.style.startsWith("time"),
    wantsTime = options.style !== "date",
    wantsYear = wantsDate && options.style !== "month-day-time",
    wantsSeconds = options.style.endsWith("seconds");
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        ...(wantsYear ? { year: "numeric" as const } : {}),
        ...(wantsDate ? { month: "2-digit" as const, day: "2-digit" as const } : {}),
        ...(wantsTime ? { hour: "2-digit" as const, minute: "2-digit" as const } : {}),
        ...(wantsSeconds ? { second: "2-digit" as const } : {}),
        hourCycle: "h23",
        timeZone: resolveTimeZone(options.tz),
      })
        .formatToParts(date)
        .map(({ type, value }) => [type, value]),
    ),
    datePart = wantsDate ? `${wantsYear ? `${parts.year}-` : ""}${parts.month}-${parts.day}` : "",
    timePart = wantsTime ? `${parts.hour}:${parts.minute}${wantsSeconds ? `:${parts.second}` : ""}` : "";
  return [datePart, timePart].filter(Boolean).join(" ");
}

export const systemTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function readTimeZoneOverride(storage: TimeZoneStorage | null = browserStorage()): string | null {
  if (storage === null) return null;
  try {
    const value = storage.getItem(TIME_ZONE_STORAGE_KEY);
    return value !== null && validTimeZone(value) ? value : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

export function writeTimeZoneOverride(value: string | null, storage: TimeZoneStorage | null = browserStorage()): void {
  if (storage === null) return;
  if (value !== null && !validTimeZone(value)) throw new Error(`Unsupported time zone: ${value}`);
  if (value === null) storage.removeItem(TIME_ZONE_STORAGE_KEY);
  else storage.setItem(TIME_ZONE_STORAGE_KEY, value);
}

export function supportedTimeZones(): readonly string[] {
  return ["UTC", ...Intl.supportedValuesOf("timeZone").filter((value) => value !== "UTC")];
}

function resolveTimeZone(explicit?: string): string {
  const timeZone = explicit ?? readTimeZoneOverride() ?? systemTimeZone();
  if (!validTimeZone(timeZone)) throw new Error(`Unsupported time zone: ${timeZone}`);
  return timeZone;
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch (error) {
    consumeKnownError(error);
    return false;
  }
}

function browserStorage(): TimeZoneStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}
