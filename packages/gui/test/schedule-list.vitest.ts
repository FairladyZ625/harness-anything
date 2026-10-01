// harness-test-tier: fast
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScheduleGuiListRowDto, ScheduleGuiRowDto } from "@harness-anything/daemon/protocol";
import {
  dayClock,
  needsAttention,
  scheduleTiers,
  scheduleVerdict,
  untilLabel,
  upcomingRuns,
} from "../src/renderer/model/schedule-list.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { TIME_ZONE_STORAGE_KEY } from "../src/renderer/model/time.ts";

// 定时计划列表的分档、「接下来」一行与时间写法:纯函数,只读 daemon 行事实。

beforeAll(() => {
  setActiveLocale("zh-CN");
  // 时间写法按用户时区算日历日;测试固定为 UTC,不随机器时区变。
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === TIME_ZONE_STORAGE_KEY ? "UTC" : null),
    setItem: () => {},
    removeItem: () => {},
  });
});
afterAll(() => vi.unstubAllGlobals());

const row = (scheduleId: string, patch: Partial<ScheduleGuiRowDto> = {}): ScheduleGuiRowDto =>
  ({
    scheduleId,
    name: scheduleId,
    state: "armed",
    health: { recent: [], bucket: "clean", failedCount: 0, lastFailureDetail: null },
    missed: { count: 0, lastMissedAt: null, lastMissedReason: null },
    nextRunAt: "2026-10-01T12:00:00.000Z",
    lastRun: null,
    ...patch,
  }) as ScheduleGuiRowDto;
const invalid: ScheduleGuiListRowDto = {
  scheduleId: "broken",
  state: "invalid",
  invalidReason: "bad cron",
  definitionRevision: 1,
};
const degraded = { recent: ["failed"], bucket: "degraded", failedCount: 1, lastFailureDetail: null } as const;

const ROWS: readonly ScheduleGuiListRowDto[] = [
  row("clean-late", { nextRunAt: "2026-10-01T20:00:00.000Z" }),
  row("missed", { missed: { count: 2, lastMissedAt: null, lastMissedReason: "single_flight" } }),
  row("paused", { state: "paused", health: degraded }),
  row("degraded", { health: degraded }),
  row("clean-soon", { nextRunAt: "2026-10-01T09:00:00.000Z" }),
  row("no-target", { targetState: "missing" }),
  invalid,
];
const ids = (rows: readonly ScheduleGuiListRowDto[]) => rows.map(({ scheduleId }) => scheduleId);

describe("定时计划分档", () => {
  it("三档互斥且并集为全集:无效定义排在需要关注最前,已暂停的不论健康都沉底", () => {
    const tiers = scheduleTiers(ROWS, ROWS.length);
    expect(ids(tiers.attention)).toEqual(["broken", "degraded", "missed", "no-target"]);
    expect(ids(tiers.normal)).toEqual(["clean-soon", "clean-late"]);
    expect(ids(tiers.paused)).toEqual(["paused"]);
    expect([...ids(tiers.attention), ...ids(tiers.normal), ...ids(tiers.paused)].sort()).toEqual(ids(ROWS).sort());
    expect(ids(ROWS.filter(needsAttention)).sort()).toEqual(ids(tiers.attention).sort());
  });

  it("运行正常的卡片大小随计划总数变化:不超过 6 个用大卡,超过用小卡;总数按筛选前算", () => {
    expect(scheduleTiers(ROWS.slice(0, 6), 6).normalSize).toBe("large");
    expect(scheduleTiers(ROWS, 7).normalSize).toBe("small");
    expect(scheduleTiers(ROWS.slice(0, 1), 7).normalSize).toBe("small");
  });
});

describe("「接下来」一行", () => {
  it("只列已启用且有下次运行时间的计划,按时间升序,超过上限的只报个数", () => {
    const rows = [
      ...Array.from({ length: 7 }, (_, index) =>
        row(`r${index}`, { nextRunAt: `2026-10-01T1${7 - index}:00:00.000Z` }),
      ),
      row("paused", { state: "paused", nextRunAt: "2026-10-01T00:00:00.000Z" }),
      row("no-next", { nextRunAt: null }),
      invalid,
    ];
    const upcoming = upcomingRuns(rows);
    expect(ids(upcoming.next)).toEqual(["r6", "r5", "r4", "r3", "r2"]);
    expect(upcoming.more).toBe(2);
    expect(upcomingRuns([invalid, row("p", { state: "paused" })])).toEqual({ next: [], more: 0 });
  });
});

describe("结论与时间写法", () => {
  it("结论:上次失败 > 健康降级 > 从未运行 > 正常", () => {
    const last = (outcome: string) => ({ outcome }) as ScheduleGuiRowDto["lastRun"];
    expect(scheduleVerdict(row("a", { lastRun: last("failed"), health: degraded }))).toBe("failed");
    expect(scheduleVerdict(row("a", { lastRun: last("succeeded"), health: degraded }))).toBe("degraded");
    expect(scheduleVerdict(row("a"))).toBe("never");
    expect(scheduleVerdict(row("a", { lastRun: last("succeeded") }))).toBe("ok");
  });

  it("当天只写时分,前后一天写明天/昨天,再远写月日;距下次运行按分钟/小时/天", () => {
    const now = Date.parse("2026-10-01T10:00:00.000Z");
    expect(dayClock("2026-10-01T19:02:00.000Z", now)).toBe("19:02");
    expect(dayClock("2026-10-01T13:07:00.000Z", now, "named")).toBe("今天 13:07");
    expect(dayClock("2026-10-02T02:00:00.000Z", now)).toBe("明天 02:00");
    expect(dayClock("2026-09-30T23:59:00.000Z", now, "named")).toBe("昨天 23:59");
    expect(dayClock("2026-10-03T02:00:00.000Z", now)).toBe("10-03 02:00");
    expect(untilLabel("2026-10-01T10:30:00.000Z", now)).toBe("30 分钟后");
    expect(untilLabel("2026-10-01T13:59:00.000Z", now)).toBe("3 小时后");
    expect(untilLabel("2026-10-04T10:00:00.000Z", now)).toBe("3 天后");
    expect(untilLabel("2026-10-01T09:00:00.000Z", now)).toBeNull();
  });
});
