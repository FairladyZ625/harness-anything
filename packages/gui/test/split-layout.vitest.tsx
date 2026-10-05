// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ColumnResizeHandle } from "../src/renderer/components/ColumnResizeHandle.tsx";
import {
  readSplitPreferences,
  setSplitSlot,
  writeSplitPreferences,
  type SplitSlotMap,
} from "../src/renderer/split-layout-preferences.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 页面区域停靠分屏(task_033760e2…)的存储层与键盘分隔手柄:布局树快照按连接+仓+页面槽
 * 落 localStorage(同 repoId 换连接不串用、上限裁剪、旧 schema 作废);ColumnResizeHandle
 * 是看板列宽仍在用的共享手柄,横/竖两向的键盘与指针路径在这里守。停靠交互本身见
 * page-regions.vitest。
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

/** 一棵最小的 dockview 快照,只要求是可存的记录;结构本身由 dockview 负责。 */
const grid = (marker: string) => ({ root: { type: "branch", data: [], marker } });
// 存储字段名是 snapshot;grid() 只造快照内容。

describe("split layout preferences storage", () => {
  it("round-trips per connection, repo and slot", () => {
    const storage = new MemoryStorage();
    writeSplitPreferences(storage, "local", "repo-a", { docs: { snapshot: grid("a") } });
    writeSplitPreferences(storage, "local", "repo-b", { docs: { snapshot: grid("b") } });
    expect(readSplitPreferences(storage, "local", "repo-a").docs).toEqual({ snapshot: grid("a") });
    expect(readSplitPreferences(storage, "local", "repo-b").docs).toEqual({ snapshot: grid("b") });
    // 跨连接/跨仓不串用:repo-c 与别的连接都读到空。
    expect(readSplitPreferences(storage, "local", "repo-c")).toEqual({});
    expect(readSplitPreferences(storage, "remote-abc123def456", "repo-a")).toEqual({});
  });

  it("keeps same-repo preferences of two connections apart through writes and resets", () => {
    const storage = new MemoryStorage();
    // registry 允许 remote-proxy 仓改挂连接:同 repoId 先后在两个连接下使用。
    writeSplitPreferences(storage, "conn-a", "repo-x", { docs: { snapshot: grid("a") } });
    // 另一连接写同 repoId:互不覆盖。
    writeSplitPreferences(storage, "conn-b", "repo-x", { docs: { snapshot: grid("b") } });
    expect(readSplitPreferences(storage, "conn-a", "repo-x").docs).toEqual({ snapshot: grid("a") });
    expect(readSplitPreferences(storage, "conn-b", "repo-x").docs).toEqual({ snapshot: grid("b") });
    // 重置(清槽)只影响当前连接:conn-b 清空,conn-a 原样。
    writeSplitPreferences(
      storage,
      "conn-b",
      "repo-x",
      setSplitSlot(readSplitPreferences(storage, "conn-b", "repo-x"), "docs", { snapshot: {} }),
    );
    expect(readSplitPreferences(storage, "conn-b", "repo-x")).toEqual({});
    expect(readSplitPreferences(storage, "conn-a", "repo-x").docs).toEqual({ snapshot: grid("a") });
  });

  it("falls back to empty on garbage, foreign schema or malformed slots instead of throwing", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "not json");
    expect(readSplitPreferences(storage, "local", "repo-a")).toEqual({});
    // v2 是 swap 排列时代的旧 schema:作废不迁移,不把旧仓槽并进任何连接。
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schema: "split-layout/v2",
        connections: { local: { "repo-a": { docs: { orientation: "row", ratio: 0.4 } } } },
      }),
    );
    expect(readSplitPreferences(storage, "local", "repo-a")).toEqual({});
    // 写入时把旧 schema 视为空,不沿用其槽位。
    writeSplitPreferences(storage, "local", "repo-a", { docs: { snapshot: grid("fresh") } });
    expect(readSplitPreferences(storage, "local", "repo-a").docs).toEqual({ snapshot: grid("fresh") });
    // grid 不是记录的槽位被丢弃,不落半截偏好。
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schema: "split-layout/v3",
        connections: { local: { "repo-a": { docs: { snapshot: 7 } } } },
      }),
    );
    expect(readSplitPreferences(storage, "local", "repo-a")).toEqual({});
  });

  it("clears a slot with an empty grid and prunes the oldest connection+repo slots past the cap", () => {
    const storage = new MemoryStorage();
    let slots: SplitSlotMap = { docs: { snapshot: grid("keep") } };
    slots = setSplitSlot(slots, "docs", { snapshot: {} });
    expect(slots).toEqual({});
    for (let index = 0; index < 10; index += 1)
      writeSplitPreferences(storage, "local", `repo-${index}`, { docs: { snapshot: grid(`r${index}`) } });
    // 上限 8 个连接+仓槽,最旧的 repo-0/repo-1 被丢,最近的仍在。
    expect(readSplitPreferences(storage, "local", "repo-0")).toEqual({});
    expect(readSplitPreferences(storage, "local", "repo-1")).toEqual({});
    expect(readSplitPreferences(storage, "local", "repo-9").docs).toEqual({ snapshot: grid("r9") });
    // 上限按全局首次写入顺序裁剪:新连接的仓槽挤掉最旧连接的仓槽。
    writeSplitPreferences(storage, "remote-abc123def456", "repo-9", { docs: { snapshot: grid("remote") } });
    expect(readSplitPreferences(storage, "local", "repo-2")).toEqual({});
    expect(readSplitPreferences(storage, "local", "repo-3").docs).toEqual({ snapshot: grid("r3") });
    expect(readSplitPreferences(storage, "remote-abc123def456", "repo-9").docs).toEqual({ snapshot: grid("remote") });
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
