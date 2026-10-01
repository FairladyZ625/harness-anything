// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { totalQueueDepth } from "../src/renderer/views/SystemView.tsx";
import { formatDuration, formatTime, readTimeDisplayPrefs, writeTimeDisplayPrefs } from "../src/renderer/model/time.ts";

describe("GUI time service", () => {
  it("renders the same instant as UTC 02:44 and Taipei 10:44", () => {
    const iso = "2026-08-26T02:44:00.000Z",
      utc = formatTime(iso, { tz: "UTC", style: "date-time" }),
      taipei = formatTime(iso, { tz: "Asia/Taipei", style: "date-time" });
    console.info(`UTC=${utc} Asia/Taipei=${taipei}`);
    expect(utc).toBe("2026-08-26 02:44");
    expect(taipei).toBe("2026-08-26 10:44");
    expect(taipei).not.toBe(utc);
  });

  it("persists a valid time display preference and treats removal as system time", () => {
    const values = new Map<string, string>(),
      storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      };
    writeTimeDisplayPrefs(
      { timeZone: "Asia/Taipei", dateFormat: "iso", hour12: false, listStyle: "relative" },
      storage,
    );
    expect(readTimeDisplayPrefs(storage).timeZone).toBe("Asia/Taipei");
    writeTimeDisplayPrefs({ timeZone: null, dateFormat: "iso", hour12: false, listStyle: "relative" }, storage);
    expect(readTimeDisplayPrefs(storage).timeZone).toBeNull();
    expect(() =>
      writeTimeDisplayPrefs(
        { timeZone: "Mars/Olympus", dateFormat: "iso", hour12: false, listStyle: "relative" },
        storage,
      ),
    ).toThrow(/Unsupported time zone/u);
  });

  it("returns null for invalid input instead of inventing a display time", () => {
    expect(formatTime("not-a-timestamp", { tz: "UTC", style: "time" })).toBeNull();
  });
});

describe("system view user-facing detail (archive-line parity)", () => {
  it("formats raw uptime milliseconds into readable durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(61_000)).toBe("1m 1s");
    expect(formatDuration(3_723_000)).toBe("1h 2m");
    expect(formatDuration(900_610_000)).toBe("10d 10h");
  });

  it("keeps unknown uptime honest instead of echoing machine values", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });

  // archive 线的 service.queue.depth 在 rebuild 契约里没有对应字段,按各仓队列求和派生。
  describe("global queue depth derived from the per-repository rows", () => {
    it("sums the repositories that report a queue", () => {
      expect(totalQueueDepth([{ queueDepth: 2 }, { queueDepth: 0 }, { queueDepth: 5 }])).toBe(7);
    });

    it("ignores repositories with no projected queue rather than counting them as zero", () => {
      expect(totalQueueDepth([{ queueDepth: 3 }, { queueDepth: null }])).toBe(3);
    });

    // 全部未投影时返回 null(呈现为「—」),不谎报一个 0 队列。
    it("stays unknown when nothing is projected", () => {
      expect(totalQueueDepth([{ queueDepth: null }, { queueDepth: null }])).toBeNull();
      expect(totalQueueDepth([])).toBeNull();
    });
  });
});
