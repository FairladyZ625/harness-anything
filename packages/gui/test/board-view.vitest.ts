// harness-test-tier: contract
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { SnapshotStatus, TaskRow } from "../src/renderer/model/types.ts";
import { BoardView } from "../src/renderer/views/BoardView.tsx";
import { SwimlaneBoard } from "../src/renderer/views/SwimlaneBoard.tsx";
import { DEFAULT_TASK_FILTERS, type TaskFilters } from "../src/renderer/model/taskFilters.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

/**
 * 看板默认序与冷终态折叠(W8):
 *   1. 列模式/泳道下钻卡片 = lastKnownAt 倒序打底,pin → 收藏稳定置顶;
 *   2. 泳道行序 = 组内最新 lastKnownAt 倒序;
 *   3. 冷终态(终态且非 isTaskGraphFocusSeed 种子)默认折叠,折叠态必须显形
 *      「N」计数与展开入口(W6 先例:不许静默截断),开关走 TaskFilters。
 * BoardView 的判定时钟在组件内部取 now,所以夹具日期相对真实时钟构造。
 */

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

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
    lastKnownAt: daysAgo(1),
    gates: [],
    docs: [],
    ...projectedTaskFields(overrides.coordinationStatus ?? "active", {
      archived: (overrides.packageDisposition ?? "active") !== "active",
    }),
    ...overrides,
  };
}

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

describe("cold terminal collapse (W8)", () => {
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
