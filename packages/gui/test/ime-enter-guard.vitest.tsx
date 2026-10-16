// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement, type ReactElement } from "react";
import { CommandPalette, type PaletteEntry } from "../src/renderer/components/CommandPalette.tsx";
import { FocusSwitcher } from "../src/renderer/components/FocusSwitcher.tsx";
import { TerminalTaskTreePicker } from "../src/renderer/components/terminal/TerminalTaskTreePicker.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * IME 组字期间 Enter 不触发动作:三条文本输入接入点(命令面板 / 焦点切换器 /
 * task 绑定选择器)共用 primitives/ime-composition 的守卫。三腿分别模拟各浏览器形态:
 *   - isComposing: true——Chromium 组字中的 keydown,含提交组字的那次 Enter;
 *   - keyCode: 229——WebKit 在 compositionend 之后才派发 keydown;
 *   - compositionstart..end 会话状态——事件本身不带组字标记的浏览器。
 * 正例:组字结束后 Enter 照常触发动作。负例(去掉守卫后本文件变红)见任务
 * closeout 的证据贴文。
 */
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
afterEach(() => {
  document.body.innerHTML = "";
});

function mount(element: ReactElement): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, root };
}

function enter(target: Element, init: KeyboardEventInit = {}) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init }));
  });
}
const composingEnterWith229 = (target: Element) =>
  enter(target, { isComposing: false, keyCode: 229 } as KeyboardEventInit);
function compositionStart(target: Element) {
  act(() => target.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
}
function compositionEnd(target: Element) {
  act(() => target.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
}

describe("CommandPalette:组字中的 Enter 只上屏,不跳转", () => {
  const entries: PaletteEntry[] = [
    { ref: "task/t1", label: "任务一", entity: "task" },
    { ref: "task/t2", label: "任务二", entity: "task" },
  ];

  function mountPalette(actions: { selected: string[]; closed: string[] }) {
    const { host } = mount(
      createElement(CommandPalette, {
        open: true,
        entries,
        onSelect: (ref: string) => actions.selected.push(ref),
        onClose: () => actions.closed.push("close"),
      }),
    );
    return host.querySelector("input")!;
  }

  it("isComposing 腿:动作不触发;组字外 Enter 照常跳转", () => {
    const actions = { selected: [] as string[], closed: [] as string[] };
    const input = mountPalette(actions);
    enter(input, { isComposing: true });
    expect(actions.selected).toEqual([]);
    expect(actions.closed).toEqual([]);
    enter(input);
    expect(actions.selected).toEqual(["task/t1"]);
    expect(actions.closed).toEqual(["close"]);
  });

  it("keyCode 229 腿:动作不触发", () => {
    const actions = { selected: [] as string[], closed: [] as string[] };
    const input = mountPalette(actions);
    composingEnterWith229(input);
    expect(actions.selected).toEqual([]);
    expect(actions.closed).toEqual([]);
    enter(input);
    expect(actions.selected).toEqual(["task/t1"]);
  });

  it("会话状态腿:compositionstart 后 Enter 不触发,compositionend 后恢复", () => {
    const actions = { selected: [] as string[], closed: [] as string[] };
    const input = mountPalette(actions);
    compositionStart(input);
    enter(input);
    expect(actions.selected).toEqual([]);
    compositionEnd(input);
    enter(input);
    expect(actions.selected).toEqual(["task/t1"]);
  });

  it("组字中的 ArrowDown 归输入法:高亮不动,结束后 Enter 仍选第一条", () => {
    const actions = { selected: [] as string[], closed: [] as string[] };
    const input = mountPalette(actions);
    compositionStart(input);
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    compositionEnd(input);
    enter(input);
    expect(actions.selected).toEqual(["task/t1"]);
  });

  // 生命周期回归:App 常驻挂载本组件、用 open prop 开关,守卫 hook 若挂在
  // if (!open) return null 之后,首次开关即触发 React「hooks 数量变化」崩溃。
  it("open false→true→false→true:渲染不报错,重开后组字中 Enter 不跳转、组字外照常", () => {
    const actions = { selected: [] as string[], closed: [] as string[] };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (open: boolean) =>
      act(() =>
        root.render(
          createElement(CommandPalette, {
            open,
            entries,
            onSelect: (ref: string) => actions.selected.push(ref),
            onClose: () => actions.closed.push("close"),
          }),
        ),
      );

    render(false);
    expect(host.querySelector('[data-testid="command-palette"]')).toBeNull();
    render(true);
    expect(host.querySelector('[data-testid="command-palette"]')).not.toBeNull();
    render(false);
    expect(host.querySelector('[data-testid="command-palette"]')).toBeNull();
    render(true);
    expect(host.querySelector('[data-testid="command-palette"]')).not.toBeNull();

    const input = host.querySelector("input")!;
    compositionStart(input);
    enter(input);
    expect(actions.selected).toEqual([]);
    compositionEnd(input);
    enter(input);
    expect(actions.selected).toEqual(["task/t1"]);
    act(() => root.unmount());
  });
});

describe("FocusSwitcher:组字中的 Enter 不切换焦点", () => {
  const entries: PaletteEntry[] = [
    { ref: "task/t1", label: "任务一", entity: "task" },
    { ref: "task/t2", label: "任务二", entity: "task" },
  ];

  function mountSwitcher(focused: string[]) {
    const { host } = mount(
      createElement(FocusSwitcher, {
        recentRefs: ["task/t1", "task/t2"],
        entries,
        focusRef: null,
        onFocus: (ref: string) => focused.push(ref),
        onOpenPalette: () => {},
      }),
    );
    return host.querySelector<HTMLInputElement>('[data-testid="focus-switcher-input"]')!;
  }

  it("isComposing 腿:不切焦点;组字外 Enter 照常切换", () => {
    const focused: string[] = [];
    const input = mountSwitcher(focused);
    enter(input, { isComposing: true });
    expect(focused).toEqual([]);
    enter(input);
    expect(focused).toEqual(["task/t1"]);
  });

  it("keyCode 229 腿:不切焦点", () => {
    const focused: string[] = [];
    const input = mountSwitcher(focused);
    composingEnterWith229(input);
    expect(focused).toEqual([]);
    enter(input);
    expect(focused).toEqual(["task/t1"]);
  });

  it("会话状态腿:start 后不切,end 后恢复", () => {
    const focused: string[] = [];
    const input = mountSwitcher(focused);
    compositionStart(input);
    enter(input);
    expect(focused).toEqual([]);
    compositionEnd(input);
    enter(input);
    expect(focused).toEqual(["task/t1"]);
  });
});

describe("TerminalTaskTreePicker:组字中的 Enter 不绑定任务", () => {
  const tasks = [
    { taskId: "t1", title: "任务一" },
    { taskId: "t2", title: "任务二", parentTaskId: "t1" },
  ];

  function mountPicker(picked: string[]) {
    const { host } = mount(
      createElement(TerminalTaskTreePicker, { tasks, value: "", onChange: (id: string) => picked.push(id) }),
    );
    act(() => {
      host
        .querySelector<HTMLButtonElement>('[data-testid="terminal-task-tree"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 面板 portal 到 body;keydown 从搜索框冒泡进容器守卫。
    return document.querySelector<HTMLInputElement>('[data-testid="terminal-task-tree-search"]')!;
  }

  it("isComposing 腿:不绑定;组字外 Enter 照常绑定", () => {
    const picked: string[] = [];
    const search = mountPicker(picked);
    enter(search, { isComposing: true });
    expect(picked).toEqual([]);
    enter(search);
    expect(picked).toEqual(["t1"]);
  });

  it("keyCode 229 腿:不绑定", () => {
    const picked: string[] = [];
    const search = mountPicker(picked);
    composingEnterWith229(search);
    expect(picked).toEqual([]);
    enter(search);
    expect(picked).toEqual(["t1"]);
  });

  it("会话状态腿:start 后不绑定,end 后恢复", () => {
    const picked: string[] = [];
    const search = mountPicker(picked);
    compositionStart(search);
    enter(search);
    expect(picked).toEqual([]);
    compositionEnd(search);
    enter(search);
    expect(picked).toEqual(["t1"]);
  });
});
