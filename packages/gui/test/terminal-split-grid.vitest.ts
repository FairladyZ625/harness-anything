// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { TerminalView } from "../src/renderer/views/TerminalView.tsx";

const terminalPaneMock = vi.hoisted(() => ({ onSelectionChange: null as ((text: string) => void) | null }));

// pane 内容用桩替代真 xterm:本文件测的是 pane 树(分割/关闭/序列化/每 pane 上报),
// 不是终端仿真;桩把 onFit 暴露成一次点击,才能对「每个 pane 各自上报 cols/rows」下断言。
vi.mock("../src/renderer/components/terminal/TerminalPane.tsx", () => ({
  TerminalPane: ({
    output,
    onFit,
    onSelectionChange,
  }: {
    readonly output: string;
    readonly onFit: (c: number, r: number) => void;
    readonly onSelectionChange: (text: string) => void;
  }) => {
    terminalPaneMock.onSelectionChange = onSelectionChange;
    return createElement("button", {
      "data-testid": "terminal-pane",
      "data-output": output,
      onClick: () => onFit(120, 40),
    });
  },
}));

const AT = "2026-09-01T00:00:00.000Z";
const layoutKey = "harness:gui:terminal-layout";
type Row = Record<string, unknown>;

function sessionRow(overrides: Partial<Row> = {}): Row {
  return {
    sessionId: "s-restore",
    repoId: "repo-a",
    name: "Build",
    cwd: "/repo/a",
    shellProfile: "default",
    requestedBackend: "direct-pty",
    backend: "direct-pty",
    status: "running",
    createdAt: AT,
    lastActivityAt: AT,
    exitCode: null,
    outputSeq: 2,
    durability: "daemon-process",
    warning: null,
    attachable: true,
    ...overrides,
  };
}

/** window.harness 桥 mock:spawn 会向会话表追加一行,split 才拿得到真正的新会话。 */
function stubBridge(initial: readonly Row[]) {
  const rows = [...initial];
  let spawned = 0;
  const stops = new Map<string, () => void>();
  const bridge = {
    listTerminalSessions: vi.fn(async () => ({
      schema: "terminal-session-list/v1",
      ok: true,
      repoId: "repo-a",
      daemonGeneration: 7,
      sessions: [...rows],
    })),
    spawnTerminal: vi.fn(async () => {
      spawned += 1;
      const sessionId = `s-split-${spawned}`;
      rows.push(sessionRow({ sessionId, name: `Split ${spawned}` }));
      return controlReceipt(sessionId);
    }),
    attachTerminal: vi.fn((payload: Row, onValue: (value: Row) => void) => {
      const sessionId = String(payload.sessionId);
      onValue({
        schema: "terminal-attach/v1",
        ok: true,
        sessionId,
        attachmentId: `attach-${sessionId}`,
        daemonGeneration: 7,
        status: "attached",
        replayFromSeq: 0,
        outputSeq: 2,
      });
      const stop = vi.fn();
      stops.set(sessionId, stop);
      return stop;
    }),
    sendTerminalInput: vi.fn(async () => ({ schema: "terminal-input-ack/v1", ok: true, acceptedThrough: 1 })),
    resizeTerminal: vi.fn(async (payload: Row) => controlReceipt(String(payload.sessionId))),
    detachTerminal: vi.fn(async () => ({ schema: "terminal-detach-ack/v1", ok: true, state: "detached" })),
    terminateTerminal: vi.fn(async () => controlReceipt("s-restore")),
  };
  (window as unknown as Record<string, unknown>).harness = bridge;
  return { bridge, stops };
}
function controlReceipt(sessionId: string): Row {
  return {
    schema: "terminal-control-receipt/v1",
    ok: true,
    outcome: "applied",
    operationId: `op-${sessionId}`,
    sessionId,
    daemonGeneration: 7,
    state: "running",
    error: null,
  };
}

/** dockview `toJSON()` 的真实形状:两个左右并排的 pane,载荷各带一个 sessionId。 */
function storedLayout(): Row {
  return {
    schema: "terminal-layout/v1",
    repos: {
      "repo-a": {
        activeGroupId: "group-restored",
        groups: [
          {
            groupId: "group-restored",
            seeds: [],
            grid: {
              grid: {
                root: {
                  type: "branch",
                  data: [
                    { type: "leaf", data: { views: ["pane-a"], activeView: "pane-a", id: "1" }, size: 100 },
                    { type: "leaf", data: { views: ["pane-b"], activeView: "pane-b", id: "2" }, size: 100 },
                  ],
                  size: 100,
                },
                width: 100,
                height: 100,
                orientation: "HORIZONTAL",
              },
              panels: {
                "pane-a": {
                  id: "pane-a",
                  contentComponent: "terminalPane",
                  params: { sessionId: "s-restore" },
                  title: "pane-a",
                },
                "pane-b": {
                  id: "pane-b",
                  contentComponent: "terminalPane",
                  params: { sessionId: "s-gone" },
                  title: "pane-b",
                },
              },
              activeGroup: "1",
            },
          },
        ],
      },
    },
  };
}

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // 文案断言按 aria-label 走,锁定语言避免跟随宿主 locale 漂移。
  setActiveLocale("en-US");
});
beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  delete (window as unknown as Record<string, unknown>).harness;
  vi.restoreAllMocks();
  terminalPaneMock.onSelectionChange = null;
});

function mountView() {
  container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TerminalView, {
          repoId: "repo-a",
          daemonGeneration: null,
          tasks: [],
          repoRoot: null,
          onNavigateEntity: () => undefined,
          onOpenDocument: () => undefined,
        }),
      ),
    );
  });
}
async function flush() {
  for (let round = 0; round < 8; round += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
function panes(): readonly HTMLElement[] {
  return [...container!.querySelectorAll<HTMLElement>('[data-testid="terminal-pane-card"]')];
}
function tabChips(): readonly HTMLElement[] {
  return [...container!.querySelectorAll<HTMLElement>('button[aria-label^="Close and detach "]')];
}
function clickIn(pane: HTMLElement, selector: string) {
  const button = pane.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  act(() => button!.click());
}
function storedSnapshot(): string {
  return window.localStorage.getItem(layoutKey) ?? "";
}

describe("terminal split panes (PLT-TerminalWorkspace W1)", () => {
  it("splits inside the active tab instead of opening a second tab", async () => {
    const { bridge } = stubBridge([sessionRow()]);
    mountView();
    await flush();
    expect(panes()).toHaveLength(1);
    expect(tabChips()).toHaveLength(1);

    clickIn(panes()[0], 'button[aria-label="Split right"]');
    await flush();

    // tab = group:分屏后仍然只有一个 tab,group 内变成两个 pane。
    expect(panes()).toHaveLength(2);
    expect(tabChips()).toHaveLength(1);
    expect(panes().map((pane) => pane.dataset.sessionId)).toEqual(["s-restore", "s-split-1"]);
    expect(bridge.spawnTerminal).toHaveBeenCalledTimes(1);
    expect(bridge.attachTerminal).toHaveBeenCalledWith(
      { repoId: "repo-a", sessionId: "s-split-1", afterSeq: 0 },
      expect.any(Function),
    );
  });

  // Regression: dockview's panel host (dv-react-part) is a block element, not a flex container, so a
  // `flex-1` card collapsed to content height and left the pane half-empty (a black band below).
  // `h-full` is what makes the card fill its host; guard against a revert to flex-1.
  it("sizes each pane card to fill its dockview host (h-full, not flex-1)", async () => {
    stubBridge([sessionRow()]);
    mountView();
    await flush();
    const card = panes()[0];
    expect(card.className).toContain("h-full");
    expect(card.className).not.toMatch(/(^|\s)flex-1(\s|$)/u);
  });

  it("serializes the pane tree to localStorage with each pane's session id", async () => {
    stubBridge([sessionRow()]);
    mountView();
    await flush();
    expect(storedSnapshot()).toContain('"sessionId":"s-restore"');

    clickIn(panes()[0], 'button[aria-label="Split right"]');
    await flush();

    const written: {
      schema: string;
      repos: Record<string, { groups: { grid: { panels: Record<string, { params: { sessionId: string } }> } }[] }>;
    } = JSON.parse(storedSnapshot());
    expect(written.schema).toBe("terminal-layout/v1");
    const panels = written.repos["repo-a"].groups[0].grid.panels;
    expect(
      Object.values(panels)
        .map((panel) => panel.params.sessionId)
        .sort(),
    ).toEqual(["s-restore", "s-split-1"]);
  });

  it("restores a stored pane tree, re-attaches live sessions and parks dead ones as closeable placeholders", async () => {
    window.localStorage.setItem(layoutKey, JSON.stringify(storedLayout()));
    const { bridge } = stubBridge([sessionRow()]);
    mountView();
    await flush();

    // 两个 pane 都恢复;活会话按 id re-attach,死会话只留占位,不去 attach、也不新建。
    expect(panes().map((pane) => pane.dataset.sessionId)).toEqual(["s-restore", "s-gone"]);
    expect(bridge.attachTerminal).toHaveBeenCalledTimes(1);
    expect(bridge.attachTerminal).toHaveBeenCalledWith(
      { repoId: "repo-a", sessionId: "s-restore", afterSeq: 0 },
      expect.any(Function),
    );
    expect(bridge.spawnTerminal).not.toHaveBeenCalled();
    const dead = container!.querySelectorAll('[data-testid="terminal-pane-dead"]');
    expect(dead).toHaveLength(1);
    expect(panes()[1].querySelector('[data-testid="terminal-pane-dead"]')).not.toBeNull();

    clickIn(panes()[1], '[data-testid="terminal-pane-dead"] button');
    await flush();
    expect(panes().map((pane) => pane.dataset.sessionId)).toEqual(["s-restore"]);
  });

  it("reports fit per pane on the existing resize channel", async () => {
    const { bridge } = stubBridge([sessionRow()]);
    mountView();
    await flush();
    clickIn(panes()[0], 'button[aria-label="Split right"]');
    await flush();

    for (const pane of panes()) clickIn(pane, '[data-testid="terminal-pane"]');
    await flush();
    expect(bridge.resizeTerminal).toHaveBeenCalledWith({
      repoId: "repo-a",
      sessionId: "s-restore",
      cols: 120,
      rows: 40,
    });
    expect(bridge.resizeTerminal).toHaveBeenCalledWith({
      repoId: "repo-a",
      sessionId: "s-split-1",
      cols: 120,
      rows: 40,
    });
  });

  it("closing a pane detaches only that session and closing the last one retires the tab", async () => {
    const { bridge } = stubBridge([sessionRow()]);
    mountView();
    await flush();
    clickIn(panes()[0], 'button[aria-label="Split right"]');
    await flush();

    clickIn(panes()[1], 'button[aria-label^="Close pane "]');
    await flush();
    expect(bridge.detachTerminal).toHaveBeenCalledTimes(1);
    expect(bridge.detachTerminal).toHaveBeenCalledWith({
      repoId: "repo-a",
      sessionId: "s-split-1",
      attachmentId: "attach-s-split-1",
    });
    expect(panes()).toHaveLength(1);
    expect(tabChips()).toHaveLength(1);

    clickIn(panes()[0], 'button[aria-label^="Close pane "]');
    await flush();
    expect(panes()).toHaveLength(0);
    expect(tabChips()).toHaveLength(0);
  });

  it("splits and closes the focused pane from the keyboard (Ctrl+Shift+Arrow / Ctrl+W off macOS)", async () => {
    const { bridge } = stubBridge([sessionRow()]);
    mountView();
    await flush();

    // Ctrl+Shift+→ = 向右分屏(与 useAppShortcuts 同惯例:window keydown + preventDefault)。
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, shiftKey: true }));
    });
    await flush();
    expect(bridge.spawnTerminal).toHaveBeenCalledTimes(1);
    expect(panes()).toHaveLength(2);

    // Ctrl+W 关掉当前焦点 pane(分屏后焦点落在新 pane 上)。
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", ctrlKey: true }));
    });
    await flush();
    expect(panes().map((pane) => pane.dataset.sessionId)).toEqual(["s-restore"]);
    expect(bridge.detachTerminal).toHaveBeenCalledWith({
      repoId: "repo-a",
      sessionId: "s-split-1",
      attachmentId: "attach-s-split-1",
    });
  });

  it("uses ⌃⌘Arrow to split and ⌘W to close on macOS, leaving ⌘W to the window with no focused pane", async () => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      const { bridge } = stubBridge([sessionRow()]);
      mountView();
      await flush();
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, metaKey: true }));
      });
      await flush();
      expect(bridge.spawnTerminal).toHaveBeenCalledTimes(1);
      expect(panes()).toHaveLength(2);
      const close = new KeyboardEvent("keydown", { key: "w", metaKey: true, cancelable: true });
      act(() => {
        window.dispatchEvent(close);
      });
      await flush();
      expect(close.defaultPrevented).toBe(true);
      expect(panes()).toHaveLength(1);
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", metaKey: true, cancelable: true }));
      });
      await flush();
      expect(panes()).toHaveLength(0);
      // 没有焦点 pane 时 ⌘W 不再被本页吞掉,留给窗口。
      const orphan = new KeyboardEvent("keydown", { key: "w", metaKey: true, cancelable: true });
      act(() => {
        window.dispatchEvent(orphan);
      });
      expect(orphan.defaultPrevented).toBe(false);
    } finally {
      Reflect.deleteProperty(navigator, "platform");
    }
  });

  it("rearranges panes by dragging one pane's title bar onto another pane's edge", async () => {
    stubBridge([sessionRow()]);
    localStorage.setItem(layoutKey, JSON.stringify(storedLayout()));
    mountView();
    await flush();
    const [left, right] = panes();
    expect([left.dataset.sessionId, right.dataset.sessionId]).toEqual(["s-restore", "s-gone"]);
    // 落点 card 在 happy-dom 里没有尺寸:给它一个 200×100 的盒子;指针在左缘 → 放到它左边。
    const box = () =>
      ({
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        right: 200,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    right.getBoundingClientRect = box;
    act(() => {
      left.querySelector<HTMLElement>("[draggable]")!.dispatchEvent(new Event("dragstart", { bubbles: true }));
      right.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: 10, clientY: 50 }));
    });
    expect(right.querySelector<HTMLElement>('[data-testid="terminal-pane-drop"]')?.dataset.zone).toBe("left");
    act(() => {
      right.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 10, clientY: 50 }));
    });
    await flush();
    expect(panes().map((pane) => pane.dataset.sessionId)).toEqual(["s-restore", "s-gone"]);
    // 再拖到右缘:两个 pane 交换位置(死会话占位 pane 一样可以当落点)。
    const [a, b] = panes();
    b.getBoundingClientRect = box;
    act(() => {
      a.querySelector<HTMLElement>("[draggable]")!.dispatchEvent(new Event("dragstart", { bubbles: true }));
      b.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 190, clientY: 50 }));
    });
    await flush();
    expect(panes().map((pane) => pane.dataset.sessionId)).toEqual(["s-gone", "s-restore"]);
    expect(document.querySelector('[data-testid="terminal-pane-drop"]')).toBeNull();
  });

  it("opens a right-click menu on a pane with split/close/terminate and closes it on Escape", async () => {
    const { bridge } = stubBridge([sessionRow()]);
    mountView();
    await flush();
    const [pane] = panes();
    act(() => {
      pane.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 30 }));
    });
    const menu = document.querySelector<HTMLElement>('[data-testid="terminal-pane-menu"]');
    expect(menu).not.toBeNull();
    expect(menu!.style.left).toBe("40px");
    expect([...menu!.querySelectorAll("[role=menuitem]")].map((item) => item.textContent)).toEqual([
      "Copy",
      "Paste",
      "Split left",
      "Split right",
      "Split up",
      "Split down",
      "Close pane",
      "Terminate…",
    ]);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector('[data-testid="terminal-pane-menu"]')).toBeNull();
    act(() => {
      pane.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    act(() => {
      document.querySelectorAll<HTMLButtonElement>('[data-testid="terminal-pane-menu"] [role=menuitem]')[4].click();
    });
    await flush();
    expect(document.querySelector('[data-testid="terminal-pane-menu"]')).toBeNull();
    expect(bridge.spawnTerminal).toHaveBeenCalledTimes(1);
    expect(panes()).toHaveLength(2);
  });

  it("disables copy without a selection and copies or pastes through the active pane", async () => {
    const writeText = vi.fn(async () => undefined);
    const readText = vi.fn(async () => "pasted input");
    Object.defineProperty(navigator, "clipboard", { value: { writeText, readText }, configurable: true });
    const { bridge } = stubBridge([sessionRow()]);
    mountView();
    await flush();
    const pane = panes()[0];
    act(() => {
      pane.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    let items = document.querySelectorAll<HTMLButtonElement>('[data-testid="terminal-pane-menu"] [role=menuitem]');
    expect(items[0].disabled).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      terminalPaneMock.onSelectionChange?.("selected output");
    });
    act(() => {
      pane.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    items = document.querySelectorAll<HTMLButtonElement>('[data-testid="terminal-pane-menu"] [role=menuitem]');
    expect(items[0].disabled).toBe(false);
    act(() => items[0].click());
    expect(writeText).toHaveBeenCalledWith("selected output");
    act(() => {
      pane.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    items = document.querySelectorAll<HTMLButtonElement>('[data-testid="terminal-pane-menu"] [role=menuitem]');
    act(() => items[1].click());
    await flush();
    expect(readText).toHaveBeenCalledTimes(1);
    expect(bridge.sendTerminalInput).toHaveBeenCalledWith({
      repoId: "repo-a",
      sessionId: "s-restore",
      clientSeq: 1,
      utf8: "pasted input",
    });
  });

  it("resizes the sidebar by dragging its right edge and remembers the width", async () => {
    stubBridge([sessionRow()]);
    mountView();
    await flush();
    const aside = container!.querySelector<HTMLElement>('[data-testid="terminal-sidebar"]')!;
    const handle = container!.querySelector<HTMLElement>('[data-testid="terminal-sidebar-resize"]')!;
    expect(aside.style.width).toBe("224px");
    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 224, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 300, pointerId: 1 }));
    });
    expect(aside.style.width).toBe("300px");
    expect(localStorage.getItem("harness:gui:terminal-sidebar-width")).toBe("300");
    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 300, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 20, pointerId: 1 }));
    });
    expect(localStorage.getItem("harness:gui:terminal-sidebar-width")).toBe("160");
  });

  it("bans attaching one session into two panes by disabling it in the attach picker", async () => {
    // 自动附加取会话表里最后一个可附加的:s-restore 会进 pane,s-free 留在表里。
    stubBridge([sessionRow({ sessionId: "s-free", name: "Free" }), sessionRow()]);
    mountView();
    await flush();
    act(() => container!.querySelector<HTMLButtonElement>('[data-testid="terminal-attach"]')!.click());
    const options = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="terminal-attach-list"] button')];
    expect(options.find((option) => option.dataset.sessionId === "s-restore")?.disabled).toBe(true);
    expect(options.find((option) => option.dataset.sessionId === "s-free")?.disabled).toBe(false);
  });
});
