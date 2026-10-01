// @vitest-environment happy-dom
/**
 * 看板筛选区收成一行(2026-10-01,评审第 8 条)的行为判据:页头 = 页名 + 一句
 * 结论;筛选行 = 搜索 + 视图切换 + 一个「筛选」入口;高级筛选(状态 Pill、
 * 引擎/收口/新鲜度、冷终态、收藏、清除)收进默认收起的面板,能力一项不丢;
 * WIP 摘要不再占行,细节进结论句悬停。从 taskFilters.vitest.ts 按职责拆出
 * (文件复杂度门,2026-10-01)。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { BoardView } from "../src/renderer/views/BoardView.tsx";
import {
  activeTaskFilterCount,
  DEFAULT_TASK_FILTERS,
  hasActiveTaskFilters,
  type TaskFilters,
} from "../src/renderer/model/taskFilters.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { TaskWipRead } from "../src/api/renderer-dto.ts";
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
    lastKnownAt: "2026-07-09T00:00:00.000Z",
    gates: [],
    docs: [],
    ...projectedTaskFields(overrides.coordinationStatus ?? "active", {
      archived: (overrides.packageDisposition ?? "active") !== "active",
    }),
    ...overrides,
  };
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const noop = () => undefined;

const boardProps = (overrides: {
  tasks: TaskRow[];
  filters?: TaskFilters;
  favorites?: ReadonlySet<string>;
  wipSnapshot?: TaskWipRead;
}) => ({
  tasks: overrides.tasks,
  allTasks: overrides.tasks,
  filters: overrides.filters ?? { ...DEFAULT_TASK_FILTERS },
  onFiltersChange: noop,
  onSelect: noop,
  favorites: overrides.favorites ?? new Set<string>(),
  onToggleFavorite: noop,
  onSetPin: noop,
  ...(overrides.wipSnapshot === undefined ? {} : { wipSnapshot: overrides.wipSnapshot }),
});

/** openFilters:先点开「筛选」入口再取样——高级筛选默认收起在面板里。 */
async function boardHtml(
  tasks: TaskRow[],
  filters: TaskFilters = { ...DEFAULT_TASK_FILTERS },
  favorites: ReadonlySet<string> = new Set<string>(),
  options: { openFilters?: boolean } = {},
): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(BoardView, boardProps({ tasks, filters, favorites })));
    });
    if (options.openFilters) {
      await act(async () => {
        container
          .querySelector('[data-testid="board-filter-toggle"]')!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }
    return container.innerHTML;
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
  // windowing 测量桩:happy-dom 没有布局,视口与卡高按 taskFilters.vitest.ts 同款桩。
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-index") ? 108 : 600;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const height = (this as HTMLElement).hasAttribute?.("data-index") ? 108 : 600;
    return { width: 600, height, top: 0, left: 0, bottom: height, right: 600, x: 0, y: 0 } as DOMRect;
  });
});

/** 筛选入口的「生效 N」徽章:数偏离默认的维度个数。 */
describe("activeTaskFilterCount", () => {
  it("counts filter dimensions off their defaults", () => {
    expect(activeTaskFilterCount({ ...DEFAULT_TASK_FILTERS })).toBe(0);
    expect(activeTaskFilterCount({ ...DEFAULT_TASK_FILTERS, status: ["active"], engine: "local" })).toBe(2);
    expect(
      activeTaskFilterCount({
        ...DEFAULT_TASK_FILTERS,
        query: "x",
        closeout: "ready",
        freshness: "fresh",
        favoritesOnly: true,
        expandColdTerminal: true,
      }),
    ).toBe(5);
  });

  it("agrees with hasActiveTaskFilters on zero vs non-zero", () => {
    expect(activeTaskFilterCount({ ...DEFAULT_TASK_FILTERS }) === 0).toBe(
      !hasActiveTaskFilters({ ...DEFAULT_TASK_FILTERS }),
    );
    const narrowed = { ...DEFAULT_TASK_FILTERS, favoritesOnly: true };
    expect(activeTaskFilterCount(narrowed) > 0).toBe(hasActiveTaskFilters(narrowed));
  });
});

describe("board one-row filter area (2026-10-01 review #8)", () => {
  it("keeps the advanced filters behind the collapsed entry; opening the panel reveals them all", async () => {
    const tasks = [
      makeTask({ taskId: "t_open", coordinationStatus: "active", lastKnownAt: daysAgo(1) }),
      makeTask({ taskId: "t_fav", coordinationStatus: "planned", lastKnownAt: daysAgo(2) }),
    ];
    const collapsed = await boardHtml(tasks, { ...DEFAULT_TASK_FILTERS }, new Set(["t_fav"]));
    // 页头只剩 页名 + 一句结论;WIP 行与「冷终态默认折叠降噪」说明行已删。
    expect(collapsed).toContain('data-testid="board-header-summary"');
    expect(collapsed).toContain("2 in view · 2 total");
    expect(collapsed).not.toContain("task-wip-summary");
    // 默认收起:高级筛选一个都不在 DOM,筛选区只有一行(搜索 + 视图切换 + 入口)。
    for (const gone of [
      'data-testid="board-status-filter"',
      'data-testid="board-cold-terminal-toggle"',
      'data-testid="board-filter-panel"',
      "favorites only",
      ">Clear<",
    ]) {
      expect(collapsed).not.toContain(gone);
    }
    const entry = collapsed.match(/<button[^>]*data-testid="board-filter-toggle"[^>]*>/u)![0];
    expect(entry).toContain('aria-expanded="false"');

    const open = await boardHtml(tasks, { ...DEFAULT_TASK_FILTERS }, new Set(["t_fav"]), { openFilters: true });
    expect(open).toContain('data-testid="board-filter-panel"');
    expect(open.match(/<button[^>]*data-testid="board-filter-toggle"[^>]*>/u)![0]).toContain('aria-expanded="true"');
    // 能力一项不丢:状态 Pill、引擎/收口/新鲜度、收藏都在面板里(清除只在有
    // 生效筛选时出现,见下一条)。
    expect(open).toContain('data-testid="board-status-filter"');
    expect(open).toContain("favorites only");
    for (const selectLabel of ["engine", "closeout", "freshness"]) expect(open).toContain(selectLabel);
  });

  it("badges the collapsed entry with the count of active filters and offers Clear in the panel", async () => {
    const idle = await boardHtml([makeTask()]);
    expect(idle).not.toContain('data-testid="board-filter-active-count"');
    const narrowed = await boardHtml([makeTask()], { ...DEFAULT_TASK_FILTERS, engine: "local", status: ["active"] });
    const entry = narrowed.match(/<button[^>]*data-testid="board-filter-toggle"[\s\S]*?<\/button>/u)![0];
    expect(entry).toContain('data-testid="board-filter-active-count">2<');
    const narrowedOpen = await boardHtml(
      [makeTask()],
      { ...DEFAULT_TASK_FILTERS, engine: "local", status: ["active"] },
      new Set(),
      { openFilters: true },
    );
    expect(narrowedOpen).toContain(">Clear<");
  });

  it("hangs the WIP summary off the conclusion sentence as a hover title", async () => {
    const wipSnapshot = {
      ok: true,
      limit: 30,
      limitLabel: "manual",
      counted: [{ taskId: "t_open", status: "active", title: "Alpha" }],
      roots: [
        { taskId: "root-a", reason: "declared", directChildCount: 0 },
        { taskId: "root-b", reason: "derived", directChildCount: 3 },
      ],
      threshold: 3,
    } as unknown as TaskWipRead;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(BoardView, boardProps({ tasks: [makeTask()], wipSnapshot })));
    });
    const summary = container.querySelector('[data-testid="board-header-summary"]')!;
    expect(summary.getAttribute("title")).toContain("WIP 1/30");
    expect(summary.getAttribute("title")).toContain("root 2");
    expect(summary.getAttribute("title")).toContain("root-b(3)");
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
