// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { formatUptimeMs } from "../src/renderer/views/SystemView.tsx";

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
});
