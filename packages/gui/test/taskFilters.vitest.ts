// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { SnapshotStatus, TaskRow } from "../src/renderer/model/types.ts";
import { BoardView } from "../src/renderer/views/BoardView.tsx";
import { SwimlaneBoard } from "../src/renderer/views/SwimlaneBoard.tsx";
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
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
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

/**
 * 看板组件输出(W8):列模式/泳道下钻卡片 = lastKnownAt 倒序打底,pin → 收藏
 * 稳定置顶;泳道行序 = 组内最新 lastKnownAt 倒序;冷终态默认折叠,折叠态必须
 * 显形「N」计数与展开入口(W6 先例:不许静默截断),开关走 TaskFilters。
 * BoardView 的判定时钟在组件内部取 now,所以夹具日期相对真实时钟构造。
 */

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const noop = () => undefined;

function boardMarkup(
  tasks: TaskRow[],
  filters: TaskFilters = { ...DEFAULT_TASK_FILTERS },
  favorites: ReadonlySet<string> = new Set<string>(),
): string {
  return renderToStaticMarkup(
    createElement(BoardView, {
      tasks,
      allTasks: tasks,
      filters,
      onFiltersChange: noop,
      onSelect: noop,
      relations: [],
      favorites,
      onToggleFavorite: noop,
      onSetPin: noop,
    }),
  );
}

const orderedIds = (markup: string, titles: string[]): string[] =>
  [...titles].sort((a, b) => markup.indexOf(a) - markup.indexOf(b));

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

describe("board column default order (W8)", () => {
  it("renders lastKnownAt desc with pinned and favorited tasks lifted to the top", () => {
    const tasks = [
      makeTask({ taskId: "t_old", title: "card-old", lastKnownAt: daysAgo(30) }),
      makeTask({ taskId: "t_new", title: "card-new", lastKnownAt: daysAgo(1) }),
      makeTask({ taskId: "t_pin", title: "card-pin", lastKnownAt: daysAgo(60), pinned: true }),
      makeTask({ taskId: "t_fav", title: "card-fav", lastKnownAt: daysAgo(40) }),
      makeTask({ taskId: "t_mid", title: "card-mid", lastKnownAt: daysAgo(10) }),
    ];
    const markup = boardMarkup(tasks, { ...DEFAULT_TASK_FILTERS }, new Set(["t_fav"]));
    expect(orderedIds(markup, ["card-pin", "card-fav", "card-new", "card-mid", "card-old"])).toEqual([
      "card-pin",
      "card-fav",
      "card-new",
      "card-mid",
      "card-old",
    ]);
  });

  it("keeps same-timestamp cards in stable relative order", () => {
    const at = daysAgo(5);
    const tasks = [
      makeTask({ taskId: "t_first", title: "card-first", lastKnownAt: at }),
      makeTask({ taskId: "t_second", title: "card-second", lastKnownAt: at }),
      makeTask({ taskId: "t_third", title: "card-third", lastKnownAt: at }),
    ];
    const markup = boardMarkup(tasks);
    expect(orderedIds(markup, ["card-first", "card-second", "card-third"])).toEqual([
      "card-first",
      "card-second",
      "card-third",
    ]);
  });
});

describe("cold terminal collapse in BoardView (W8)", () => {
  const fixture = (): TaskRow[] => [
    makeTask({ taskId: "t_open", title: "card-open", coordinationStatus: "active", lastKnownAt: daysAgo(5) }),
    makeTask({
      taskId: "t_recent_done",
      title: "card-recent-done",
      coordinationStatus: "done",
      lastKnownAt: daysAgo(2),
    }),
    makeTask({ taskId: "t_cold_done_a", title: "card-cold-a", coordinationStatus: "done", lastKnownAt: daysAgo(40) }),
    makeTask({ taskId: "t_cold_done_b", title: "card-cold-b", coordinationStatus: "done", lastKnownAt: daysAgo(60) }),
    makeTask({
      taskId: "t_cold_pinned",
      title: "card-cold-pinned",
      coordinationStatus: "done",
      pinned: true,
      lastKnownAt: daysAgo(90),
    }),
  ];

  it("collapses cold terminal cards by default and shows the count with an expand entry", () => {
    const markup = boardMarkup(fixture());
    for (const visible of ["card-open", "card-recent-done", "card-cold-pinned"]) expect(markup).toContain(visible);
    for (const cold of ["card-cold-a", "card-cold-b"]) expect(markup).not.toContain(cold);
    // 折叠显形(W6):计数与展开入口都在 DOM 里,不是静默消失。
    const toggle = markup.match(/<button[^>]*data-testid="board-cold-terminal-toggle"[^>]*>/u);
    expect(toggle).not.toBeNull();
    expect(toggle![0]).toContain('aria-checked="false"');
    expect(markup).toContain("Show cold terminal (2)");
    // 列内计数徽章显示折叠后的可见卡数,不是筛选后的总数。
    expect(markup).toContain('data-testid="board-status-done-count">2</span>');
  });

  it("renders every cold terminal card once expanded, with the count still visible", () => {
    const markup = boardMarkup(fixture(), { ...DEFAULT_TASK_FILTERS, expandColdTerminal: true });
    for (const title of ["card-cold-a", "card-cold-b"]) expect(markup).toContain(title);
    expect(markup).toContain("Hide cold terminal (2)");
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('data-testid="board-status-done-count">4</span>');
  });

  it("filter bar count matches the number of rendered cards, collapsed and expanded", () => {
    // 同源对照(r1 评审):filter bar 的「N / M tasks」必须与同一份 markup 里实际
    // 渲染的卡片数一致——折叠时 N=可见卡数,展开后恢复为筛选后的总数。
    const collapsed = boardMarkup(fixture());
    expect(collapsed.split('data-testid="board-task-card"').length - 1).toBe(3);
    expect(collapsed).toContain("3 / 5 tasks");
    const expanded = boardMarkup(fixture(), { ...DEFAULT_TASK_FILTERS, expandColdTerminal: true });
    expect(expanded.split('data-testid="board-task-card"').length - 1).toBe(5);
    expect(expanded).toContain("5 / 5 tasks");
  });

  it("no toggle is rendered when the current filter leaves no cold terminal tasks", () => {
    const markup = boardMarkup([
      makeTask({ taskId: "t_open", title: "card-open", coordinationStatus: "active", lastKnownAt: daysAgo(5) }),
    ]);
    expect(markup).not.toContain('data-testid="board-cold-terminal-toggle"');
  });

  it("routes the expand switch through TaskFilters (onFiltersChange regression)", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const seen: TaskFilters[] = [];
    await act(async () => {
      root.render(
        createElement(BoardView, {
          tasks: fixture(),
          allTasks: fixture(),
          filters: { ...DEFAULT_TASK_FILTERS },
          onFiltersChange: (next) => seen.push(next),
          onSelect: noop,
          relations: [],
          favorites: new Set<string>(),
          onToggleFavorite: noop,
          onSetPin: noop,
        }),
      );
    });
    const toggle = container.querySelector('[data-testid="board-cold-terminal-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-checked")).toBe("false");
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.expandColdTerminal).toBe(true);
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe("swimlane default order (W8)", () => {
  const laneFixture = (): TaskRow[] => [
    // lane-B 最新活动(1 天前)> lane-A(3 天前)> lane-C(30 天前)→ 行序 B, A, C。
    makeTask({
      taskId: "t_b_new",
      title: "lane-b-new",
      rootTaskId: "root-b",
      rootTitle: "Lane B",
      lastKnownAt: daysAgo(1),
    }),
    makeTask({
      taskId: "t_a_new",
      title: "lane-a-new",
      rootTaskId: "root-a",
      rootTitle: "Lane A",
      lastKnownAt: daysAgo(3),
    }),
    makeTask({
      taskId: "t_a_old",
      title: "lane-a-old",
      rootTaskId: "root-a",
      rootTitle: "Lane A",
      lastKnownAt: daysAgo(20),
    }),
    makeTask({
      taskId: "t_c",
      title: "lane-c-card",
      rootTaskId: "root-c",
      rootTitle: "Lane C",
      lastKnownAt: daysAgo(30),
    }),
  ];

  it("orders lanes by each lane's latest lastKnownAt, most recent first", () => {
    const markup = renderToStaticMarkup(
      createElement(SwimlaneBoard, {
        tasks: laneFixture(),
        groupBy: "root",
        onSelect: noop,
        drill: null,
        relations: [],
        favorites: new Set<string>(),
        onToggleFavorite: noop,
        onSetPin: noop,
      }),
    );
    expect(orderedIds(markup, ["Lane B", "Lane A", "Lane C"])).toEqual(["Lane B", "Lane A", "Lane C"]);
  });

  it("orders drilldown cards recent-desc with pinned/favorited lifted, per cell", () => {
    const drillStatus: SnapshotStatus = "done";
    const tasks = [
      makeTask({
        taskId: "t_done_old",
        title: "drill-old",
        coordinationStatus: "done",
        rootTaskId: "root-a",
        rootTitle: "Lane A",
        lastKnownAt: daysAgo(2),
      }),
      makeTask({
        taskId: "t_done_new",
        title: "drill-new",
        coordinationStatus: "done",
        rootTaskId: "root-a",
        rootTitle: "Lane A",
        lastKnownAt: daysAgo(1),
      }),
      makeTask({
        taskId: "t_done_pin",
        title: "drill-pin",
        coordinationStatus: "done",
        pinned: true,
        rootTaskId: "root-a",
        rootTitle: "Lane A",
        lastKnownAt: daysAgo(10),
      }),
      makeTask({
        taskId: "t_active",
        title: "drill-active",
        coordinationStatus: "active",
        rootTaskId: "root-a",
        rootTitle: "Lane A",
        lastKnownAt: daysAgo(1),
      }),
    ];
    const markup = renderToStaticMarkup(
      createElement(SwimlaneBoard, {
        tasks,
        groupBy: "root",
        onSelect: noop,
        drill: { lane: "root-a", status: drillStatus, groupBy: "root" },
        relations: [],
        favorites: new Set<string>(),
        onToggleFavorite: noop,
        onSetPin: noop,
      }),
    );
    const drilldown = markup.slice(markup.indexOf("drill-pin"));
    // 下钻面板内:pin 置顶,其余按 lastKnownAt 倒序;active 卡不在 done 单元格里。
    const order = orderedIds(drilldown, ["drill-pin", "drill-new", "drill-old"]);
    expect(order).toEqual(["drill-pin", "drill-new", "drill-old"]);
    expect(drilldown).not.toContain("drill-active");
  });
});
