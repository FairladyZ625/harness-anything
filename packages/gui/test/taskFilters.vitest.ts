import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import {
  applyTaskFilters,
  DEFAULT_TASK_FILTERS,
  hasActiveTaskFilters,
  isColdTerminalTask,
  isTaskArchiveNoise,
  matchesTask,
  partitionColdTerminalTasks,
  sortByFavoritesFirst,
  sortByRecentThenPinAndFavoritesFirst,
  taskFilterSummary,
  type TaskFilters,
} from "../src/renderer/model/taskFilters.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task-a",
    title: "Alpha",
    projectId: "p",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "core",
    lastKnownAt: "2026-07-09T00:00:00.000Z",
    gates: [],
    docs: [],
    ...projectedTaskFields(overrides.coordinationStatus ?? "active", {
      archived: (overrides.packageDisposition ?? "active") !== "active",
    }),
    ...overrides,
  };
}

describe("taskFilters status multi-select", () => {
  it("matches all statuses when status array is empty", () => {
    const filters: TaskFilters = { ...DEFAULT_TASK_FILTERS };
    expect(matchesTask(makeTask({ coordinationStatus: "blocked" }), filters)).toBe(true);
    expect(matchesTask(makeTask({ coordinationStatus: "in_review" }), filters)).toBe(true);
  });

  it("matches only selected statuses when array non-empty", () => {
    const filters: TaskFilters = { ...DEFAULT_TASK_FILTERS, status: ["blocked", "in_review"] };
    expect(matchesTask(makeTask({ coordinationStatus: "blocked" }), filters)).toBe(true);
    expect(matchesTask(makeTask({ coordinationStatus: "in_review" }), filters)).toBe(true);
    expect(matchesTask(makeTask({ coordinationStatus: "active" }), filters)).toBe(false);
  });

  it("treats hasActiveTaskFilters as active when status array non-empty", () => {
    expect(hasActiveTaskFilters({ ...DEFAULT_TASK_FILTERS })).toBe(false);
    expect(hasActiveTaskFilters({ ...DEFAULT_TASK_FILTERS, status: ["active"] })).toBe(true);
  });

  it("applyTaskFilters intersects with status array", () => {
    const tasks = [
      makeTask({ taskId: "t1", coordinationStatus: "active" }),
      makeTask({ taskId: "t2", coordinationStatus: "blocked" }),
      makeTask({ taskId: "t3", coordinationStatus: "in_review" }),
    ];
    const filtered = applyTaskFilters(tasks, { ...DEFAULT_TASK_FILTERS, status: ["active", "in_review"] });
    expect(filtered.map((t) => t.taskId)).toEqual(["t1", "t3"]);
  });

  it("status array appears in summary chips", () => {
    const chips = taskFilterSummary({ ...DEFAULT_TASK_FILTERS, status: ["active", "blocked"] });
    expect(chips).toContain("status=active|blocked");
  });

  it("makes relation unknown and every projected module explicitly filterable", () => {
    const task = makeTask({
      coordinationStatus: "planned",
      canonicalStatus: "planned",
      blocking: "unknown",
      module: "multiple (gui, kernel)",
      moduleKeys: ["gui", "kernel"],
    });
    expect(matchesTask(task, { ...DEFAULT_TASK_FILTERS, status: ["unknown"] })).toBe(true);
    expect(matchesTask(task, { ...DEFAULT_TASK_FILTERS, module: "gui" })).toBe(true);
  });
});

/**
 * 看板降噪判定(task_b92c5138 起与关系图领地共用同一个 isTaskArchiveNoise,
 * 不允许第二份实现):cancelled 状态或非 active disposition 的 task 默认是噪音。
 */
describe("taskFilters archive-noise rule (shared with graph territory)", () => {
  it("flags cancelled status and non-active dispositions as noise", () => {
    expect(isTaskArchiveNoise(makeTask())).toBe(false);
    expect(isTaskArchiveNoise(makeTask({ coordinationStatus: "cancelled" }))).toBe(true);
    expect(isTaskArchiveNoise(makeTask({ packageDisposition: "archived" }))).toBe(true);
    expect(isTaskArchiveNoise(makeTask({ packageDisposition: "tombstoned" }))).toBe(true);
    // 已取消且归档的行仍然只是「一条噪音」,不会因为两个字段同时命中而变化。
    expect(isTaskArchiveNoise(makeTask({ coordinationStatus: "cancelled", packageDisposition: "archived" }))).toBe(
      true,
    );
  });

  it("board hides noise under the default filters and shows it with includeArchived", () => {
    const tasks = [
      makeTask({ taskId: "t_live" }),
      makeTask({ taskId: "t_cancelled", coordinationStatus: "cancelled" }),
      makeTask({ taskId: "t_archived", packageDisposition: "archived" }),
    ];
    expect(applyTaskFilters(tasks, { ...DEFAULT_TASK_FILTERS }).map((t) => t.taskId)).toEqual(["t_live"]);
    expect(applyTaskFilters(tasks, { ...DEFAULT_TASK_FILTERS, includeArchived: true }).map((t) => t.taskId)).toEqual([
      "t_live",
      "t_cancelled",
      "t_archived",
    ]);
  });
});

describe("taskFilters favoritesOnly", () => {
  it("filters to favorites set when favoritesOnly is true", () => {
    const tasks = [makeTask({ taskId: "t1" }), makeTask({ taskId: "t2" }), makeTask({ taskId: "t3" })];
    const favorites = new Set(["t1", "t3"]);
    const filters: TaskFilters = { ...DEFAULT_TASK_FILTERS, favoritesOnly: true };
    const filtered = applyTaskFilters(tasks, filters, favorites);
    expect(filtered.map((t) => t.taskId)).toEqual(["t1", "t3"]);
  });

  it("favoritesOnly not active when no favorites are passed", () => {
    const tasks = [makeTask({ taskId: "t1" })];
    const filters: TaskFilters = { ...DEFAULT_TASK_FILTERS, favoritesOnly: true };
    expect(applyTaskFilters(tasks, filters).map((t) => t.taskId)).toEqual(["t1"]);
  });
});

describe("sortByFavoritesFirst", () => {
  it("keeps favorited items at front, preserving order within each bucket", () => {
    const items = [
      { id: "a", label: "1" },
      { id: "b", label: "2" },
      { id: "c", label: "3" },
      { id: "d", label: "4" },
    ];
    const favorites = new Set(["b", "d"]);
    const sorted = sortByFavoritesFirst(items, (item) => item.id, favorites);
    expect(sorted.map((item) => item.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("returns identical order when no favorites", () => {
    const items = [{ id: "a" }, { id: "b" }];
    const sorted = sortByFavoritesFirst(items, (item) => item.id, new Set());
    expect(sorted.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

/**
 * 看板默认序(W8):lastKnownAt 倒序打底,pin → 收藏稳定置顶;列模式、泳道下钻
 * 与列表模式共用这一个实现(原列表模式写法收编于此)。
 */
describe("sortByRecentThenPinAndFavoritesFirst", () => {
  it("orders by lastKnownAt desc, then lifts pinned and favorites to the top", () => {
    const tasks = [
      makeTask({ taskId: "t_old", lastKnownAt: "2026-07-01T00:00:00.000Z" }),
      makeTask({ taskId: "t_new", lastKnownAt: "2026-07-20T00:00:00.000Z" }),
      makeTask({ taskId: "t_pin", lastKnownAt: "2026-06-01T00:00:00.000Z", pinned: true }),
      makeTask({ taskId: "t_fav", lastKnownAt: "2026-06-15T00:00:00.000Z" }),
      makeTask({ taskId: "t_mid", lastKnownAt: "2026-07-10T00:00:00.000Z" }),
    ];
    const ordered = sortByRecentThenPinAndFavoritesFirst(tasks, new Set(["t_fav"]));
    expect(ordered.map((t) => t.taskId)).toEqual(["t_pin", "t_fav", "t_new", "t_mid", "t_old"]);
  });

  it("keeps same-timestamp tasks in stable relative order", () => {
    const at = "2026-07-10T00:00:00.000Z";
    const tasks = [
      makeTask({ taskId: "t_first", lastKnownAt: at }),
      makeTask({ taskId: "t_second", lastKnownAt: at }),
      makeTask({ taskId: "t_third", lastKnownAt: at }),
    ];
    const ordered = sortByRecentThenPinAndFavoritesFirst(tasks, new Set());
    expect(ordered.map((t) => t.taskId)).toEqual(["t_first", "t_second", "t_third"]);
  });

  it("does not mutate the input array", () => {
    const tasks = [
      makeTask({ taskId: "t_a", lastKnownAt: "2026-07-01T00:00:00.000Z" }),
      makeTask({ taskId: "t_b", lastKnownAt: "2026-07-02T00:00:00.000Z" }),
    ];
    sortByRecentThenPinAndFavoritesFirst(tasks, new Set());
    expect(tasks.map((t) => t.taskId)).toEqual(["t_a", "t_b"]);
  });
});

/**
 * 冷终态折叠判定(W8):终态且非重点种子(isTaskGraphFocusSeed 的 14 天窗口,
 * 唯一实现)默认折叠为计数。pinned 恒可见;开放任务与刚收口的终态不折叠。
 */
describe("cold terminal collapse (W8)", () => {
  const NOW = "2026-08-30T00:00:00.000Z";

  it("collapses only terminal tasks outside the recent window", () => {
    expect(
      isColdTerminalTask(makeTask({ coordinationStatus: "done", lastKnownAt: "2026-08-20T00:00:00.000Z" }), NOW),
    ).toBe(false);
    expect(
      isColdTerminalTask(makeTask({ coordinationStatus: "done", lastKnownAt: "2026-08-01T00:00:00.000Z" }), NOW),
    ).toBe(true);
    // 开放任务无论多旧都不折叠(它们就是工作面本身)。
    expect(
      isColdTerminalTask(makeTask({ coordinationStatus: "planned", lastKnownAt: "2026-01-01T00:00:00.000Z" }), NOW),
    ).toBe(false);
  });

  it("never collapses pinned tasks, however cold and terminal", () => {
    expect(
      isColdTerminalTask(
        makeTask({ coordinationStatus: "done", pinned: true, lastKnownAt: "2026-01-01T00:00:00.000Z" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("partitionColdTerminalTasks splits in one pass; the count survives expansion", () => {
    const tasks = [
      makeTask({ taskId: "t_open", coordinationStatus: "active", lastKnownAt: "2026-08-29T00:00:00.000Z" }),
      makeTask({ taskId: "t_recent_done", coordinationStatus: "done", lastKnownAt: "2026-08-25T00:00:00.000Z" }),
      makeTask({ taskId: "t_cold_done", coordinationStatus: "done", lastKnownAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({
        taskId: "t_cold_pinned",
        coordinationStatus: "done",
        pinned: true,
        lastKnownAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    const { visible, collapsed } = partitionColdTerminalTasks(tasks, NOW);
    expect(visible.map((t) => t.taskId)).toEqual(["t_open", "t_recent_done", "t_cold_pinned"]);
    expect(collapsed.map((t) => t.taskId)).toEqual(["t_cold_done"]);
  });

  it("expandColdTerminal defaults to collapsed and reports as an active deviation", () => {
    expect(DEFAULT_TASK_FILTERS.expandColdTerminal).toBe(false);
    expect(hasActiveTaskFilters({ ...DEFAULT_TASK_FILTERS })).toBe(false);
    expect(hasActiveTaskFilters({ ...DEFAULT_TASK_FILTERS, expandColdTerminal: true })).toBe(true);
    expect(taskFilterSummary({ ...DEFAULT_TASK_FILTERS, expandColdTerminal: true })).toContain("已展开冷终态");
  });
});
