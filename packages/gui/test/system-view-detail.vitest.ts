// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { formatUptimeMs, totalQueueDepth } from "../src/renderer/views/SystemView.tsx";

describe("system view user-facing detail (archive-line parity)", () => {
  it("formats raw uptime milliseconds into readable durations", () => {
    expect(formatUptimeMs(0)).toBe("0s");
    expect(formatUptimeMs(59_000)).toBe("59s");
    expect(formatUptimeMs(61_000)).toBe("1m 1s");
    expect(formatUptimeMs(3_723_000)).toBe("1h 2m 3s");
    expect(formatUptimeMs(900_610_000)).toBe("10d 10h 10m");
  });

  it("keeps unknown uptime honest instead of echoing machine values", () => {
    expect(formatUptimeMs(undefined)).toBe("—");
    expect(formatUptimeMs(Number.NaN)).toBe("—");
    expect(formatUptimeMs(-5)).toBe("—");
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
