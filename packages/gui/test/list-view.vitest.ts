// harness-test-tier: contract
// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { ListView } from "../src/renderer/views/ListView.tsx";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

beforeAll(() => setActiveLocale("en-US"));

const makeTask = (overrides: Partial<TaskRow> = {}): TaskRow => ({
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
});

// The list is an audit view: rows navigate, the pager pages, favorites pin.
// Batch operations were removed together with their simulated-alert buttons — until a
// real batch command exists in the daemon registry there is nothing honest for a
// selection to do, so no selection affordance is rendered either.
describe("list view", () => {
  it("pins ledger-pinned tasks to the top with a marker and an inline write affordance", () => {
    const later = makeTask({ taskId: "task-later", title: "Later", lastKnownAt: "2026-07-01T00:00:00.000Z" });
    const pinned = makeTask({
      taskId: "task-pinned",
      title: "Pinned today",
      lastKnownAt: "2026-06-01T00:00:00.000Z",
      pinned: true,
      activeExecutionId: "execution-holder",
      leaseHolder: "person-zeyu · codex-sol",
      leasePhase: "held",
      leaseExpiresAt: "2026-08-30T01:00:00.000Z",
      currentNode: "review",
      canonicalStatus: "active",
    });
    const favorite = makeTask({ taskId: "task-favorite", title: "Favorite", lastKnownAt: "2026-07-05T00:00:00.000Z" });
    const tasks = [later, pinned, favorite];
    const markup = renderToStaticMarkup(
      createElement(ListView, {
        tasks,
        allTasks: tasks,
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: () => undefined,
        onSelect: () => undefined,
        spawningDecisions: new Map(),
        favorites: new Set(["task-favorite"]),
        onToggleFavorite: () => undefined,
        onSetPin: () => undefined,
        embedded: true,
      }),
    );
    // 置顶次序:台账 pin → 本地收藏 → 更新时间。
    const firstRow = markup.indexOf("task-pinned"),
      secondRow = markup.indexOf("task-favorite"),
      thirdRow = markup.indexOf("task-later");
    expect(firstRow).toBeGreaterThan(-1);
    expect(firstRow).toBeLessThan(secondRow);
    expect(secondRow).toBeLessThan(thirdRow);
    expect(markup).toContain("task-pinned-marker-task-pinned");
    expect(markup).toContain("task-pin-toggle-task-pinned");
    // 行内直接给出 status / currentNode / lease 持有者,不必点进详情。
    expect(markup).toContain("graph cursor:review");
    expect(markup).toContain("execution-holder");
    expect(markup).toContain("person-zeyu · codex-sol");
    expect(markup).toContain("held");
    expect(markup).toContain("no lease");
  });

  it("renders canonical terminal status as primary and the graph cursor as secondary", () => {
    const complete = makeTask({
      taskId: "task-complete",
      canonicalStatus: "done",
      coordinationStatus: "in_review",
      currentNode: "review",
    });
    const markup = renderToStaticMarkup(
      createElement(ListView, {
        tasks: [complete],
        allTasks: [complete],
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: () => undefined,
        onSelect: () => undefined,
        spawningDecisions: new Map(),
        favorites: new Set(),
        onToggleFavorite: () => undefined,
        embedded: true,
      }),
    );
    expect(markup).toContain("coordination=in_review");
    expect(markup).toContain("graph cursor:review");
    expect(markup.indexOf("--color-status-done")).toBeLessThan(markup.indexOf("coordination=in_review"));
    expect(markup.indexOf("coordination=in_review")).toBeLessThan(markup.indexOf("graph cursor:review"));
  });

  it("keeps pinned state read-only when no pin write channel is wired", () => {
    const pinned = makeTask({ taskId: "task-pinned", title: "Pinned", pinned: true });
    const markup = renderToStaticMarkup(
      createElement(ListView, {
        tasks: [pinned],
        allTasks: [pinned],
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: () => undefined,
        onSelect: () => undefined,
        spawningDecisions: new Map(),
        favorites: new Set<string>(),
        onToggleFavorite: () => undefined,
        embedded: true,
      }),
    );
    expect(markup).toContain("task-pinned-marker-task-pinned");
    expect(markup).not.toContain("task-pin-toggle-");
  });

  it("renders rows and the pager without any selection or batch-operation affordance", () => {
    const tasks = [makeTask(), makeTask({ taskId: "task-b", title: "Beta" })];
    const markup = renderToStaticMarkup(
      createElement(ListView, {
        tasks,
        allTasks: tasks,
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: () => undefined,
        onSelect: () => undefined,
        spawningDecisions: new Map(),
        favorites: new Set(),
        onToggleFavorite: () => undefined,
        embedded: true,
      }),
    );
    for (const text of ["task-a", "Alpha", "task-b", "Beta", "Previous page", "Next page"])
      expect(markup).toContain(text);
    expect(markup).not.toContain('type="checkbox"');
    for (const gone of ["Batch operations", "Batch run Check", "Batch mark Ready", "Batch archiving", "Deselect"])
      expect(markup).not.toContain(gone);
  });
});

/**
 * 列表列宽 resize(W11):table-fixed 下 th 的显式宽度即列宽,未设置的列自动分配
 * 剩余宽度;手柄键盘可达,双击恢复默认,与看板另两布局共用同一 localStorage 键。
 */
const WIDTH_KEY = "harness:gui:board-column-widths";

const listMarkup = (widthsJson?: string): string => {
  if (widthsJson === undefined) localStorage.removeItem(WIDTH_KEY);
  else localStorage.setItem(WIDTH_KEY, widthsJson);
  const tasks = [makeTask()];
  return renderToStaticMarkup(
    createElement(ListView, {
      tasks,
      allTasks: tasks,
      filters: DEFAULT_TASK_FILTERS,
      onFiltersChange: () => undefined,
      onSelect: () => undefined,
      spawningDecisions: new Map(),
      favorites: new Set(),
      onToggleFavorite: () => undefined,
      embedded: true,
    }),
  );
};

async function mountList() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const tasks = [makeTask()];
  await act(async () => {
    root.render(
      createElement(ListView, {
        tasks,
        allTasks: tasks,
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: () => undefined,
        onSelect: () => undefined,
        spawningDecisions: new Map(),
        favorites: new Set(),
        onToggleFavorite: () => undefined,
        embedded: true,
      }),
    );
  });
  return { container, root };
}

const storedListWidths = (): Record<string, number> => JSON.parse(localStorage.getItem(WIDTH_KEY) ?? "{}").list ?? {};

describe("list view column resize (W11)", () => {
  beforeEach(() => {
    localStorage.removeItem(WIDTH_KEY);
  });

  it("renders one keyboard-reachable handle per header column with no explicit widths by default", () => {
    const markup = listMarkup();
    expect(markup.split('data-testid="list-column-resize-').length - 1).toBe(8);
    const headerCell = markup.match(/<th[^>]*data-testid="list-column-title"[^>]*>/u)![0];
    const handle = markup.match(/<div[^>]*data-testid="list-column-resize-title"[^>]*>/u)![0];
    expect(handle).toContain('role="separator"');
    expect(handle).toContain('tabindex="0"');
    expect(handle).toContain("Resize the &quot;title / module&quot; column");
    // 回归:真实 Electron 验收发现共享基类缺 position:absolute,静态流里手柄高度
    // 恒 0、鼠标无命中区、拖拽无效(2026-09-09);定位链 = relative th + 基类内置
    // absolute + 消费方 inset 偏移。命中区像素高度由 Electron 走查复核,类名断言
    // 不证明像素行为。
    expect(headerCell).toContain("relative");
    expect(handle).toContain("absolute");
    expect(handle).toContain("inset-y-0");
    // 未定宽列走 table-fixed 自动分配:th 不输出显式宽度。
    expect(markup).not.toContain('style="width');
  });

  it("applies a persisted width to its header cell", () => {
    const markup = listMarkup(JSON.stringify({ list: { title: 420, pins: 64 } }));
    const title = markup.match(/<th[^>]*data-testid="list-column-title"[^>]*>/u)![0];
    expect(title).toContain('style="width:420px"');
    const pins = markup.match(/<th[^>]*data-testid="list-column-pins"[^>]*>/u)![0];
    expect(pins).toContain('style="width:64px"');
    const handle = markup.match(/<div[^>]*data-testid="list-column-resize-title"[^>]*>/u)![0];
    expect(handle).toContain('aria-valuenow="420"');
  });

  // 回归:真实 Electron 验收发现 table-fixed 窄列里未收敛的 font-mono 长 taskId
  // 直接画进 Title 列(2026-09-09)。此处只断言收敛原语(截断类 + title 悬停)在
  // 标记里就位;像素级不越列由 Electron 走查复核,类名断言不证明像素行为。
  it("contains unbreakable cell values inside their fixed columns and keeps the full id on hover", () => {
    const longDecisionId = "dec_01KZWTAPXF24FR62Q53Y42JGMV";
    const task = makeTask({
      taskId: "task_eeb3b5f08c093e63622b24392c",
      title: "Overflow regression",
      module: "packages/daemon",
      canonicalStatus: "done",
      coordinationStatus: "in_review",
      currentNode: "implementation",
      activeExecutionId: "execution_eeb3b5f08c093e63622b24392c",
      leaseHolder: "person-zeyu · codex-sol",
      leasePhase: "held",
    });
    const markup = renderToStaticMarkup(
      createElement(ListView, {
        tasks: [task],
        allTasks: [task],
        filters: DEFAULT_TASK_FILTERS,
        onFiltersChange: () => undefined,
        onSelect: () => undefined,
        spawningDecisions: new Map([["task_eeb3b5f08c093e63622b24392c", longDecisionId]]),
        favorites: new Set<string>(),
        onToggleFavorite: () => undefined,
        embedded: true,
      }),
    );
    const idLine = markup.match(/<div[^>]*>task_eeb3b5f08c093e63622b24392c<\/div>/u)![0];
    expect(idLine).toContain("truncate");
    expect(idLine).toContain('title="task_eeb3b5f08c093e63622b24392c"'); // 悬停可见整串。
    const dateLine = markup.match(/<div[^>]*class="mt-1 truncate[^"]*"[^>]*>[^<]+<\/div>/u)![0];
    expect(dateLine).toBeTruthy();
    // 同一 fixed 布局下其余不可断行值同样收敛在本列:coordination 键值串、节点行、
    // 模块名、包处置枚举 chip。
    expect(markup.match(/<span[^>]*>coordination=in_review<\/span>/u)![0]).toContain("truncate");
    expect(markup.match(/<span[^>]*>graph cursor:implementation<\/span>/u)![0]).toContain("truncate");
    expect(markup.match(/<span[^>]*>packages\/daemon<\/span>/u)![0]).toContain("truncate");
    expect(markup.match(/<span[^>]*>active<\/span>/u)![0]).toContain("max-w-full");
    // 二次验收(2026-09-09):长 decision 徽章与状态列各行在 136px 窄列画进相邻列。
    // 徽章外包可收缩截断项,整串 decision id 保留在徽章自身 title(悬停)与 DOM 文本。
    const badge = markup.match(
      new RegExp(`<span class="min-w-0 truncate"><span[^>]*title="[^"]*${longDecisionId}[^"]*"`, "u"),
    );
    expect(badge).not.toBeNull();
    expect(markup).toContain(longDecisionId); // 截断只是绘制层,屏幕阅读器仍读整串。
    // flex 列 cross 轴的 truncate 必须配 max-w-full 才有盒宽可裁;lease 原来的
    // max-w-[16rem] 上限大于任何窄列,等于没封。
    for (const line of [
      /<span[^>]*>coordination=in_review<\/span>/u,
      /<span[^>]*>graph cursor:implementation<\/span>/u,
      /<span[^>]*>execution_eeb3b5f08c093e63622b24392c[^<]*<\/span>/u,
    ]) {
      const span = markup.match(line)![0];
      expect(span).toContain("max-w-full");
      expect(span).toContain("truncate");
      expect(span).not.toContain("16rem");
    }
  });

  it("drags, fine-tunes with arrow keys, resets by double-click, and persists across remount", async () => {
    localStorage.setItem(WIDTH_KEY, JSON.stringify({ list: { title: 420 } }));
    const view = await mountList();
    const handle = view.container.querySelector<HTMLElement>('[data-testid="list-column-resize-title"]')!;
    const cell = view.container.querySelector<HTMLElement>('[data-testid="list-column-title"]')!;

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 40, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 40, pointerId: 1 }));
    });
    expect(cell.style.width).toBe("360px"); // 420 - 60。
    expect(storedListWidths().title).toBe(360);

    act(() => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(cell.style.width).toBe("376px"); // +16 微调。
    expect(storedListWidths().title).toBe(376);

    act(() => {
      view.root.unmount();
    });
    view.container.remove();

    // 重挂载(窗口重载等价):宽度从 localStorage 恢复。
    const reloaded = await mountList();
    const reloadedCell = reloaded.container.querySelector<HTMLElement>('[data-testid="list-column-title"]')!;
    expect(reloadedCell.style.width).toBe("376px");

    const reloadedHandle = reloaded.container.querySelector<HTMLElement>('[data-testid="list-column-resize-title"]')!;
    act(() => {
      reloadedHandle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(reloadedCell.style.width).toBe("");
    expect(storedListWidths().title).toBeUndefined();

    act(() => {
      reloaded.root.unmount();
    });
    reloaded.container.remove();
  });

  it("stops tracking on pointercancel: later moves neither resize nor persist, and a fresh drag recovers", async () => {
    localStorage.setItem(WIDTH_KEY, JSON.stringify({ list: { title: 420 } }));
    const view = await mountList();
    const handle = view.container.querySelector<HTMLElement>('[data-testid="list-column-resize-title"]')!;
    const cell = view.container.querySelector<HTMLElement>('[data-testid="list-column-title"]')!;

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 220, pointerId: 1 }));
    });
    // 取消后的移动不得落到列宽或 localStorage(stale 监听会写出 540)。
    expect(cell.style.width).toBe("420px");
    expect(storedListWidths().title).toBe(420);

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, pointerId: 2 }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 140, pointerId: 2 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 140, pointerId: 2 }));
    });
    expect(cell.style.width).toBe("460px"); // 新拖拽不受取消残留影响。
    expect(storedListWidths().title).toBe(460);

    act(() => {
      view.root.unmount();
    });
    view.container.remove();
  });

  it("releases window listeners when unmounted mid-drag, so stray moves never write storage", async () => {
    localStorage.setItem(WIDTH_KEY, JSON.stringify({ list: { title: 420 } }));
    const view = await mountList();
    const handle = view.container.querySelector<HTMLElement>('[data-testid="list-column-resize-title"]')!;

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, pointerId: 1 }));
    });
    act(() => {
      view.root.unmount();
    });
    view.container.remove();
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 220, pointerId: 1 }));
    });
    // 中途卸载后 stale 监听会同步写 localStorage(不依赖 React 挂载状态)。
    expect(storedListWidths().title).toBe(420);
  });

  it("announces the measured default width when no width is persisted, and re-measures after reset", async () => {
    // happy-dom 无布局引擎:以 stub 提供「父元素实测宽度」,真实浏览器由布局给出。
    const rectOf = (width: number) =>
      ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: 20, width, height: 20 }) as DOMRect;
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rectOf(300));
    try {
      const view = await mountList();
      const handle = view.container.querySelector<HTMLElement>('[data-testid="list-column-resize-title"]')!;
      const cell = view.container.querySelector<HTMLElement>('[data-testid="list-column-title"]')!;
      // 默认(未定宽)手柄也必须报数字现值,而不是省略 aria-valuenow。
      expect(handle.getAttribute("aria-valuenow")).toBe("300");
      expect(cell.style.width).toBe(""); // 报数不等于写假宽度:th 仍走默认布局。

      act(() => {
        handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 160, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent("pointerup", { clientX: 160, pointerId: 1 }));
      });
      expect(handle.getAttribute("aria-valuenow")).toBe("360"); // 定宽后报持久化值。

      measure.mockReturnValue(rectOf(320)); // 布局变了:恢复默认须重新量,不吐旧缓存。
      act(() => {
        handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      });
      expect(handle.getAttribute("aria-valuenow")).toBe("320");
      expect(cell.style.width).toBe("");

      act(() => {
        view.root.unmount();
      });
      view.container.remove();
    } finally {
      measure.mockRestore();
    }
  });
});
