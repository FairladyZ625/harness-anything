// harness-test-tier: fast
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIME_DISPLAY_PREFS,
  TIME_DISPLAY_STORAGE_KEY,
  dayKeyOf,
  formatDayKeyLabel,
  formatDuration,
  formatListTime,
  formatRelative,
  formatTime,
  readTimeDisplayPrefs,
  writeTimeDisplayPrefs,
  type TimeDisplayPrefs,
} from "../src/renderer/model/time.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

// 时间显示唯一实现的单元测试:绝对/相对/时长/列表时间/日键在不同时区与格式下的输出,
// 以及偏好写入后下一次调用立即生效(视图切走重挂载即读到新值,无需重启)。

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
};

const prefs = (partial: Partial<TimeDisplayPrefs>): TimeDisplayPrefs => ({ ...DEFAULT_TIME_DISPLAY_PREFS, ...partial });

beforeAll(() => {
  setActiveLocale("zh-CN");
  vi.stubGlobal("localStorage", memoryStorage());
});
afterEach(() => {
  localStorage.clear();
});

describe("time display preferences storage", () => {
  it("round-trips a full preference object", () => {
    const next = prefs({ timeZone: "America/Los_Angeles", dateFormat: "long", hour12: true, listStyle: "absolute" });
    writeTimeDisplayPrefs(next);
    expect(readTimeDisplayPrefs()).toEqual(next);
  });

  it("keeps defaults when nothing is stored and repairs unknown fields instead of throwing", () => {
    expect(readTimeDisplayPrefs()).toEqual(DEFAULT_TIME_DISPLAY_PREFS);
    localStorage.setItem(
      TIME_DISPLAY_STORAGE_KEY,
      JSON.stringify({ timeZone: "Mars/Olympus", dateFormat: "swiss", hour12: "yes", listStyle: "sometimes" }),
    );
    expect(readTimeDisplayPrefs()).toEqual(DEFAULT_TIME_DISPLAY_PREFS);
    localStorage.setItem(TIME_DISPLAY_STORAGE_KEY, "not json");
    expect(readTimeDisplayPrefs()).toEqual(DEFAULT_TIME_DISPLAY_PREFS);
  });

  it("rejects an unsupported time zone on write instead of persisting it", () => {
    expect(() => writeTimeDisplayPrefs(prefs({ timeZone: "Mars/Olympus" }))).toThrow(/Unsupported time zone/u);
    expect(localStorage.getItem(TIME_DISPLAY_STORAGE_KEY)).toBeNull();
  });
});

describe("formatTime", () => {
  const iso = "2026-08-26T02:44:00.000Z";

  it("renders the same instant in the selected time zone", () => {
    expect(formatTime(iso, { tz: "UTC", style: "date-time" })).toBe("2026-08-26 02:44");
    expect(formatTime(iso, { tz: "Asia/Taipei", style: "date-time" })).toBe("2026-08-26 10:44");
    expect(formatTime(iso, { tz: "America/Los_Angeles", style: "date-time-seconds" })).toBe("2026-08-25 19:44:00");
  });

  it("honours the stored time zone preference for callers that pass no explicit zone", () => {
    writeTimeDisplayPrefs(prefs({ timeZone: "America/Los_Angeles" }));
    expect(formatTime(iso, { style: "date-time" })).toBe("2026-08-25 19:44");
    expect(formatTime(iso, { style: "date-time", prefs: prefs({ timeZone: "UTC" }) })).toBe("2026-08-26 02:44");
  });

  it("renders the selected date format", () => {
    writeTimeDisplayPrefs(prefs({ timeZone: "UTC" }));
    expect(formatTime(iso, { style: "date-time" })).toBe("2026-08-26 02:44");
    writeTimeDisplayPrefs(prefs({ timeZone: "UTC", dateFormat: "month-day" }));
    expect(formatTime(iso, { style: "date-time" })).toBe("08-26 02:44");
    writeTimeDisplayPrefs(prefs({ timeZone: "UTC", dateFormat: "long" }));
    expect(formatTime(iso, { style: "date-time" })).toBe("8月26日 02:44");
    // month-day-time 在调用点上强制省年份,不受偏好改写。
    expect(formatTime(iso, { style: "month-day-time", prefs: prefs({ timeZone: "UTC" }) })).toBe("08-26 02:44");
  });

  it("renders the 12-hour clock with a locale day period", () => {
    const evening = "2026-08-26T19:02:00.000Z";
    expect(formatTime(evening, { tz: "UTC", style: "date-time", prefs: prefs({ hour12: true }) })).toBe(
      "2026-08-26 下午07:02",
    );
    setActiveLocale("en-US");
    expect(formatTime(evening, { tz: "UTC", style: "date-time", prefs: prefs({ hour12: true }) })).toBe(
      "2026-08-26 07:02 PM",
    );
    expect(formatTime(evening, { tz: "UTC", style: "time-seconds", prefs: prefs({ hour12: true }) })).toBe(
      "07:02:00 PM",
    );
    setActiveLocale("zh-CN");
    expect(formatTime("2026-08-26T19:02:00.000Z", { tz: "UTC", style: "time", prefs: prefs({ hour12: true }) })).toBe(
      "下午07:02",
    );
  });

  it("collapses same-day timestamps to 今天 + time and keeps full dates otherwise", () => {
    const now = "2026-10-01T11:02:00.000Z";
    writeTimeDisplayPrefs(prefs({ timeZone: "UTC" }));
    expect(formatTime("2026-10-01T15:56:00.000Z", { style: "date-time", now })).toBe("今天 15:56");
    expect(formatTime("2026-10-01T15:56:30.000Z", { style: "date-time-seconds", now })).toBe("今天 15:56:30");
    expect(formatTime("2026-09-30T15:56:00.000Z", { style: "date-time", now })).toBe("2026-09-30 15:56");
    // 「今天」按所选时区的日历日判断:UTC 的 10-01 凌晨在洛杉矶还是 09-30。
    expect(
      formatTime("2026-10-01T02:56:00.000Z", {
        style: "date-time",
        now,
        prefs: prefs({ timeZone: "America/Los_Angeles" }),
      }),
    ).toBe("2026-09-30 19:56");
  });

  it("returns null for invalid input instead of inventing a display time", () => {
    expect(formatTime("not-a-timestamp", { tz: "UTC", style: "time" })).toBeNull();
  });
});

describe("day keys", () => {
  it("keys calendar days in the selected time zone", () => {
    writeTimeDisplayPrefs(prefs({ timeZone: "UTC" }));
    expect(dayKeyOf("2026-10-01T23:59:00.000Z")).toBe("2026-10-01");
    expect(dayKeyOf("2026-10-01T23:59:00.000Z", { prefs: prefs({ timeZone: "Asia/Taipei" }) })).toBe("2026-10-02");
    expect(dayKeyOf("not-a-timestamp")).toBeNull();
  });

  it("labels day keys without the year, following the date format preference", () => {
    expect(formatDayKeyLabel("2026-10-01", prefs({ dateFormat: "iso" }))).toBe("10-01");
    expect(formatDayKeyLabel("2026-10-01", prefs({ dateFormat: "month-day" }))).toBe("10-01");
    setActiveLocale("zh-CN");
    expect(formatDayKeyLabel("2026-10-01", prefs({ dateFormat: "long" }))).toBe("10月1日");
    setActiveLocale("en-US");
    expect(formatDayKeyLabel("2026-10-01", prefs({ dateFormat: "long" }))).toBe("Oct 1");
    setActiveLocale("zh-CN");
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-10-01T12:00:00.000Z");

  it("uses one wording across the tiers in both locales", () => {
    writeTimeDisplayPrefs(prefs({ timeZone: "UTC" }));
    expect(formatRelative("2026-10-01T11:59:30.000Z", { now })).toBe("刚刚");
    expect(formatRelative("2026-10-01T11:55:00.000Z", { now })).toBe("5 分钟前");
    expect(formatRelative("2026-10-01T09:00:00.000Z", { now })).toBe("3 小时前");
    expect(formatRelative("2026-09-29T12:00:00.000Z", { now })).toBe("2 天前");
    // 超过 30 天回落绝对时间(按所选时区与格式)。
    expect(formatRelative("2026-07-01T02:44:00.000Z", { now, prefs: prefs({ timeZone: "Asia/Taipei" }) })).toBe(
      "2026-07-01 10:44",
    );
    setActiveLocale("en-US");
    expect(formatRelative("2026-10-01T09:00:00.000Z", { now })).toBe("3 h ago");
    expect(formatRelative("2026-09-29T12:00:00.000Z", { now })).toBe("2 d ago");
    setActiveLocale("zh-CN");
  });

  it("clamps future timestamps to 刚刚 instead of negative ages", () => {
    expect(formatRelative("2026-10-01T12:00:30.000Z", { now })).toBe("刚刚");
  });

  it("echoes unparseable input instead of inventing an age", () => {
    expect(formatRelative("not-a-timestamp", { now })).toBe("not-a-timestamp");
  });

  it("accepts epoch milliseconds for second-age callers (sidebar health)", () => {
    expect(formatRelative(now - 90_000, { now })).toBe("1 分钟前");
  });
});

describe("formatListTime", () => {
  const iso = "2026-10-01T09:00:00.000Z",
    now = "2026-10-01T12:00:00.000Z";

  it("follows the list style preference", () => {
    writeTimeDisplayPrefs(prefs({ timeZone: "UTC", listStyle: "relative" }));
    expect(formatListTime(iso, { now })).toBe("3 小时前");
    writeTimeDisplayPrefs(prefs({ timeZone: "UTC", listStyle: "absolute" }));
    expect(formatListTime(iso, { now })).toBe("今天 09:00");
  });

  it("applies immediately after a preference write, without restart", () => {
    writeTimeDisplayPrefs(prefs({ timeZone: "UTC", listStyle: "relative", dateFormat: "iso" }));
    expect(formatListTime(iso, { now })).toBe("3 小时前");
    writeTimeDisplayPrefs(prefs({ timeZone: "UTC", listStyle: "absolute", dateFormat: "month-day" }));
    expect(formatListTime(iso, { now })).toBe("今天 09:00");
    writeTimeDisplayPrefs(prefs({ timeZone: "UTC", listStyle: "absolute" }));
    expect(formatTime("2026-09-18T11:02:00.000Z", { style: "date-time" })).toBe("2026-09-18 11:02");
    writeTimeDisplayPrefs(prefs({ timeZone: "UTC", dateFormat: "long" }));
    expect(formatTime("2026-09-18T11:02:00.000Z", { style: "date-time" })).toBe("9月18日 11:02");
  });
});

describe("formatDuration", () => {
  it("keeps one compact wording across the tiers", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(230)).toBe("230ms");
    expect(formatDuration(1_600)).toBe("1.6s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(285_000)).toBe("4m 45s");
    expect(formatDuration(360_000)).toBe("6m");
    expect(formatDuration(7_200_000)).toBe("2h");
    expect(formatDuration(9_000_000)).toBe("2h 30m");
    expect(formatDuration(900_610_000)).toBe("10d 10h");
    expect(formatDuration(3 * 86_400_000)).toBe("3d");
  });

  it("keeps unknown durations honest instead of echoing machine values", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(null, "?")).toBe("?");
  });
});
