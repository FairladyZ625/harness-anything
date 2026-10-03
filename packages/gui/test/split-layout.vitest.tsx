// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ColumnResizeHandle } from "../src/renderer/components/ColumnResizeHandle.tsx";
import {
  SPLIT_GUTTER_PX,
  SplitDivider,
  SplitExpandStrip,
  SplitLayoutControls,
  collapsedGridTemplate,
  splitGridTemplate,
  useSplitLayout,
} from "../src/renderer/components/primitives/split-layout.tsx";
import {
  readSplitPreferences,
  setSplitSlot,
  writeSplitPreferences,
  type SplitSlotMap,
} from "../src/renderer/split-layout-preferences.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 原页面内容区域可调布局(task_fb3ba20d66…):共享分割模块(hook + 分隔条 + 控件组)、
 * 手柄的横/竖两向键盘路径、偏好按仓+页面槽的持久化。happy-dom 无布局引擎:容器尺寸经
 * prototype getter 注入,比例换算按注入尺寸断言;真实几何由 Electron 场景留证。
 */

const STORAGE_KEY = "harness:gui:split-layout";

class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

let root: Root | null = null;
let host: HTMLDivElement;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host.remove();
  localStorage.removeItem(STORAGE_KEY);
});

/** 注入容器实测尺寸(happy-dom 无布局,clientWidth/Height 恒 0)。 */
function injectElementSize(width: number, height: number): () => void {
  const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")!;
  const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")!;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => height });
  return () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", widthDescriptor);
    Object.defineProperty(HTMLElement.prototype, "clientHeight", heightDescriptor);
  };
}

interface Probe {
  readonly repoId: string;
  readonly slot: string;
  readonly minRatio: number;
  readonly maxRatio: number;
  readonly autoBreakpoint: number;
  readonly collapsible: boolean;
  readonly onSplit: (split: ReturnType<typeof useSplitLayout>) => void;
}

/** 把 hook 状态拉出 React 树的探针;containerRef 挂在真实 div 上(量尺寸)。 */
function SplitProbe({ repoId, slot, minRatio, maxRatio, autoBreakpoint, collapsible, onSplit }: Probe) {
  const split = useSplitLayout({
    repoId,
    slot,
    minRatio,
    maxRatio,
    defaultRatioRow: 0.25,
    defaultRatioColumn: 0.4,
    autoBreakpoint,
    collapsible,
  });
  onSplit(split);
  return createElement("div", { ref: split.containerRef, "data-testid": "probe-container" });
}

async function mountProbe(overrides: Partial<Probe> = {}) {
  const seen: ReturnType<typeof useSplitLayout>[] = [];
  const probe: Probe = {
    repoId: "repo-a",
    slot: "test-split",
    minRatio: 0.2,
    maxRatio: 0.7,
    autoBreakpoint: 1000,
    collapsible: true,
    onSplit: (split) => seen.push(split),
    ...overrides,
  };
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(SplitProbe, probe));
  });
  return { seen, latest: () => seen.at(-1)! };
}

describe("split layout preferences storage", () => {
  it("round-trips per repo and slot, clamping stale ratios into the sanity range", () => {
    const storage = new MemoryStorage();
    writeSplitPreferences(storage, "repo-a", { docs: { orientation: "row", ratio: 5, collapsed: true } });
    writeSplitPreferences(storage, "repo-b", { docs: { orientation: "column" } });
    const repoA = readSplitPreferences(storage, "repo-a");
    expect(repoA.docs).toEqual({ orientation: "row", ratio: 0.9, collapsed: true });
    expect(readSplitPreferences(storage, "repo-b").docs).toEqual({ orientation: "column" });
    // 跨仓不串用:repo-c 读到空。
    expect(readSplitPreferences(storage, "repo-c")).toEqual({});
  });

  it("falls back to empty on garbage or foreign schema instead of throwing", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "not json");
    expect(readSplitPreferences(storage, "repo-a")).toEqual({});
    storage.setItem(STORAGE_KEY, JSON.stringify({ schema: "split-layout/v0", repos: { "repo-a": { docs: {} } } }));
    expect(readSplitPreferences(storage, "repo-a")).toEqual({});
    // 写入时把旧 schema 视为空,不沿用其槽位。
    writeSplitPreferences(storage, "repo-a", { docs: { orientation: "row" } });
    expect(readSplitPreferences(storage, "repo-a").docs).toEqual({ orientation: "row" });
  });

  it("clears a slot with an empty preference and prunes the oldest repositories past the cap", () => {
    const storage = new MemoryStorage();
    let slots: SplitSlotMap = { docs: { orientation: "row" } };
    slots = setSplitSlot(slots, "docs", {});
    expect(slots).toEqual({});
    for (let index = 0; index < 10; index += 1)
      writeSplitPreferences(storage, `repo-${index}`, { docs: { ratio: 0.3 } });
    // 上限 8 个仓,最旧的 repo-0/repo-1 被丢,最近的仍在。
    expect(readSplitPreferences(storage, "repo-0")).toEqual({});
    expect(readSplitPreferences(storage, "repo-1")).toEqual({});
    expect(readSplitPreferences(storage, "repo-9").docs).toEqual({ ratio: 0.3 });
  });
});

describe("useSplitLayout", () => {
  it("stays auto with no preference and resolves the effective orientation from the measured container", async () => {
    const restore = injectElementSize(1200, 800);
    try {
      const { latest } = await mountProbe();
      const split = latest();
      expect(split.mode).toBe("auto");
      expect(split.effectiveOrientation).toBe("row");
      expect(split.ratio).toBe(0.25);
      expect(split.collapsed).toBe(false);
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    } finally {
      restore();
    }
  });

  it("ignores drag intent while the container has no measurable size instead of writing a ratio", async () => {
    // happy-dom 不做布局:clientWidth/Height 恒 0,splittable=0。
    const { latest } = await mountProbe();
    expect(latest().effectiveOrientation).toBe("column");
    latest().dividerProps.onPanePxChange(300);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("persists explicit orientation, clamped ratio and collapse, and reads them back on remount", async () => {
    const restore = injectElementSize(1106, 700);
    try {
      const { latest } = await mountProbe();
      await act(async () => {
        latest().controlsProps.onOrientation("row");
      });
      expect(latest().mode).toBe("row");
      // 拖动换算:首窗 500px / (1106-6) → 夹在 [0.2,0.7]。
      await act(async () => {
        latest().dividerProps.onPanePxChange(500);
      });
      expect(latest().ratio).toBeCloseTo(500 / (1106 - SPLIT_GUTTER_PX), 5);
      await act(async () => {
        latest().dividerProps.onPanePxChange(99999);
      });
      expect(latest().ratio).toBe(0.7);
      await act(async () => {
        latest().controlsProps.onToggleCollapse();
      });
      expect(latest().collapsed).toBe(true);
      expect(readSplitPreferences(localStorage, "repo-a")["test-split"]).toEqual({
        orientation: "row",
        ratio: 0.7,
        collapsed: true,
      });
      // 重新挂载读回同一偏好(刷新记忆)。
      const second = await mountProbe();
      expect(second.latest().mode).toBe("row");
      expect(second.latest().ratio).toBe(0.7);
      expect(second.latest().collapsed).toBe(true);
      // 重置清槽回自适应。
      await act(async () => {
        second.latest().controlsProps.onReset();
      });
      expect(second.latest().mode).toBe("auto");
      expect(readSplitPreferences(localStorage, "repo-a")).toEqual({});
    } finally {
      restore();
    }
  });

  it("re-reads preferences when the repo changes so connections do not share arrangements", async () => {
    const restore = injectElementSize(1200, 800);
    try {
      writeSplitPreferences(localStorage, "repo-b", { "test-split": { orientation: "column", ratio: 0.5 } });
      const probe: Partial<Probe> = { repoId: "repo-a" };
      const first = await mountProbe(probe);
      expect(first.latest().mode).toBe("auto");
      await act(async () => {
        root!.render(
          createElement(SplitProbe, {
            repoId: "repo-b",
            slot: "test-split",
            minRatio: 0.2,
            maxRatio: 0.7,
            autoBreakpoint: 1000,
            collapsible: true,
            onSplit: (split) => first.seen.push(split),
          }),
        );
      });
      const switched = first.latest();
      expect(switched.mode).toBe("column");
      expect(switched.ratio).toBe(0.5);
    } finally {
      restore();
    }
  });
});

describe("grid templates", () => {
  it("allocates the first pane, the shared gutter track and the remainder", () => {
    const row = splitGridTemplate("row", 0.3);
    expect(row.gridTemplateColumns).toBe(`minmax(0,30.00fr) ${SPLIT_GUTTER_PX}px minmax(0,70.00fr)`);
    expect(row.gridTemplateRows).toBe("minmax(0,1fr)");
    const column = splitGridTemplate("column", 0.55);
    expect(column.gridTemplateRows).toBe(`minmax(0,55.00fr) ${SPLIT_GUTTER_PX}px minmax(0,45.00fr)`);
    expect(column.gridTemplateColumns).toBe("minmax(0,1fr)");
    expect(collapsedGridTemplate("row").gridTemplateColumns).toBe("1.5rem minmax(0,1fr)");
  });
});

describe("SplitDivider and SplitExpandStrip", () => {
  it("renders a keyboard-reachable separator oriented to the layout direction", async () => {
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(
          "div",
          { className: "relative grid" },
          createElement(SplitDivider, {
            orientation: "row",
            panePx: 300,
            minPx: 120,
            maxPx: 720,
            onPanePxChange: () => undefined,
            onReset: () => undefined,
            label: "调整任务文件与正文的分隔",
            testId: "divider",
          }),
        ),
      );
    });
    const handle = host.querySelector<HTMLElement>('[data-testid="divider"]')!;
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    expect(handle.title).toContain("拖拽调宽");
    expect(handle.title).toContain("双击恢复默认");
    const track = host.querySelector<HTMLElement>('[data-testid="divider-track"]')!;
    expect(track.className).toContain("w-[0.375rem]");

    await act(async () => {
      root!.render(
        createElement(
          "div",
          { className: "relative grid" },
          createElement(SplitDivider, {
            orientation: "column",
            panePx: 260,
            minPx: 100,
            maxPx: 700,
            onPanePxChange: () => undefined,
            onReset: () => undefined,
            label: "上下分隔",
            testId: "divider-h",
          }),
        ),
      );
    });
    const horizontal = host.querySelector<HTMLElement>('[data-testid="divider-h"]')!;
    expect(horizontal.getAttribute("aria-orientation")).toBe("horizontal");
    expect(horizontal.title).toContain("拖拽调高");
    expect(host.querySelector<HTMLElement>('[data-testid="divider-h-track"]')!.className).toContain("h-[0.375rem]");
  });

  it("exposes the collapsed strip as a labelled expand button", async () => {
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(SplitExpandStrip, {
          orientation: "row",
          onExpand: () => undefined,
          label: "展开文件树",
          testId: "expand",
        }),
      );
    });
    const button = host.querySelector<HTMLButtonElement>('[data-testid="expand"]')!;
    expect(button.getAttribute("aria-label")).toBe("展开文件树");
    expect(button.className).toContain("size-6");
  });
});

describe("SplitLayoutControls", () => {
  async function mountControls(props: Partial<Parameters<typeof SplitLayoutControls>[0]> = {}) {
    const rendered = createElement(SplitLayoutControls, {
      mode: "auto",
      collapsed: false,
      collapsible: true,
      onOrientation: () => undefined,
      onToggleCollapse: () => undefined,
      onReset: () => undefined,
      testId: "controls",
      ...props,
    });
    root = createRoot(host);
    await act(async () => {
      root!.render(rendered);
    });
    return host.querySelector<HTMLElement>('[data-testid="controls"]')!;
  }

  it("marks the active arrangement with aria-pressed and names every icon-only button", async () => {
    const group = await mountControls({ mode: "row" });
    const row = group.querySelector<HTMLButtonElement>('[data-testid="controls-row"]')!;
    const column = group.querySelector<HTMLButtonElement>('[data-testid="controls-column"]')!;
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(column.getAttribute("aria-pressed")).toBe("false");
    expect(row.getAttribute("aria-label")).toBe("左右排列");
    expect(column.getAttribute("aria-label")).toBe("上下排列");
    expect(group.querySelector('[data-testid="controls-reset"]')!.getAttribute("aria-label")).toBe("恢复默认布局");
    expect(group.getAttribute("role")).toBe("group");
  });

  it("omits the collapse button when the consumer does not offer collapsing", async () => {
    const group = await mountControls({ collapsible: false });
    expect(group.querySelector('[data-testid="controls-collapse"]')).toBeNull();
    const collapsible = await mountControls({ collapsible: true, collapsed: true });
    expect(collapsible.querySelector('[data-testid="controls-collapse"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("fires arrangement, collapse and reset intents", async () => {
    const onOrientation = vi.fn(),
      onToggleCollapse = vi.fn(),
      onReset = vi.fn();
    const group = await mountControls({ onOrientation, onToggleCollapse, onReset });
    await act(async () => {
      group.querySelector<HTMLButtonElement>('[data-testid="controls-row"]')!.click();
      group.querySelector<HTMLButtonElement>('[data-testid="controls-collapse"]')!.click();
      group.querySelector<HTMLButtonElement>('[data-testid="controls-reset"]')!.click();
    });
    expect(onOrientation).toHaveBeenCalledExactlyOnceWith("row");
    expect(onToggleCollapse).toHaveBeenCalledOnce();
    expect(onReset).toHaveBeenCalledOnce();
  });
});

describe("ColumnResizeHandle orientations", () => {
  async function mountHandle(orientation: "vertical" | "horizontal", width = 300) {
    const onChange = vi.fn();
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(
          "div",
          { className: "relative" },
          createElement(ColumnResizeHandle, {
            label: "调整分隔",
            orientation,
            width,
            min: 100,
            max: 700,
            onChange,
            onReset: () => undefined,
            testId: "handle",
          }),
        ),
      );
    });
    return { handle: host.querySelector<HTMLElement>('[data-testid="handle"]')!, onChange };
  }

  const key = (element: HTMLElement, keyName: string) =>
    act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true }));
    });

  it("keeps the vertical arrow keys for side-by-side panes", async () => {
    const { handle, onChange } = await mountHandle("vertical");
    await key(handle, "ArrowRight");
    await key(handle, "ArrowLeft");
    expect(onChange).toHaveBeenNthCalledWith(1, 316);
    expect(onChange).toHaveBeenNthCalledWith(2, 284);
  });

  it("uses up/down steps for stacked panes and clamps to the bounds", async () => {
    const { handle, onChange } = await mountHandle("horizontal");
    await key(handle, "ArrowDown");
    await key(handle, "ArrowUp");
    expect(onChange).toHaveBeenNthCalledWith(1, 316);
    // 手柄是受控的:宽度状态在调用方,第二步仍从 300 起算(-16)。
    expect(onChange).toHaveBeenNthCalledWith(2, 284);
    // 夹在 [min,max]:起点 690 再 +16 → 700。
    const nearMax = await mountHandle("horizontal", 690);
    await key(nearMax.handle, "ArrowDown");
    expect(nearMax.onChange).toHaveBeenLastCalledWith(700);
  });

  it("follows the pointer on the separator's own axis: vertical handle tracks X, horizontal tracks Y", async () => {
    // 回归:横向手柄曾只跟 clientX,上下排列拖不动比例。
    const drag = async (orientation: "vertical" | "horizontal", dx: number, dy: number) => {
      const mounted = await mountHandle(orientation);
      mounted.handle.dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, bubbles: true }),
      );
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 100 + dx, clientY: 100 + dy }));
      window.dispatchEvent(new PointerEvent("pointerup"));
      return mounted.onChange;
    };
    expect(await drag("vertical", 60, 200)).toHaveBeenLastCalledWith(360);
    expect(await drag("horizontal", 200, -50)).toHaveBeenLastCalledWith(250);
  });
});
