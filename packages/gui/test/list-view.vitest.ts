// harness-test-tier: contract
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { ListView } from "../src/renderer/views/ListView.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

/**
 * 任务列表(标准 §2.4 列表页):回答「我要找某个任务」。行是 DenseRow + StatusTag,
 * 终态沉底折叠成「已完成 N 个 · 展开」;pin → 收藏 → 最近的活动行在前;行壳可
 * 键盘激活,行内 pin/收藏是原生按钮;空态一行说明,不画大框、无表格无分页。
 */
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
  // windowing 测量桩(happy-dom 没有布局):行高 28px,滚动容器 600px 视口。
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-index") ? 28 : 600;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const height = (this as HTMLElement).hasAttribute?.("data-index") ? 28 : 600;
    return { width: 600, height, top: 0, left: 0, bottom: height, right: 600, x: 0, y: 0 } as DOMRect;
  });
});

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
  lastKnownAt: "2026-07-09T00:00:00.000Z",
  gates: [],
  docs: [],
  ...projectedTaskFields(overrides.coordinationStatus ?? "active", {
    archived: (overrides.packageDisposition ?? "active") !== "active",
  }),
  ...overrides,
});

const noop = () => undefined;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  html: () => string;
}

async function mountList(
  tasks: readonly TaskRow[],
  props: Partial<Parameters<typeof ListView>[0]> = {},
): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(ListView, {
        tasks,
        onSelect: noop,
        favorites: new Set<string>(),
        onToggleFavorite: noop,
        onSetPin: noop,
        ...props,
      }),
    );
  });
  return {
    container,
    root,
    html: () => container.innerHTML,
  };
}

async function unmount(view: Mounted): Promise<void> {
  await act(async () => {
    view.root.unmount();
  });
  view.container.remove();
}

const rowOrder = (view: Mounted) =>
  [...view.container.querySelectorAll('[data-testid^="task-row-"]')].map((row) =>
    row.getAttribute("data-testid")!.replace("task-row-", ""),
  );

describe("task list rows (视觉基线 §2.4)", () => {
  it("renders DenseRow rows: StatusTag with background, TitleText title, task id as reason, relative time", async () => {
    const view = await mountList([makeTask({ taskId: "task_a", title: "Rework board: split by status" })]);
    try {
      const row = view.container.querySelector('[data-testid="task-row-task_a"]')!;
      expect(row).not.toBeNull();
      const tag = row.querySelector("[data-status-tone]")!;
      expect(tag.getAttribute("data-status-tone")).toBe("active");
      expect(tag.textContent).toContain("Active");
      expect(row.textContent).toContain("Rework board");
      expect(row.textContent).toContain("split by status");
      expect(row.innerHTML).toMatch(/class="text-text-faint">: split by status</u); // 冒号后补充弱色
      expect(row.textContent).toContain("task_a"); // id 是 reason,可被肉眼比对
      expect(row.textContent).toContain("2026-07-09"); // 右侧等宽时间(83 天前回落绝对日期)
    } finally {
      await unmount(view);
    }
  });

  it("orders by recency with pin → favorites lifted, and keeps inline pin/favorite affordances", async () => {
    const later = makeTask({ taskId: "task-later", title: "Later", lastKnownAt: "2026-07-01T00:00:00.000Z" });
    const pinned = makeTask({
      taskId: "task-pinned",
      title: "Pinned today",
      lastKnownAt: "2026-06-01T00:00:00.000Z",
      pinned: true,
    });
    const favorite = makeTask({ taskId: "task-favorite", title: "Favorite", lastKnownAt: "2026-07-05T00:00:00.000Z" });
    const view = await mountList([later, pinned, favorite], {
      favorites: new Set(["task-favorite"]),
      onSetPin: noop,
    });
    try {
      expect(rowOrder(view)).toEqual(["task-pinned", "task-favorite", "task-later"]);
      expect(view.html()).toContain('data-testid="task-pin-toggle-task-pinned"');
      const shell = view.container.querySelector('[data-testid="task-row-task-pinned"]') as HTMLElement;
      expect(shell.querySelector("button[title='Remove pin']")).not.toBeNull(); // pinned 行的写通道按钮
    } finally {
      await unmount(view);
    }
  });

  it("keeps pinned state read-only when no pin write channel is wired", async () => {
    const pinned = makeTask({ taskId: "task-pinned", title: "Pinned", pinned: true });
    const view = await mountList([pinned], { onSetPin: undefined });
    try {
      expect(view.html()).toContain('data-testid="task-pinned-marker-task-pinned"');
      expect(view.html()).not.toContain("task-pin-toggle-");
    } finally {
      await unmount(view);
    }
  });
});

describe("terminal sink (标准 §1.4/§2.4 v2)", () => {
  const fixture = (): TaskRow[] => [
    makeTask({ taskId: "t_open", title: "Still moving", coordinationStatus: "active" }),
    makeTask({ taskId: "t_done", title: "Recently done", coordinationStatus: "done" }),
    makeTask({ taskId: "t_cancelled", title: "Cancelled work", coordinationStatus: "cancelled" }),
    makeTask({
      taskId: "t_pinned_done",
      title: "Pinned done",
      coordinationStatus: "done",
      pinned: true,
    }),
  ];

  it("sinks terminal rows behind one 已完成/已取消 divider and keeps them visible", async () => {
    const view = await mountList(fixture());
    try {
      // v2(标准 §1.8):终态行不折叠进「展开」——分隔线计数如实,行照常渲染。
      const divider = view.container.querySelector('[data-testid="list-terminal-divider"]')!;
      expect(divider.textContent).toContain("1 completed"); // pinned 终态行不在分隔线后
      expect(divider.textContent).toContain("1 cancelled");
      expect(view.html()).toContain("Recently done");
      expect(view.html()).toContain("Cancelled work");
      // 开放行与 pinned 终态行在前,终态行沉底(§2.4)。
      expect(rowOrder(view)).toEqual(["t_pinned_done", "t_open", "t_done", "t_cancelled"]);
    } finally {
      await unmount(view);
    }
  });
});

describe("activation and empty state", () => {
  it("routes shell click and Enter through onSelect; inline buttons do not select", async () => {
    const selected: string[] = [];
    const favorites: string[] = [];
    const pins: Array<[string, boolean]> = [];
    const view = await mountList([makeTask({ taskId: "task_x", title: "Alpha" })], {
      onSelect: (id) => selected.push(id),
      onToggleFavorite: (id) => favorites.push(id),
      onSetPin: (task, pinned) => pins.push([task.taskId, pinned]),
    });
    try {
      const shell = view.container.querySelector<HTMLElement>('[data-testid="task-row-task_x"]')!;
      act(() => {
        shell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      act(() => {
        shell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      expect(selected).toEqual(["task_x", "task_x"]);
      const pin = view.container.querySelector<HTMLButtonElement>('[data-testid="task-pin-toggle-task_x"]')!;
      const favorite = [...view.container.querySelectorAll("button")].find(
        (button) => button.getAttribute("title") === "Favorites (pinned)",
      ) as HTMLButtonElement;
      act(() => {
        pin.click();
        favorite.click();
      });
      expect(pins).toEqual([["task_x", true]]);
      expect(favorites).toEqual(["task_x"]);
      expect(selected).toEqual(["task_x", "task_x"]); // 行内按钮不连带选行。
    } finally {
      await unmount(view);
    }
  });

  it("empty state is one line of text — no dashed box, no table, no pager, no column handles", async () => {
    const view = await mountList([]);
    try {
      expect(view.container.textContent).toContain("No matching tasks");
      expect(view.html()).not.toContain("border-dashed");
      expect(view.html()).not.toContain("<table");
      expect(view.html()).not.toContain("list-column-resize-");
      expect(view.html()).not.toContain("Previous page");
      expect(view.html()).not.toContain('type="checkbox"');
      expect(view.html()).not.toContain("list-terminal-divider"); // 没有终态就没有分隔线。
    } finally {
      await unmount(view);
    }
  });
});

describe("in-place collaboration hint (task_1bafbf09 rework)", () => {
  it("appends compact assignee/holder segments after the task id from structural fields", async () => {
    const view = await mountList([
      makeTask({
        taskId: "task_fleet",
        title: "Fleet task",
        assignment: {
          assignee: { kind: "person", personId: "person_ada", nodeId: "edge-alpha" },
          expiresAt: "2026-10-02T00:00:00.000Z",
        },
        leaseActor: { principal: { personId: "person_bo" }, executor: null },
        leaseSource: { kind: "node", nodeId: "edge-beta" },
        leasePhase: "held",
        leaseExpiresAt: "2026-10-05T00:00:00.000Z",
      }),
    ]);
    try {
      const row = view.container.querySelector('[data-testid="task-row-task_fleet"]')!;
      expect(row.textContent).toContain("task_fleet");
      expect(row.textContent).toContain("Assigned person_ada@edge-alpha");
      expect(row.textContent).toContain("Executing person_bo@edge-beta");
    } finally {
      await unmount(view);
    }
  });

  it("keeps the bare id when the task has no assignment and no lease", async () => {
    const view = await mountList([makeTask({ taskId: "task_bare", title: "Bare" })]);
    try {
      const row = view.container.querySelector('[data-testid="task-row-task_bare"]')!;
      expect(row.textContent).toContain("task_bare");
      expect(row.textContent).not.toContain("Assigned");
      expect(row.textContent).not.toContain("Executing");
      // 原始机器串在 DenseRow 的悬停全文上(hoverTitle)
      expect(row.querySelector("[data-dense-row]")!.getAttribute("title")).toBe("task_bare");
    } finally {
      await unmount(view);
    }
  });
});
