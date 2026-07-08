import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import {
  applyTaskFilters,
  DEFAULT_TASK_FILTERS,
  hasActiveTaskFilters,
  matchesTask,
  sortByFavoritesFirst,
  taskFilterSummary,
  type TaskFilters,
} from "../src/renderer/model/taskFilters.ts";

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
});

describe("taskFilters favoritesOnly", () => {
  it("filters to favorites set when favoritesOnly is true", () => {
    const tasks = [
      makeTask({ taskId: "t1" }),
      makeTask({ taskId: "t2" }),
      makeTask({ taskId: "t3" }),
    ];
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
    const items = [
      { id: "a" },
      { id: "b" },
    ];
    const sorted = sortByFavoritesFirst(items, (item) => item.id, new Set());
    expect(sorted.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
