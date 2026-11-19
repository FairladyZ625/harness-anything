import { mockRpcBridge } from "./mock-rpc-bridge.ts";
// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { request as requestHttp } from "node:http";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import type { Window as TestWindow } from "happy-dom";
import type { GuiServiceBridge } from "../src/main/local-composition-root.ts";
import { resetGuiTransportForTest } from "../src/renderer/gui-transport.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { TerminalView } from "../src/renderer/views/TerminalView.tsx";

const terminalPaneMock = vi.hoisted(() => ({ onSelectionChange: null as ((text: string) => void) | null }));

// pane 内容用桩替代真 xterm:本文件测的是 pane 树(分割/关闭/序列化/每 pane 上报),
// 不是终端仿真;桩把 onFit 暴露成一次点击,才能对「每个 pane 各自上报 cols/rows」下断言。
vi.mock("../src/renderer/components/terminal/TerminalPane.tsx", () => ({
  TerminalPane: ({
    output,
    interactive,
    onFit,
    onInput,
    onSelectionChange,
  }: {
    readonly output: string;
    readonly interactive: boolean;
    readonly onFit: (c: number, r: number) => void;
    readonly onInput: (text: string) => void;
    readonly onSelectionChange: (text: string) => void;
  }) => {
    terminalPaneMock.onSelectionChange = onSelectionChange;
    return createElement("button", {
      "data-testid": "terminal-pane",
      "data-output": output,
      "data-interactive": interactive ? "true" : "false",
      onClick: () => onFit(120, 40),
      onKeyDown: (event) => {
        if (interactive) onInput(event.key);
      },
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
    sendTerminalInput: vi.fn(async (_payload: Row) => inputAck(1)),
    resizeTerminal: vi.fn(async (payload: Row) => controlReceipt(String(payload.sessionId))),
    detachTerminal: vi.fn(async () => ({ schema: "terminal-detach-ack/v1", ok: true, state: "detached" })),
    terminateTerminal: vi.fn(async () => controlReceipt("s-restore")),
  };
  (window as unknown as Record<string, unknown>).harness = mockRpcBridge(bridge, {
    "repo.terminal.sessions.list": "listTerminalSessions",
    "repo.terminal.spawn": "spawnTerminal",
    "repo.terminal.input": "sendTerminalInput",
    "repo.terminal.resize": "resizeTerminal",
    "repo.terminal.detach": "detachTerminal",
    "repo.terminal.terminate": "terminateTerminal",
    "repo.terminal.attach": "attachTerminal",
  });
  return { bridge, stops };
}
function inputAck(acceptedThrough: number) {
  return { schema: "terminal-input-ack/v1", ok: true, acceptedThrough };
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
  resetGuiTransportForTest();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

function fetchBrowserBroker(url: URL, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Origin", url.origin);
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      url.href,
      { method: init.method, headers: Object.fromEntries(headers), signal: init.signal ?? undefined },
      (response) =>
        resolve(
          new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
            status: response.statusCode,
            headers: { "Content-Type": response.headers["content-type"] ?? "" },
          }),
        ),
    );
    request.once("error", reject);
    request.end(String(init.body));
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

async function mountDurablePane() {
  const { bridge } = stubBridge([
    sessionRow({ requestedBackend: "tmux", backend: "tmux", durability: "daemon-restart" }),
  ]);
  let acceptedThrough = 0,
    hostGeneration = 7;
  const writes: string[] = [];
  const beforeAck = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  bridge.sendTerminalInput.mockImplementation(async ({ daemonGeneration, clientSeq, utf8 }) => {
    if (daemonGeneration !== hostGeneration) throw new Error("terminal_generation_mismatch");
    const seq = Number(clientSeq);
    if (seq > acceptedThrough + 1) throw new Error(`terminal_input_gap: Expected clientSeq ${acceptedThrough + 1}`);
    if (seq > acceptedThrough) {
      writes.push(String(utf8));
      acceptedThrough = seq;
    }
    const ack = inputAck(acceptedThrough);
    await beforeAck();
    return ack;
  });
  mountView();
  await flush();
  const [pane] = panes();
  const terminal = pane.querySelector<HTMLElement>('[data-testid="terminal-pane"]')!;
  const [, onValue] = bridge.attachTerminal.mock.calls[0];
  const output = (seq: number, utf8: string) =>
    onValue({ schema: "terminal-attach-event/v1", sessionId: "s-restore", seq, kind: "output", utf8 });
  await act(async () => output(2, "before\n"));
  const reattach = (daemonGeneration: number) =>
    act(async () => {
      onValue({
        schema: "terminal-attach/v1",
        ok: true,
        sessionId: "s-restore",
        attachmentId: `reattach-${daemonGeneration}`,
        daemonGeneration,
        status: "gap",
        replayFromSeq: 1,
        outputSeq: 0,
      });
      if (daemonGeneration !== hostGeneration) {
        hostGeneration = daemonGeneration;
        acceptedThrough = 0;
        output(1, "after\n");
      }
    });
  const type = (key: string) =>
    act(async () => {
      terminal.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  return { input: bridge.sendTerminalInput, terminal, type, reattach, beforeAck, writes };
}

describe("terminal split panes (PLT-TerminalWorkspace W1)", () => {
  it("continues input on a same-generation gap and starts at one after a daemon restart", async () => {
    const { input, terminal, type, reattach, writes } = await mountDurablePane();
    await type("a");
    await reattach(7);
    await type("b");
    expect(writes).toEqual(["a", "b"]);
    await reattach(8);
    expect(terminal.dataset.output).toBe("before\nafter\n");
    await type("c");
    await type("d");
    expect(input.mock.calls.map(([payload]) => [payload.daemonGeneration, payload.clientSeq])).toEqual([
      [7, 1],
      [7, 2],
      [8, 1],
      [8, 2],
    ]);
    expect(writes).toEqual(["a", "b", "c", "d"]);
  });

  it("lets the new daemon generation take input while an old acknowledgement is still pending", async () => {
    const { input, type, reattach, beforeAck, writes } = await mountDurablePane();
    await type("a");
    const oldAck = Promise.withResolvers<void>();
    beforeAck.mockReturnValueOnce(oldAck.promise);
    await type("b");
    await type("x");
    expect(writes).toEqual(["a", "b"]);

    await reattach(8);
    await type("c");
    const beforeOldAck = [...writes];
    await act(async () => oldAck.resolve());
    await type("d");
    expect(beforeOldAck).toEqual(["a", "b", "c"]);
    expect(input.mock.calls.map(([payload]) => [payload.utf8, payload.clientSeq])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 1],
      ["d", 2],
    ]);
    expect(writes).toEqual(["a", "b", "c", "d"]);
  });

  // dec_89D06D7360CBEC09795F7B12EC/CH3: the same pane and real transport must recover after
  // the old host emits its end frame, and an already-issued unary request must keep its old generation.
  it.each(["Electron", "Browser"])(
    "recovers a mounted %s pane across graceful terminal host shutdown",
    async (client) => {
      // Use the Node loader for the real servers. The renderer's Vite worker transform
      // treats PGlite's dynamically resolved worker URL as a browser asset.
      const loadNode = createRequire(import.meta.url);
      const { startTerminalRestartFixture } = loadNode(
        "../../daemon/test/fixtures/terminal-restart.ts",
      ) as typeof import("../../daemon/test/fixtures/terminal-restart.ts");
      const { startBrowserGuiFixture } = loadNode(
        "../../cli/test/gui-browser-broker.fixture.ts",
      ) as typeof import("../../cli/test/gui-browser-broker.fixture.ts");
      const fixture = await startTerminalRestartFixture("repo-a");
      const release = Promise.withResolvers<void>();
      let held = false,
        staleReply: unknown;
      const hold = async (method: string, params: unknown): Promise<boolean> => {
        if (method !== "repo.terminal.input" || (params as { payload: Row }).payload.utf8 !== "b") return false;
        held = true;
        await release.promise;
        return true;
      };
      for (const [name, value] of Object.entries(fixture.env)) vi.stubEnv(name, value);
      vi.stubEnv("HARNESS_EXECUTION_CREDENTIAL", undefined);
      vi.stubEnv("HARNESS_DAEMON_RELAY", undefined);
      vi.stubEnv("HARNESS_GUI_READONLY_DAEMON_USER_ROOT", undefined);
      const previousUrl = window.location.href,
        dom = (window as unknown as TestWindow).happyDOM;
      let broker: Awaited<ReturnType<typeof startBrowserGuiFixture>> | undefined;
      try {
        if (client === "Electron") {
          const { createLocalGuiServiceBridge } = loadNode(
            "../src/main/local-composition-root.ts",
          ) as typeof import("../src/main/local-composition-root.ts");
          const bridge = createLocalGuiServiceBridge();
          const harness: Window["harness"] = {
            request: async (method, params) => {
              const delayed = await hold(method, params);
              const result = await bridge.invoke(method, params as Parameters<GuiServiceBridge["invoke"]>[1]);
              if (delayed) staleReply = result;
              return result;
            },
            subscribe: (method, params, onValue, onError) => {
              const controller = new AbortController();
              void bridge
                .stream(method, params as Parameters<GuiServiceBridge["stream"]>[1], onValue, controller.signal)
                .catch(onError);
              return () => controller.abort();
            },
          };
          Object.defineProperty(window, "harness", { configurable: true, value: harness });
        } else {
          broker = await startBrowserGuiFixture(
            fixture.parent,
            fixture.rootDir,
            "<!doctype html><title>Terminal restart</title>",
          );
          const url = new URL(broker.url);
          dom.setURL(url.href);
          vi.stubGlobal("fetch", async (resource: string, init: RequestInit) => {
            const call = JSON.parse(String(init.body)) as { method: string; params: unknown };
            const delayed = await hold(call.method, call.params);
            const response = await fetchBrowserBroker(new URL(resource, url), init);
            if (delayed) staleReply = await response.clone().json();
            return response;
          });
        }

        mountView();
        const expectOutput = (value: string) =>
          expect
            .poll(
              async () => {
                await flush();
                return panes()[0]?.querySelector<HTMLElement>('[data-testid="terminal-pane"]')?.dataset.output;
              },
              { timeout: 8_000 },
            )
            .toBe(value);
        await expectOutput("");
        const [pane] = panes();
        expect(pane.dataset.sessionId).toBe(fixture.sessionId);
        const terminal = pane.querySelector<HTMLElement>('[data-testid="terminal-pane"]')!;
        const type = (key: string) =>
          act(async () => {
            terminal.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
          });
        await expect.poll(() => terminal.dataset.interactive, { timeout: 8_000 }).toBe("true");
        await type("a");
        await expectOutput("a");
        await type("b");
        await expect.poll(() => held).toBe(true);
        await act(async () => fixture.restart());
        await expectOutput("areattached:");
        expect(panes()[0]).toBe(pane);
        expect(fixture.attached).toMatchObject([
          { generation: 7, afterSeq: 0 },
          { generation: 8, afterSeq: 1, daemonGeneration: 7 },
        ]);
        await type("c");
        await expectOutput("areattached:c");
        release.resolve();
        await expect
          .poll(() => staleReply)
          .toMatchObject({ ok: false, error: { code: "terminal_generation_mismatch" } });
        await type("d");
        await expectOutput("areattached:cd");
        expect(fixture.writes).toEqual([
          { generation: 7, utf8: "a" },
          { generation: 8, utf8: "c" },
          { generation: 8, utf8: "d" },
        ]);
      } finally {
        release.resolve();
        if (root) act(() => root!.unmount());
        root = null;
        await broker?.close();
        await fixture.close();
        window.sessionStorage.clear();
        dom.setURL(previousUrl);
      }
    },
    25_000,
  );

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
      daemonGeneration: 7,
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
