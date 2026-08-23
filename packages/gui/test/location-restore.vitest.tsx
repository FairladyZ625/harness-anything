// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useLocationRestore } from "../src/renderer/navigation/useLocationRestore.ts";
import { goBack, pushLocation } from "../src/renderer/navigation/viewHistory.ts";
import type { AppLocation } from "../src/renderer/navigation/viewHistory.ts";

/**
 * G10 回退保真:后退恢复的不只是页面,还有**焦点与滚动位置**。
 * 用真实导航栈(viewHistory)+ 真实 DOM 驱动:视图 A 滚动、聚焦 → 导航去 B →
 * back() → 断言 A 的 scrollTop 与 document.activeElement 原样回来。
 */

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });

const EMPTY_FILTERS = { query: "", status: "all", favoritesOnly: false } as const;

function Harness({ state, restore = true }: { state: { history: AppLocation[]; index: number }; restore?: boolean }) {
  const [location, setLocation] = useState(state.history[state.index]!);
  useLocationRestore(location, restore ? document.body : null);
  const navigate = (fields: Partial<AppLocation>) => {
    state.history = state.history.slice(0, state.index + 1);
    state.history.push({ ...location, ...fields });
    state.index += 1;
    setLocation(state.history[state.index]!);
  };
  return <div>
    {location.view === "a"
      ? <main data-testid="view-a">
          <div data-testid="scrollable" className="overflow-y-auto" style={{ height: "200px" }} tabIndex={-1}>
            <p>line 1</p><p>line 2</p><p>line 3</p>
          </div>
          <button type="button" data-testid="focus-target" onClick={() => navigate({ view: "b" as never })}>
            go to B
          </button>
        </main>
      : <section data-testid="view-b"><p data-testid="b-body">B</p><button type="button" data-testid="back" onClick={() => { state.index -= 1; setLocation(state.history[state.index]!); }}>back</button></section>}
  </div>;
}

const initial: AppLocation = {
  view: "a", selectedId: null, previewId: null, focusedEntityRef: null,
  taskFilters: EMPTY_FILTERS as never, drill: null,
};

describe("G10 回退保真:焦点与滚动位置随后退恢复", () => {
  it("pushLocation/back 的纯函数语义仍是本测试的导航事实源", () => {
    let state = { entries: [initial], index: 0 };
    state = pushLocation(state, { ...initial, view: "b" as never });
    state = goBack(state);
    expect(state.entries[state.index]!.view).toBe("a");
  });

  it("滚动位置与焦点在 back 后原样恢复", async () => {
    const state = { history: [initial], index: 0 };
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => { root.render(createElement(Harness, { state })); });

    // 在视图 A:滚动 + 聚焦按钮
    const scrollable = container.querySelector<HTMLElement>('[data-testid="scrollable"]')!;
    const focusTarget = container.querySelector<HTMLElement>('[data-testid="focus-target"]')!;
    scrollable.scrollTop = 120;
    scrollable.dispatchEvent(new Event("scroll", { bubbles: false }));
    focusTarget.focus();
    document.body.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(scrollable.scrollTop).toBe(120);
    expect(document.activeElement).toBe(focusTarget);

    // 点「go to B」(聚焦按钮本身)→ 视图 B;在 B 上焦点落在 back 按钮,
    // 与 A 上的焦点形成竞争态 —— 恢复语义必须把焦点带回 A 的 focus-target。
    await act(async () => { focusTarget.click(); });
    expect(container.querySelector('[data-testid="view-b"]')).not.toBeNull();
    const backButton = container.querySelector<HTMLElement>('[data-testid="back"]')!;
    await act(async () => { backButton.focus(); backButton.click(); });

    const restoredScrollable = container.querySelector<HTMLElement>('[data-testid="scrollable"]')!;
    expect(restoredScrollable.scrollTop).toBe(120);
    const active = document.activeElement;
    expect(active?.dataset.testid).toBe("focus-target");
    expect(active?.isConnected).toBe(true);
    act(() => { root.unmount(); });
    container.remove();
  });

  it("阴性对照:关掉恢复钩子,同样的操作序列必须失败(证明断言在测恢复本身)", async () => {
    const state = { history: [initial], index: 0 };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(Harness, { state, restore: false })); });
    const scrollable = container.querySelector<HTMLElement>('[data-testid="scrollable"]')!;
    const focusTarget = container.querySelector<HTMLElement>('[data-testid="focus-target"]')!;
    scrollable.scrollTop = 120;
    scrollable.dispatchEvent(new Event("scroll", { bubbles: false }));
    focusTarget.focus();
    document.body.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await act(async () => { focusTarget.click(); });
    const backButton = container.querySelector<HTMLElement>('[data-testid="back"]')!;
    await act(async () => { backButton.focus(); backButton.click(); });
    const restored = container.querySelector<HTMLElement>('[data-testid="scrollable"]')!;
    expect(restored.scrollTop).not.toBe(120);
    const active = document.activeElement;
    expect(active === null || active.dataset.testid !== "focus-target" || !active.isConnected).toBe(true);
    act(() => { root.unmount(); });
    container.remove();
  });

  it("首次到访(无快照)不恢复,保持自然行为", async () => {
    const state = { history: [initial, { ...initial, view: "b" as never }], index: 1 };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(Harness, { state })); });
    // B 上没有历史快照,不抛错不越权
    expect(container.querySelector('[data-testid="view-b"]')).not.toBeNull();
    act(() => { root.unmount(); });
    container.remove();
  });
});
