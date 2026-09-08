// harness-test-tier: contract
// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    const handle = markup.match(/<div[^>]*data-testid="list-column-resize-title"[^>]*>/u)![0];
    expect(handle).toContain('role="separator"');
    expect(handle).toContain('tabindex="0"');
    expect(handle).toContain("Resize the &quot;title / module&quot; column");
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
});
