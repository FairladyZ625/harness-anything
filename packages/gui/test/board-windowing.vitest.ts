// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HTMLDivElement } from "happy-dom";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { BoardView } from "../src/renderer/views/BoardView.tsx";
import { SwimlaneBoard } from "../src/renderer/views/SwimlaneBoard.tsx";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

/**
 * 看板 windowing(W10)的行为判据:
 *  - 挂载面:列内卡数与泳道行数只随视口 + overscan 走,与列总量/泳道总量解耦
 *    (W10 基线:canonical done 单列 1699 卡全挂载、泳道 928 行全挂载);
 *  - 可达面:窗口随滚动移动,深处条目滚动可达,不引入「再显示」分批按钮;
 *  - 显形面:列/泳道头计数徽章继续显示全量口径,窗口不是静默截断(W6 先例);
 *  - 交互面:窗口内可拖卡的 dnd 注册面保留(列级 droppable + DragOverlay 不变,
 *    细粒度 dnd 断言在 taskFilters.vitest 的 W9 用例里)。
 *
 * happy-dom 没有布局:virtualizer 的视口读 offsetHeight、measureElement 读
 * getBoundingClientRect,统一桩成 600px,窗口项才会真的挂载;滚动用赋值
 * scrollTop + 派发 scroll 事件驱动。
 */

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const noop = () => undefined;

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_0",
    title: "Task 0",
    projectId: "p",
    coordinationStatus: "planned",
    capabilities: projectedTaskFields("planned", { can: ["start"] }).capabilities,
    rawStatus: "planned",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "core",
    lastKnownAt: daysAgo(1),
    gates: [],
    docs: [],
    board: { columnId: "open" },
    visibility: { archived: false, noise: false },
    blocking: "clear",
    blockers: [],
    origin: "internal",
    ...overrides,
  } as TaskRow;
}

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  html: () => string;
}

async function mount(node: (container: HTMLDivElement) => ReturnType<typeof createElement>): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node(container));
  });
  return {
    container,
    root,
    html: () => container.innerHTML,
  };
}

async function unmount(board: Mounted): Promise<void> {
  await act(async () => {
    board.root.unmount();
  });
  board.container.remove();
}

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
  // 视口与行高分途:happy-dom 的 ResizeObserver 也会读 offsetHeight 上报条目尺寸,
  // 所以窗口项(带 data-index 的定位包装)按 measureHeight 上报,滚动容器与其余
  // 元素按 600px 视口上报——估算=实测时窗口位置可按「scrollTop ÷ 行高」推算。
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

/** 桩高 600px:初始窗口 ≈ 视口 1 项 + 前后 overscan 6,给足余量的上界。 */
const MOUNTED_WINDOW_BOUND = 40;

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
      makeTask({ taskId: `task_${index}`, title: `Task ${index}`, lastKnownAt: daysAgo(index + 1) }),
    );

  async function mountBoard(tasks: TaskRow[]): Promise<Mounted> {
    setMeasureHeight(108); // 列卡估算高(CARD_ESTIMATE_PX)
    return mount(() =>
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
  }

  it("mounts a viewport-bounded card subset while the column count badge shows the total", async () => {
    const tasks = columnTasks(1200);
    const board = await mountBoard(tasks);
    try {
      const cards = board.container.querySelectorAll('[data-testid="board-task-card"]');
      expect(cards.length).toBeGreaterThan(0);
      expect(cards.length).toBeLessThanOrEqual(MOUNTED_WINDOW_BOUND); // 上界与总量 1200 无关。
      expect(board.html()).toContain('data-testid="board-status-planned-count">1200</span>'); // 全量口径显形。
      expect(board.html()).not.toContain("再显示"); // 不是分批按钮,是窗口。
      expect(board.html()).not.toContain('data-testid="board-column-more-');
    } finally {
      await unmount(board);
    }
  });

  it("moves the window on scroll: deep cards become reachable, far cards unmount", async () => {
    const tasks = columnTasks(1200);
    const board = await mountBoard(tasks);
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
      await unmount(board);
    }
  });

  it("keeps the dnd drag surface on windowed start-capable cards", async () => {
    const tasks = columnTasks(30);
    const board = await mountBoard(tasks);
    try {
      const html = board.html();
      expect(html).toContain('aria-roledescription="draggable"'); // 窗口内可拖卡仍注册 dnd。
      expect((html.match(/aria-roledescription="draggable"/gu) ?? []).length).toBe(
        board.container.querySelectorAll('[data-testid="board-task-card"]').length,
      );
    } finally {
      await unmount(board);
    }
  });
});

describe("swimlane row windowing (W10)", () => {
  const laneTasks = (count: number): TaskRow[] =>
    Array.from({ length: count }, (_, index) =>
      makeTask({
        taskId: `task_${index}`,
        title: `Task ${index}`,
        rootTaskId: `root_${index}`,
        rootTitle: `Lane ${index}`,
        lastKnownAt: daysAgo(index + 1),
      }),
    );

  async function mountSwimlane(tasks: TaskRow[]): Promise<Mounted> {
    setMeasureHeight(84); // 泳道行估算高(LANE_ROW_ESTIMATE_PX)
    return mount(() =>
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
    const tasks = laneTasks(400);
    const board = await mountSwimlane(tasks);
    try {
      const rows = board.container.querySelectorAll('[data-testid="swimlane-row"]');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(MOUNTED_WINDOW_BOUND); // 行上界与 400 条泳道无关。
      expect(board.html()).toContain('data-testid="swimlane-status-planned-count">400</span>');
      expect(board.html()).toContain("Lane 0");
      expect(board.html()).not.toContain("Lane 399"); // 初始窗口只到近端。
    } finally {
      await unmount(board);
    }
  });

  it("scrolls the lane window to the far end: last lanes reachable, first unmount", async () => {
    const tasks = laneTasks(400);
    const board = await mountSwimlane(tasks);
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
      await unmount(board);
    }
  });
});
