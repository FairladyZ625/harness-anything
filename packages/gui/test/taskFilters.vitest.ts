// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { RelationEdge, SnapshotStatus, TaskRow } from "../src/renderer/model/types.ts";
import { BOARD_COLUMNS } from "../src/renderer/model/types.ts";
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
import {
  boardColumnPreferenceStorage,
  clearBoardColumnWidth,
  emptyBoardColumnWidths,
  readBoardColumnWidths,
  setBoardColumnWidth,
  writeBoardColumnWidths,
} from "../src/renderer/board-column-preferences.ts";
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

const boardProps = (overrides: {
  tasks: TaskRow[];
  filters?: TaskFilters;
  favorites?: ReadonlySet<string>;
  onSelect?: (id: string) => void;
  onFiltersChange?: (next: TaskFilters) => void;
}) => ({
  tasks: overrides.tasks,
  allTasks: overrides.tasks,
  filters: overrides.filters ?? { ...DEFAULT_TASK_FILTERS },
  onFiltersChange: overrides.onFiltersChange ?? noop,
  onSelect: overrides.onSelect ?? noop,
  relations: [],
  favorites: overrides.favorites ?? new Set<string>(),
  onToggleFavorite: noop,
  onSetPin: noop,
});

/**
 * 真实 DOM 渲染的看板 HTML(W10 起列内是 windowing:卡片在挂载后按视口窗口
 * 出现,SSR markup 里没有卡片,断言卡片必须走 createRoot + act)。夹具都很小,
 * 600px 视口桩 + overscan 下整窗覆盖,「看到全部」与既有断言兼容。
 */
async function boardHtml(
  tasks: TaskRow[],
  filters: TaskFilters = { ...DEFAULT_TASK_FILTERS },
  favorites: ReadonlySet<string> = new Set<string>(),
): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(BoardView, boardProps({ tasks, filters, favorites })));
    });
    return container.innerHTML;
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
}

const orderedIds = (markup: string, titles: string[]): string[] =>
  [...titles].sort((a, b) => markup.indexOf(a) - markup.indexOf(b));

/**
 * 桩高与组件 estimateSize 对齐(列卡 108px / 泳道行 84px):virtualizer 只实测
 * 挂载过的项,估算与实测一致时窗口位置可按「scrollTop ÷ 行高」确定性推算,
 * 滚动断言不依赖混合尺寸的边界项。视口(offsetHeight)统一 600px。
 */
let measureHeight = 108;
const setMeasureHeight = (px: number) => {
  measureHeight = px;
};

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
  // windowing(W10)测量桩:happy-dom 没有布局,virtualizer 的视口读 offsetHeight,
  // measureElement 读 getBoundingClientRect。视口与行高分途:窗口项(带
  // data-index 的定位包装)按 measureHeight 上报,滚动容器与其余元素按 600px
  // 视口上报——估算=实测时窗口位置可按「scrollTop ÷ 行高」推算。
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-index") ? measureHeight : 600;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const height = (this as HTMLElement).hasAttribute?.("data-index") ? measureHeight : 600;
    return {
      width: 600,
      height,
      top: 0,
      left: 0,
      bottom: height,
      right: 600,
      x: 0,
      y: 0,
    } as DOMRect;
  });
});

describe("board column default order (W8)", () => {
  it("renders lastKnownAt desc with pinned and favorited tasks lifted to the top", async () => {
    const tasks = [
      makeTask({ taskId: "t_old", title: "card-old", lastKnownAt: daysAgo(30) }),
      makeTask({ taskId: "t_new", title: "card-new", lastKnownAt: daysAgo(1) }),
      makeTask({ taskId: "t_pin", title: "card-pin", lastKnownAt: daysAgo(60), pinned: true }),
      makeTask({ taskId: "t_fav", title: "card-fav", lastKnownAt: daysAgo(40) }),
      makeTask({ taskId: "t_mid", title: "card-mid", lastKnownAt: daysAgo(10) }),
    ];
    const markup = await boardHtml(tasks, { ...DEFAULT_TASK_FILTERS }, new Set(["t_fav"]));
    expect(orderedIds(markup, ["card-pin", "card-fav", "card-new", "card-mid", "card-old"])).toEqual([
      "card-pin",
      "card-fav",
      "card-new",
      "card-mid",
      "card-old",
    ]);
  });

  it("keeps same-timestamp cards in stable relative order", async () => {
    const at = daysAgo(5);
    const tasks = [
      makeTask({ taskId: "t_first", title: "card-first", lastKnownAt: at }),
      makeTask({ taskId: "t_second", title: "card-second", lastKnownAt: at }),
      makeTask({ taskId: "t_third", title: "card-third", lastKnownAt: at }),
    ];
    const markup = await boardHtml(tasks);
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

  it("collapses cold terminal cards by default and shows the count with an expand entry", async () => {
    const markup = await boardHtml(fixture());
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

  it("renders every cold terminal card once expanded, with the count still visible", async () => {
    const markup = await boardHtml(fixture(), { ...DEFAULT_TASK_FILTERS, expandColdTerminal: true });
    for (const title of ["card-cold-a", "card-cold-b"]) expect(markup).toContain(title);
    expect(markup).toContain("Hide cold terminal (2)");
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('data-testid="board-status-done-count">4</span>');
  });

  it("filter bar count matches the number of rendered cards, collapsed and expanded", async () => {
    // 同源对照(r1 评审):filter bar 的「N / M tasks」必须与同一份 markup 里实际
    // 渲染的卡片数一致——折叠时 N=可见卡数,展开后恢复为筛选后的总数。
    const collapsed = await boardHtml(fixture());
    expect(collapsed.split('data-testid="board-task-card"').length - 1).toBe(3);
    expect(collapsed).toContain("3 / 5 tasks");
    const expanded = await boardHtml(fixture(), { ...DEFAULT_TASK_FILTERS, expandColdTerminal: true });
    expect(expanded.split('data-testid="board-task-card"').length - 1).toBe(5);
    expect(expanded).toContain("5 / 5 tasks");
  });

  it("no toggle is rendered when the current filter leaves no cold terminal tasks", async () => {
    const markup = await boardHtml([
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

  it("orders lanes by each lane's latest lastKnownAt, most recent first", async () => {
    // 泳道行是 windowing(W10):行在挂载后按视口窗口出现,行序断言走真实 DOM。
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let markup;
    try {
      await act(async () => {
        root.render(
          createElement(SwimlaneBoard, {
            tasks: laneFixture(),
            groupBy: "root",
            onSelect: noop,
            drill: null,
            spawningDecisions: new Map(),
            favorites: new Set<string>(),
            onToggleFavorite: noop,
            onSetPin: noop,
          }),
        );
      });
      markup = container.innerHTML;
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
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
        spawningDecisions: new Map(),
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

/**
 * 看板重渲染收敛(W9):行级引用保持 + Card memo + draggable 只挂可拖卡之后,
 * 重渲染成本与「实际变化的行数」成正比。计数探针:TaskRow.title 的 getter——
 * 默认筛选(query 为空)下列模式下只有卡片渲染读 title(matchesTask 只在
 * query 非空时读,TaskFilterBar/列分组/排序都不读),所以 title 读取数 ==
 * 卡片渲染数;探针在收敛前后的代码上同构,数字可直接对照。
 */
/**
 * 看板重渲染收敛(W9)的共享探针 fixture:行级引用保持 + Card memo 之后,
 * 重渲染成本与「实际变化的行数」成正比。计数探针:TaskRow.title 的 getter——
 * 默认筛选(query 为空)下列模式下只有卡片渲染读 title(matchesTask 只在
 * query 非空时读,TaskFilterBar/列分组/排序都不读),所以 title 读取数 ==
 * 卡片渲染数;探针在收敛前后的代码上同构,数字可直接对照。
 * 关系更新探针(W9 修正)复用同一套 fixture。
 */
// BoardView 级渲染探针:boardTasks 三元式每次 BoardView 渲染都读
// filters.expandColdTerminal,getter 计数即「看板本体渲染次数」。注意
// React Profiler 不适用:它在子树全部 memo 跳过时仍按父渲染各 fire 一次
// (2026-09-09 实测),commit 计数测不出 bail-out。
let boardRenderReads = 0;
const STABLE_FILTERS = Object.defineProperty({ ...DEFAULT_TASK_FILTERS }, "expandColdTerminal", {
  enumerable: true,
  configurable: true,
  get() {
    boardRenderReads++;
    return false;
  },
}) as TaskFilters;
const STABLE_FAVORITES = new Set<string>();
// props 全部稳定是 memo 生效的前提,探针必须自己遵守(生产路径由上层
// useCallback/query structuralSharing 保证)。
const STABLE_RELATIONS: RelationEdge[] = [];

function countingTask(id: string, counters: Map<string, number>, overrides: Partial<TaskRow> = {}): TaskRow {
  const base = makeTask({ taskId: id, title: `card-${id}`, ...overrides });
  // 同 id 重建对象(增量页换行)不清零:计数按 taskId 连续累计,增量才有意义。
  if (!counters.has(id)) counters.set(id, 0);
  return Object.defineProperty({ ...base }, "title", {
    enumerable: true,
    configurable: true,
    get() {
      counters.set(id, (counters.get(id) ?? 0) + 1);
      return `card-${id}`;
    },
  }) as TaskRow;
}

function boardFixture(counters: Map<string, number>): TaskRow[] {
  const statuses: SnapshotStatus[] = ["planned", "active", "active", "in_review", "blocked"];
  return statuses.map((coordinationStatus, index) =>
    countingTask(`t_${index}`, counters, {
      coordinationStatus,
      lastKnownAt: daysAgo(index + 1),
    }),
  );
}

async function mountBoard() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const renderBoard = (tasks: TaskRow[], relations: RelationEdge[] = STABLE_RELATIONS) =>
    act(async () => {
      root.render(
        createElement(BoardView, {
          tasks,
          allTasks: tasks,
          filters: STABLE_FILTERS,
          onFiltersChange: noop,
          onSelect: noop,
          relations,
          favorites: STABLE_FAVORITES,
          onToggleFavorite: noop,
          onSetPin: noop,
        }),
      );
    });
  return { container, root, renderBoard };
}

describe("board render convergence (W9)", () => {
  it("idle re-render with identical props renders no cards and no board body", async () => {
    const counters = new Map<string, number>();
    const tasks = boardFixture(counters);
    const board = await mountBoard();
    await board.renderBoard(tasks);
    // 挂载后 dnd-kit 的异步测量可能再 commit 一轮;先用一次同参渲染落定,
    // 再以落定后的计数为基线测量「空闲轮询」。
    await board.renderBoard(tasks);
    const settled = new Map(counters);
    const settledBoardReads = boardRenderReads;
    expect(settled.size).toBe(5);
    expect([...settled.values()].every((count) => count >= 1)).toBe(true);

    await board.renderBoard(tasks);
    for (const [id, reads] of settled) {
      expect(counters.get(id)).toBe(reads); // 零变更:卡片渲染数 0。
    }
    expect(boardRenderReads).toBe(settledBoardReads); // 看板本体零重渲染。

    act(() => {
      board.root.unmount();
    });
    board.container.remove();
  });

  it("zero-change refetch (new array identity, same row refs) renders no cards", async () => {
    const counters = new Map<string, number>();
    const tasks = boardFixture(counters);
    const board = await mountBoard();
    await board.renderBoard(tasks);
    const afterMount = new Map(counters);

    await board.renderBoard([...tasks]);
    for (const [id, reads] of afterMount) {
      expect(counters.get(id)).toBe(reads);
    }

    act(() => {
      board.root.unmount();
    });
    board.container.remove();
  });

  it("single-row change re-renders only that row's card", async () => {
    const counters = new Map<string, number>();
    const tasks = boardFixture(counters);
    const board = await mountBoard();
    await board.renderBoard(tasks);
    const readsAfterMount = new Map(counters);

    const changed = countingTask("t_2", counters, {
      coordinationStatus: "active",
      lastKnownAt: new Date().toISOString(),
    });
    await board.renderBoard([...tasks.slice(0, 2), changed, ...tasks.slice(3)]);

    for (const id of ["t_0", "t_1", "t_3", "t_4"]) {
      expect(counters.get(id)).toBe(readsAfterMount.get(id)); // 未变行:卡片跳过。
    }
    expect(counters.get("t_2")).toBe((readsAfterMount.get("t_2") ?? 0) + 1); // 只有变更行重渲染。

    act(() => {
      board.root.unmount();
    });
    board.container.remove();
  });
});

/**
 * 关系更新收敛(W9 修正):全局 relations 数组止步于 BoardView 的单遍徽章索引,
 * 卡片只收自己的标量。真实 derives 增量不再打穿全板 memo——与看板任务无关的
 * 边变化 0 卡重渲染,命中某一任务的边变化只有该卡重渲染;点击与键盘行为保持。
 * (此前的 STABLE_RELATIONS 探针测不出这条路径:它从不换 relations 数组。)
 */
describe("relation update convergence (W9 correction)", () => {
  const derives = (decisionId: string, taskId: string): RelationEdge => ({
    kind: "derives",
    direction: "directed",
    from: `decision/${decisionId}`,
    to: `task/${taskId}`,
  });

  it("relation refresh touching only unrelated tasks re-renders no cards", async () => {
    const counters = new Map<string, number>();
    const tasks = boardFixture(counters);
    const board = await mountBoard();
    await board.renderBoard(tasks, [derives("dec_a", "t_0")]);
    await board.renderBoard(tasks, [derives("dec_a", "t_0")]); // 落定基线(dnd 异步测量)。
    const settled = new Map(counters);
    const settledBoardReads = boardRenderReads;

    // 新数组身份(react-query 刷新形态),新增边只指向看板外的任务。
    await board.renderBoard(tasks, [derives("dec_a", "t_0"), derives("dec_off", "t_offboard")]);
    for (const [id, reads] of settled) {
      expect(counters.get(id)).toBe(reads); // 无关关系变更:卡片渲染数 0。
    }
    expect(boardRenderReads).toBeGreaterThan(settledBoardReads); // 看板本体确实重渲染了:0 卡 ≠ 0 渲染。

    act(() => {
      board.root.unmount();
    });
    board.container.remove();
  });

  it("relation update targeting one board task re-renders only that card", async () => {
    const counters = new Map<string, number>();
    const tasks = boardFixture(counters);
    const board = await mountBoard();
    await board.renderBoard(tasks, [derives("dec_a", "t_0")]);
    await board.renderBoard(tasks, [derives("dec_a", "t_0")]);
    const settled = new Map(counters);

    // t_2 获得新的决策来源徽章 → 只有 t_2 的卡片换 props。
    await board.renderBoard(tasks, [derives("dec_a", "t_0"), derives("dec_new", "t_2")]);

    for (const id of ["t_0", "t_1", "t_3", "t_4"]) {
      expect(counters.get(id)).toBe(settled.get(id)); // 徽章值未变的行跳过。
    }
    expect(counters.get("t_2")).toBe((settled.get("t_2") ?? 0) + 1); // 只有命中行重渲染。
    expect(board.container.textContent).toContain("dec_new"); // 徽章真实上屏。

    act(() => {
      board.root.unmount();
    });
    board.container.remove();
  });

  it("keeps click and keyboard activation on non-draggable cards across a relation refresh", async () => {
    // done 卡(无 start 能力)走非拖拽分支;渲染一轮后换 relations 数组,
    // 验证可聚焦表面与激活路径不随关系刷新退化。
    const doneTask = makeTask({
      taskId: "t_done",
      title: "card-done",
      coordinationStatus: "done",
      lastKnownAt: daysAgo(2),
    });
    const selected: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (relations: RelationEdge[]) =>
      act(async () => {
        root.render(
          createElement(BoardView, {
            tasks: [doneTask],
            allTasks: [doneTask],
            filters: { ...DEFAULT_TASK_FILTERS },
            onFiltersChange: noop,
            onSelect: (id) => selected.push(id),
            relations,
            favorites: new Set<string>(),
            onToggleFavorite: noop,
            onSetPin: noop,
          }),
        );
      });
    await render([]);
    await render([derives("dec_new", "t_done")]);

    const card = container.querySelector('[data-testid="board-task-card"]')!;
    expect(card.textContent).toContain("dec_new");
    const wrapper = card.closest('[role="button"]');
    expect(wrapper).not.toBeNull(); // 可聚焦的交互表面在(baseline 经 dnd attributes 提供,收窄后显式保留)。
    expect(wrapper!.getAttribute("tabindex")).toBe("0");
    expect(wrapper!.getAttribute("aria-roledescription")).toBeNull(); // 唯一省掉的是 dnd 注册。

    act(() => {
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      wrapper!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    act(() => {
      wrapper!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(selected).toEqual(["t_done", "t_done", "t_done"]); // 点击与 Enter/Space 激活都走 onSelect。

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

/**
 * draggable 收窄(W9):useDraggable 只挂在 `taskCan(task,"start")` 的卡上,
 * 不可拖卡不再注册 dnd 节点。悬停提示与点击行为保持不变。
 */
describe("draggable narrowing (W9)", () => {
  const draggableTask = (): TaskRow =>
    makeTask({
      taskId: "t_drag",
      title: "card-drag",
      coordinationStatus: "planned",
      capabilities: projectedTaskFields("planned", { can: ["start"] }).capabilities,
    });
  const frozenTask = (): TaskRow =>
    // 14 天窗口内的 done 不是冷终态(W8),默认折叠不会把它藏掉。
    makeTask({ taskId: "t_done", title: "card-done", coordinationStatus: "done", lastKnownAt: daysAgo(2) });

  it("registers exactly one draggable node: the start-capable card", async () => {
    const markup = await boardHtml([draggableTask(), frozenTask()]);
    expect(markup.split('data-testid="board-task-card"').length - 1).toBe(2); // 两张卡都在。
    expect(markup.split('aria-roledescription="draggable"').length - 1).toBe(1); // 只有可拖卡挂 dnd。
    // 两张卡的包装层都可聚焦(可拖卡经 dnd attributes,不可拖卡显式声明),焦点不随收窄丢失。
    // W11 起列头 resize 手柄也可聚焦(role="separator"),tabindex 计数只看卡包装层标签自身。
    expect(markup.split('role="button"').length - 1).toBe(2);
    const wrappers = markup.match(/<div[^>]*role="button"[^>]*>/gu) ?? [];
    expect(wrappers).toHaveLength(2);
    expect(wrappers.every((tag) => tag.includes('tabindex="0"'))).toBe(true);
  });

  it("keeps hover hint and click behavior on non-draggable cards", async () => {
    const selected: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(BoardView, {
          tasks: [draggableTask(), frozenTask()],
          allTasks: [draggableTask(), frozenTask()],
          filters: { ...DEFAULT_TASK_FILTERS },
          onFiltersChange: noop,
          onSelect: (id) => selected.push(id),
          relations: [],
          favorites: new Set<string>(),
          onToggleFavorite: noop,
          onSetPin: noop,
        }),
      );
    });
    const cards = container.querySelectorAll('[data-testid="board-task-card"]');
    expect(cards.length).toBe(2);
    const doneCard = [...cards].find((card) => card.querySelector("p")?.textContent === "card-done");
    expect(doneCard).toBeDefined();
    expect(doneCard!.getAttribute("title")).toContain("当前无可用动作"); // 悬停提示不变。
    act(() => {
      doneCard!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(selected).toEqual(["t_done"]); // 点击行为不变。
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps native Enter/Space activation on nested buttons of non-draggable cards", async () => {
    // 卡内 pin/收藏是原生 button(自带 Enter/Space 激活):包装层只处理自身发起的
    // 键事件,不吞子按钮的默认动作、不替子按钮选中任务。
    const selected: string[] = [];
    const favorites: string[] = [];
    const pins: Array<[string, boolean]> = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const frozen = frozenTask();
    await act(async () => {
      root.render(
        createElement(BoardView, {
          tasks: [frozen],
          allTasks: [frozen],
          filters: { ...DEFAULT_TASK_FILTERS },
          onFiltersChange: noop,
          onSelect: (id) => selected.push(id),
          relations: [],
          favorites: new Set<string>(),
          onToggleFavorite: (id) => favorites.push(id),
          onSetPin: (task, pinned) => pins.push([task.taskId, pinned]),
        }),
      );
    });

    const card = container.querySelector('[data-testid="board-task-card"]')!;
    const wrapper = card.closest('[role="button"]')!;
    const pinButton = container.querySelector('[data-testid="board-pin-toggle-t_done"]') as HTMLButtonElement;
    const favoriteButton = [...card.querySelectorAll("button")].find(
      (button) => button.getAttribute("title") === "收藏(置顶)",
    ) as HTMLButtonElement;
    expect(pinButton).not.toBeNull();
    expect(favoriteButton).not.toBeNull();

    pinButton.focus();
    expect(document.activeElement).toBe(pinButton); // 原生子按钮真实持有焦点。
    const enterOnPin = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    pinButton.dispatchEvent(enterOnPin);
    const spaceOnFavorite = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    favoriteButton.dispatchEvent(spaceOnFavorite);
    expect(enterOnPin.defaultPrevented).toBe(false); // 默认动作未被吞:真实浏览器里原生激活照常发生。
    expect(spaceOnFavorite.defaultPrevented).toBe(false);
    expect(selected).toEqual([]); // 冒泡到包装层也不选卡。

    favoriteButton.click(); // 原生激活的产物是 click:按钮自己的动作保持。
    pinButton.click();
    expect(favorites).toEqual(["t_done"]);
    expect(pins).toEqual([["t_done", true]]);
    expect(selected).toEqual([]); // 按钮动作不连带选卡(stopPropagation 生效)。

    wrapper.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    wrapper.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(selected).toEqual(["t_done", "t_done"]); // 包装层自身的 Enter/Space 仍选卡。

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

/**
 * 泳道单遍分组(W9):列头计数与单元格分组一次遍历产出(useMemo 缓存),
 * 语义与逐列 filter 一致——计数按 coordinationStatus 全量统计,与泳道无关。
 */
describe("swimlane single-pass grouping (W9)", () => {
  const laneTasks = (): TaskRow[] => [
    makeTask({
      taskId: "t_p1",
      title: "lane-card-p1",
      rootTaskId: "root-a",
      rootTitle: "Lane A",
      coordinationStatus: "planned",
    }),
    makeTask({
      taskId: "t_p2",
      title: "lane-card-p2",
      rootTaskId: "root-a",
      rootTitle: "Lane A",
      coordinationStatus: "planned",
    }),
    makeTask({
      taskId: "t_a1",
      title: "lane-card-a1",
      rootTaskId: "root-a",
      rootTitle: "Lane A",
      coordinationStatus: "active",
    }),
    makeTask({
      taskId: "t_b1",
      title: "lane-card-b1",
      rootTaskId: "root-b",
      rootTitle: "Lane B",
      coordinationStatus: "in_review",
    }),
  ];

  it("counts every status column header in one pass", () => {
    const markup = renderToStaticMarkup(
      createElement(SwimlaneBoard, {
        tasks: laneTasks(),
        groupBy: "root",
        onSelect: noop,
        drill: null,
        spawningDecisions: new Map(),
        favorites: new Set<string>(),
        onToggleFavorite: noop,
        onSetPin: noop,
      }),
    );
    expect(markup).toContain('data-testid="swimlane-status-planned-count">2</span>');
    expect(markup).toContain('data-testid="swimlane-status-active-count">1</span>');
    expect(markup).toContain('data-testid="swimlane-status-in_review-count">1</span>');
    expect(markup).toContain('data-testid="swimlane-status-done-count">0</span>');
    // 泳道行计数仍然可见:lane A 3 张、lane B 1 张。
    expect(markup).toContain("3");
    expect(markup).toContain("1");
  });

  it("keeps lane order and drilldown cells after regrouping", () => {
    const markup = renderToStaticMarkup(
      createElement(SwimlaneBoard, {
        tasks: laneTasks(),
        groupBy: "root",
        onSelect: noop,
        drill: { lane: "root-a", status: "planned", groupBy: "root" },
        spawningDecisions: new Map(),
        favorites: new Set<string>(),
        onToggleFavorite: noop,
        onSetPin: noop,
      }),
    );
    // 下钻面板打开时,root-a/planned 单元格的两张卡都渲染;lane B 的卡只出现在
    // 单元格预览里(预览标题是合法内容),不进下钻面板。
    expect(markup).toContain("lane-card-p1");
    expect(markup).toContain("lane-card-p2");
    const drilldown = markup.slice(markup.indexOf("下钻结果"));
    expect(drilldown).not.toContain("lane-card-b1");
  });
});

/**
 * 看板 windowing(W10)的行为判据(2026-09-09 并入自 board-windowing.vitest.ts,
 * 按任务指示归入既有 happy-dom 文件,不新增独立 .vitest 文件):
 *  - 挂载面:列内卡数与泳道行数只随视口 + overscan 走,与列总量/泳道总量解耦
 *    (W10 基线:canonical done 单列 1699 卡全挂载、泳道 928 行全挂载);
 *  - 可达面:窗口随滚动移动,深处条目滚动可达,不引入「再显示」分批按钮;
 *  - 显形面:列/泳道头计数徽章继续显示全量口径,窗口不是静默截断(W6 先例);
 *  - 交互面:窗口内可拖卡的 dnd 注册面保留(列级 droppable + DragOverlay 不变,
 *    细粒度 dnd 断言在上方 W9 用例里)。
 */
/** 桩高 600px:初始窗口 ≈ 视口 1 项 + 前后 overscan 6,给足余量的上界。 */
const MOUNTED_WINDOW_BOUND = 40;

interface MountedBoard {
  container: HTMLDivElement;
  root: Root;
  html: () => string;
}

async function mountLive(node: ReactElement): Promise<MountedBoard> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return { container, root, html: () => container.innerHTML };
}

async function unmountLive(board: MountedBoard): Promise<void> {
  await act(async () => {
    board.root.unmount();
  });
  board.container.remove();
}

/** happy-dom 没有布局:滚动用显式 scrollTop + scroll 事件 + 两帧 rAF 冲刷窗口重算。 */
async function scrollTo(element: HTMLElement, top: number): Promise<void> {
  await act(async () => {
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

describe("board column windowing (W10)", () => {
  const columnTasks = (count: number): TaskRow[] =>
    Array.from({ length: count }, (_, index) =>
      makeTask({
        taskId: `task_${index}`,
        title: `Task ${index}`,
        coordinationStatus: "planned",
        capabilities: projectedTaskFields("planned", { can: ["start"] }).capabilities,
        lastKnownAt: daysAgo(index + 1),
      }),
    );

  async function mountColumnWindow(tasks: TaskRow[]): Promise<MountedBoard> {
    setMeasureHeight(108); // 列卡估算高(CARD_ESTIMATE_PX)
    return mountLive(createElement(BoardView, boardProps({ tasks })));
  }

  it("mounts a viewport-bounded card subset while the column count badge shows the total", async () => {
    const board = await mountColumnWindow(columnTasks(1200));
    try {
      const html = board.html();
      expect(board.container.querySelectorAll('[data-testid="board-task-card"]').length).toBeGreaterThan(0);
      expect(board.container.querySelectorAll('[data-testid="board-task-card"]').length).toBeLessThanOrEqual(
        MOUNTED_WINDOW_BOUND,
      ); // 上界与总量 1200 无关。
      expect(html).toContain('data-testid="board-status-planned-count">1200</span>'); // 全量口径显形。
      expect(html).not.toContain("再显示"); // 不是分批按钮,是窗口。
      expect(html).not.toContain('data-testid="board-column-more-');
    } finally {
      await unmountLive(board);
    }
  });

  it("moves the window on scroll: deep cards become reachable, far cards unmount", async () => {
    const board = await mountColumnWindow(columnTasks(1200));
    try {
      const list = board.container.querySelector('[data-testid="board-column-list-planned"]') as HTMLElement;
      expect(list).not.toBeNull();
      expect(board.html()).toContain("Task 0");
      // 桩高 = 估算 108px:滚到第 ~111 项(108 × 111),窗口移到中段。
      await scrollTo(list, 108 * 111);
      const html = board.html();
      expect(html).toContain("Task 111"); // 深处条目可达。
      expect(html).not.toContain("Task 0"); // 远端条目卸载,这就是窗口的意义。
      expect(board.container.querySelectorAll('[data-testid="board-task-card"]').length).toBeLessThanOrEqual(
        MOUNTED_WINDOW_BOUND,
      );
    } finally {
      await unmountLive(board);
    }
  });

  it("keeps the dnd drag surface on windowed start-capable cards", async () => {
    const board = await mountColumnWindow(columnTasks(30));
    try {
      const html = board.html();
      expect(html).toContain('aria-roledescription="draggable"'); // 窗口内可拖卡仍注册 dnd。
      expect((html.match(/aria-roledescription="draggable"/gu) ?? []).length).toBe(
        board.container.querySelectorAll('[data-testid="board-task-card"]').length,
      );
    } finally {
      await unmountLive(board);
    }
  });
});

describe("swimlane row windowing (W10)", () => {
  const laneTasks = (count: number): TaskRow[] =>
    Array.from({ length: count }, (_, index) =>
      makeTask({
        taskId: `task_${index}`,
        title: `Task ${index}`,
        coordinationStatus: "planned",
        rootTaskId: `root_${index}`,
        rootTitle: `Lane ${index}`,
        lastKnownAt: daysAgo(index + 1),
      }),
    );

  async function mountSwimlaneWindow(tasks: TaskRow[]): Promise<MountedBoard> {
    setMeasureHeight(84); // 泳道行估算高(LANE_ROW_ESTIMATE_PX)
    return mountLive(
      createElement(SwimlaneBoard, {
        tasks,
        groupBy: "root",
        onSelect: noop,
        drill: null,
        spawningDecisions: new Map(),
        favorites: new Set<string>(),
        onToggleFavorite: noop,
        onSetPin: noop,
      }),
    );
  }

  it("mounts a viewport-bounded row subset while header totals show the full count", async () => {
    const board = await mountSwimlaneWindow(laneTasks(400));
    try {
      const html = board.html();
      expect(board.container.querySelectorAll('[data-testid="swimlane-row"]').length).toBeGreaterThan(0);
      expect(board.container.querySelectorAll('[data-testid="swimlane-row"]').length).toBeLessThanOrEqual(
        MOUNTED_WINDOW_BOUND,
      ); // 行上界与 400 条泳道无关。
      expect(html).toContain('data-testid="swimlane-status-planned-count">400</span>');
      expect(html).toContain("Lane 0");
      expect(html).not.toContain("Lane 399"); // 初始窗口只到近端。
    } finally {
      await unmountLive(board);
    }
  });

  it("scrolls the lane window to the far end: last lanes reachable, first unmount", async () => {
    const board = await mountSwimlaneWindow(laneTasks(400));
    try {
      const scroller = board.container.querySelector('[data-testid="swimlane-scroll"]') as HTMLElement;
      expect(scroller).not.toBeNull();
      // happy-dom 无布局,scrollHeight 不可用;滚到末行(84 × 399)。
      await scrollTo(scroller, 84 * 399);
      const html = board.html();
      expect(html).toContain("Lane 399"); // 最深泳道可达。
      expect(html).not.toContain(">Lane 0<"); // 近端行卸载。
      expect(board.container.querySelectorAll('[data-testid="swimlane-row"]').length).toBeLessThanOrEqual(
        MOUNTED_WINDOW_BOUND,
      );
    } finally {
      await unmountLive(board);
    }
  });
});

/**
 * 看板列宽偏好与 resize(W11):三种布局共用一份「每列一个数字 + 默认值」的
 * localStorage 记忆(不进台账、不进 URL);未设置的列走各视图默认——列模式
 * basis-1/4 等分、泳道 180+7×230、列表 table-fixed 自动分配。手柄键盘可达
 * (Tab 聚焦 + ←/→ 微调),双击恢复默认;拖拽/微调即时落盘,重挂载后保留。
 */
const WIDTH_KEY = "harness:gui:board-column-widths";

const widthMemory = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
};

const storedWidths = (layout: "column" | "swimlane" | "list"): Record<string, number> =>
  JSON.parse(localStorage.getItem(WIDTH_KEY) ?? "{}")[layout] ?? {};

async function mountBoardView(tasks: TaskRow[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(BoardView, {
        tasks,
        allTasks: tasks,
        filters: { ...DEFAULT_TASK_FILTERS },
        onFiltersChange: noop,
        onSelect: noop,
        relations: [],
        favorites: new Set<string>(),
        onToggleFavorite: noop,
        onSetPin: noop,
      }),
    );
  });
  return { container, root };
}

describe("board column width preferences (W11)", () => {
  it("round-trips per-layout width maps and leaves unset layouts empty", () => {
    const storage = widthMemory();
    expect(readBoardColumnWidths(storage)).toEqual(emptyBoardColumnWidths);
    let widths = setBoardColumnWidth(emptyBoardColumnWidths, "column", "planned", 360);
    widths = setBoardColumnWidth(widths, "swimlane", "lane", 200);
    widths = setBoardColumnWidth(widths, "list", "title", 420);
    writeBoardColumnWidths(storage, widths);
    expect(readBoardColumnWidths(storage)).toEqual(widths);
  });

  it("clamps and rounds widths into the sanity range on write", () => {
    expect(setBoardColumnWidth(emptyBoardColumnWidths, "column", "planned", 3).column.planned).toBe(40);
    expect(setBoardColumnWidth(emptyBoardColumnWidths, "column", "planned", 9999).column.planned).toBe(1200);
    expect(setBoardColumnWidth(emptyBoardColumnWidths, "column", "planned", 300.6).column.planned).toBe(301);
  });

  it("falls back to defaults on bad JSON or non-numeric entries", () => {
    const storage = widthMemory();
    storage.setItem(WIDTH_KEY, "{not json");
    expect(readBoardColumnWidths(storage)).toEqual(emptyBoardColumnWidths);
    storage.setItem(WIDTH_KEY, JSON.stringify({ column: { planned: "wide" }, swimlane: 7 }));
    expect(readBoardColumnWidths(storage)).toEqual(emptyBoardColumnWidths);
  });

  it("clear removes one key and is a no-op for absent keys", () => {
    const widths = setBoardColumnWidth(emptyBoardColumnWidths, "swimlane", "lane", 200);
    expect(clearBoardColumnWidth(widths, "swimlane", "lane").swimlane).toEqual({});
    expect(clearBoardColumnWidth(widths, "swimlane", "missing")).toBe(widths);
  });

  it("missing storage (SSR) and failing writes never block the view", () => {
    expect(readBoardColumnWidths(null)).toEqual(emptyBoardColumnWidths);
    expect(() => writeBoardColumnWidths(null, emptyBoardColumnWidths)).not.toThrow();
    expect(() => writeBoardColumnWidths(boardColumnPreferenceStorage(), emptyBoardColumnWidths)).not.toThrow();
  });
});

describe("board column resize: column mode (W11)", () => {
  beforeEach(() => {
    localStorage.removeItem(WIDTH_KEY);
  });

  it("renders equal-quarter columns by default with one keyboard-reachable handle per column", async () => {
    const markup = await boardHtml([makeTask({ coordinationStatus: "planned" })]);
    expect(markup.split('data-testid="board-column-resize-').length - 1).toBe(BOARD_COLUMNS.length);
    const handle = markup.match(/<div[^>]*data-testid="board-column-resize-planned"[^>]*>/u)![0];
    expect(handle).toContain('role="separator"');
    expect(handle).toContain('tabindex="0"');
    // 未定宽列保持等分默认:不输出显式宽度。
    expect(markup).not.toContain('style="width');
  });

  it("applies a persisted width as an explicit column width", async () => {
    localStorage.setItem(WIDTH_KEY, JSON.stringify({ column: { planned: 360 } }));
    const markup = await boardHtml([makeTask({ coordinationStatus: "planned" })]);
    const column = markup.match(/<div[^>]*data-testid="board-column-planned"[^>]*>/u)![0];
    // 活 DOM 的 style 序列化在冒号后带空格、句尾带分号。
    expect(column).toMatch(/style="width:\s*360px/u);
    expect(column).not.toContain("basis-1/4");
    const handle = markup.match(/<div[^>]*data-testid="board-column-resize-planned"[^>]*>/u)![0];
    expect(handle).toContain('aria-valuenow="360"');
  });

  it("drags the handle to widen a column, fine-tunes with arrow keys, and persists", async () => {
    localStorage.setItem(WIDTH_KEY, JSON.stringify({ column: { planned: 300 } }));
    const board = await mountBoardView([makeTask({ coordinationStatus: "planned" })]);
    const handle = board.container.querySelector<HTMLElement>('[data-testid="board-column-resize-planned"]')!;
    const column = board.container.querySelector<HTMLElement>('[data-testid="board-column-planned"]')!;

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 160, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 160, pointerId: 1 }));
    });
    expect(column.style.width).toBe("360px");
    expect(storedWidths("column").planned).toBe(360);

    act(() => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(column.style.width).toBe("376px");
    act(() => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(column.style.width).toBe("360px");
    expect(storedWidths("column").planned).toBe(360);

    act(() => {
      board.root.unmount();
    });
    board.container.remove();
  });

  it("keeps the resized width across a remount (window reload equivalent)", async () => {
    localStorage.setItem(WIDTH_KEY, JSON.stringify({ column: { planned: 300 } }));
    const first = await mountBoardView([makeTask({ coordinationStatus: "planned" })]);
    const handle = first.container.querySelector<HTMLElement>('[data-testid="board-column-resize-planned"]')!;
    act(() => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    act(() => {
      first.root.unmount();
    });
    first.container.remove();

    const second = await mountBoardView([makeTask({ coordinationStatus: "planned" })]);
    const column = second.container.querySelector<HTMLElement>('[data-testid="board-column-planned"]')!;
    expect(column.style.width).toBe("316px");
    act(() => {
      second.root.unmount();
    });
    second.container.remove();
  });

  it("double-click resets the column to the default equal-quarter layout", async () => {
    localStorage.setItem(WIDTH_KEY, JSON.stringify({ column: { planned: 300 } }));
    const board = await mountBoardView([makeTask({ coordinationStatus: "planned" })]);
    const handle = board.container.querySelector<HTMLElement>('[data-testid="board-column-resize-planned"]')!;
    act(() => {
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    const column = board.container.querySelector<HTMLElement>('[data-testid="board-column-planned"]')!;
    expect(column.style.width).toBe("");
    expect(column.className).toContain("basis-1/4");
    expect(storedWidths("column").planned).toBeUndefined();
    act(() => {
      board.root.unmount();
    });
    board.container.remove();
  });
});

describe("swimlane column resize (W11)", () => {
  beforeEach(() => {
    localStorage.removeItem(WIDTH_KEY);
  });

  const laneResizeFixture = (): TaskRow[] => [
    makeTask({ taskId: "t_p1", rootTaskId: "root-a", rootTitle: "Lane A", coordinationStatus: "planned" }),
  ];

  // 泳道行是 windowing(W10):行在挂载后按视口窗口出现,SSR markup 里没有行,
  // 「表头 + 行都带模板」的断言必须走真实 DOM 挂载。
  it("renders the default 180px lane + 7×230px status template on header and rows", async () => {
    setMeasureHeight(84);
    const board = await mountLive(
      createElement(SwimlaneBoard, {
        tasks: laneResizeFixture(),
        groupBy: "root",
        onSelect: noop,
        drill: null,
        spawningDecisions: new Map(),
        favorites: new Set<string>(),
        onToggleFavorite: noop,
        onSetPin: noop,
      }),
    );
    try {
      const markup = board.html();
      // 活 DOM 的 style 序列化在冒号后带空格,用宽容正则计数(表头 + 每泳道行)。
      const template = new RegExp(`grid-template-columns:\\s*${["180px", ...Array(7).fill("230px")].join(" ")}`, "gu");
      expect(markup.match(template)).toHaveLength(2); // sticky 表头 + 单泳道行(fixture 1 条泳道)。
      expect(markup.split('data-testid="swimlane-column-resize-').length - 1).toBe(BOARD_COLUMNS.length);
      expect(markup).toContain('data-testid="swimlane-lane-resize"');
    } finally {
      await unmountLive(board);
    }
  });

  it("derives the template from persisted lane and status widths", () => {
    localStorage.setItem(WIDTH_KEY, JSON.stringify({ swimlane: { lane: 200, planned: 320 } }));
    const markup = renderToStaticMarkup(
      createElement(SwimlaneBoard, {
        tasks: laneResizeFixture(),
        groupBy: "root",
        onSelect: noop,
        drill: null,
        relations: [],
        favorites: new Set<string>(),
        onToggleFavorite: noop,
        onSetPin: noop,
      }),
    );
    expect(markup).toContain("grid-template-columns:200px 320px 230px");
  });

  it("drags a status column wider and fine-tunes the lane column with arrow keys", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(SwimlaneBoard, {
          tasks: laneResizeFixture(),
          groupBy: "root",
          onSelect: noop,
          drill: null,
          relations: [],
          favorites: new Set<string>(),
          onToggleFavorite: noop,
          onSetPin: noop,
        }),
      );
    });
    const statusHandle = container.querySelector<HTMLElement>('[data-testid="swimlane-column-resize-planned"]')!;
    act(() => {
      statusHandle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 80, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 140, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 140, pointerId: 1 }));
    });
    expect(storedWidths("swimlane").planned).toBe(290);
    // 活 DOM 的 style 序列化在冒号后带空格,断言不带冒号的模板子串。
    expect(container.innerHTML).toContain("180px 290px 230px");

    const laneHandle = container.querySelector<HTMLElement>('[data-testid="swimlane-lane-resize"]')!;
    act(() => {
      laneHandle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(storedWidths("swimlane").lane).toBe(164); // 180 - 16。
    expect(container.innerHTML).toContain("164px 290px 230px");

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
