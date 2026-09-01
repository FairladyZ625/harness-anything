// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { TerminalView } from "../src/renderer/views/TerminalView.tsx";

// pane 内容用桩替代真 xterm:本文件测的是 pane 树(分割/关闭/序列化/每 pane 上报),
// 不是终端仿真;桩把 onFit 暴露成一次点击,才能对「每个 pane 各自上报 cols/rows」下断言。
vi.mock("../src/renderer/components/terminal/TerminalPane.tsx", () => ({
  TerminalPane: ({ output, onFit }: { readonly output: string; readonly onFit: (c: number, r: number) => void }) =>
    createElement("button", {
      "data-testid": "terminal-pane",
      "data-output": output,
      onClick: () => onFit(120, 40),
    }),
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

  it("splits and closes the focused pane from the keyboard", async () => {
    const { bridge } = stubBridge([sessionRow()]);
    mountView();
    await flush();

    // Ctrl+Shift+5 = 向右分屏(与 useAppShortcuts 同惯例:window keydown + preventDefault)。
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "5", ctrlKey: true, shiftKey: true }));
    });
    await flush();
    expect(bridge.spawnTerminal).toHaveBeenCalledTimes(1);
    expect(panes()).toHaveLength(2);

    // Ctrl+Shift+W 关掉当前焦点 pane(分屏后焦点落在新 pane 上)。
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "W", ctrlKey: true, shiftKey: true }));
    });
    await flush();
    expect(panes().map((pane) => pane.dataset.sessionId)).toEqual(["s-restore"]);
    expect(bridge.detachTerminal).toHaveBeenCalledWith({
      repoId: "repo-a",
      sessionId: "s-split-1",
      attachmentId: "attach-s-split-1",
    });
  });

  it("bans attaching one session into two panes by disabling it in the attach picker", async () => {
    // 自动附加取会话表里最后一个可附加的:s-restore 会进 pane,s-free 留在表里。
    stubBridge([sessionRow({ sessionId: "s-free", name: "Free" }), sessionRow()]);
    mountView();
    await flush();
    const options = [...container!.querySelectorAll<HTMLOptionElement>("option")];
    expect(options.find((option) => option.value === "s-restore")?.disabled).toBe(true);
    expect(options.find((option) => option.value === "s-free")?.disabled).toBe(false);
  });
});
