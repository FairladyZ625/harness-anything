// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAppShortcuts } from "../src/renderer/navigation/useAppShortcuts.ts";
import { terminalQueryKeys } from "../src/renderer/terminal-client.ts";
import { TerminalView } from "../src/renderer/views/TerminalView.tsx";

vi.mock("../src/renderer/components/terminal/TerminalPane.tsx", () => ({
  TerminalPane: ({ output }: { readonly output: string }) =>
    createElement("div", { "data-testid": "terminal-pane", "data-output": output }),
}));

const AT = "2026-09-01T00:00:00.000Z";
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
function sessionList(rows: readonly Row[], generation = 7): Row {
  return {
    schema: "terminal-session-list/v1",
    ok: true,
    repoId: "repo-a",
    daemonGeneration: generation,
    sessions: rows,
  };
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

/** window.harness 桥 mock:attach 的 initial 帧同步下发,stop 由调用方断言。 */
function stubBridge(list: Row[], attachInitial: Row | null) {
  const stop = vi.fn();
  const bridge = {
    listTerminalSessions: vi.fn(async () => sessionList(list)),
    spawnTerminal: vi.fn(async (payload: Row) => controlReceipt(String(payload.sessionId ?? "s-new"))),
    attachTerminal: vi.fn((_payload: Row, onValue: (value: Row) => void) => {
      if (attachInitial) onValue(attachInitial);
      return stop;
    }),
    sendTerminalInput: vi.fn(async () => ({ schema: "terminal-input-ack/v1", ok: true, acceptedThrough: 1 })),
    resizeTerminal: vi.fn(async () => controlReceipt("s-restore")),
    detachTerminal: vi.fn(async () => ({ schema: "terminal-detach-ack/v1", ok: true, state: "detached" })),
    terminateTerminal: vi.fn(async () => controlReceipt("s-restore")),
  };
  (window as unknown as Record<string, unknown>).harness = bridge;
  return { bridge, stop };
}

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
  vi.unstubAllGlobals();
});

function mountView(props: Record<string, unknown>) {
  container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  act(() => {
    root!.render(createElement(QueryClientProvider, { client }, createElement(TerminalView, props)));
  });
  return client;
}

async function flush() {
  // react-query 解析 + 通知 + 重渲染 + effect 需要跨几个任务边界,轮询到稳定。
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("terminal first-class page (PLT-TerminalWorkspace W0)", () => {
  it("auto-attaches the most recent attachable session when the page is entered", async () => {
    const { bridge } = stubBridge(
      [sessionRow({ sessionId: "s-old", name: "Old" }), sessionRow({ sessionId: "s-restore", name: "Build" })],
      {
        schema: "terminal-attach/v1",
        ok: true,
        sessionId: "s-restore",
        attachmentId: "attach-1",
        daemonGeneration: 7,
        status: "attached",
        replayFromSeq: 0,
        outputSeq: 2,
      },
    );
    mountView({ repoId: "repo-a", daemonGeneration: null, tasks: [] });
    await flush();
    expect(bridge.attachTerminal).toHaveBeenCalledWith(
      { repoId: "repo-a", sessionId: "s-restore", afterSeq: 0 },
      expect.any(Function),
    );
    expect(container!.textContent).toContain("Build");
    expect(container!.querySelector('[data-testid="terminal-pane"]')).not.toBeNull();
  });

  it("stops streams and detaches attachments when the page is left", async () => {
    const { bridge, stop } = stubBridge([sessionRow()], {
      schema: "terminal-attach/v1",
      ok: true,
      sessionId: "s-restore",
      attachmentId: "attach-leave",
      daemonGeneration: 7,
      status: "attached",
      replayFromSeq: 0,
      outputSeq: 2,
    });
    mountView({ repoId: "repo-a", daemonGeneration: null, tasks: [] });
    await flush();
    act(() => root!.unmount());
    root = null;
    expect(stop).toHaveBeenCalled();
    expect(bridge.detachTerminal).toHaveBeenCalledWith({
      repoId: "repo-a",
      sessionId: "s-restore",
      attachmentId: "attach-leave",
    });
  });

  it("releases tabs under the previous repo id when the repo switches while the page stays mounted", async () => {
    const { bridge } = stubBridge([sessionRow()], {
      schema: "terminal-attach/v1",
      ok: true,
      sessionId: "s-restore",
      attachmentId: "attach-switch",
      daemonGeneration: 7,
      status: "attached",
      replayFromSeq: 0,
      outputSeq: 2,
    });
    const client = mountView({ repoId: "repo-a", daemonGeneration: null, tasks: [] });
    await flush();
    act(() => {
      root!.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(TerminalView, { repoId: "repo-b", daemonGeneration: null, tasks: [] }),
        ),
      );
    });
    expect(bridge.detachTerminal).toHaveBeenCalledWith({
      repoId: "repo-a",
      sessionId: "s-restore",
      attachmentId: "attach-switch",
    });
    // 旧仓 tab 不残留:换仓后 tab 条清空、pane 卸载。
    expect(container!.textContent).not.toContain("Build");
    expect(container!.querySelector('[data-testid="terminal-pane"]')).toBeNull();
  });

  it("closing a tab detaches only that session and removes it from the strip", async () => {
    const { bridge } = stubBridge([sessionRow()], {
      schema: "terminal-attach/v1",
      ok: true,
      sessionId: "s-restore",
      attachmentId: "attach-close",
      daemonGeneration: 7,
      status: "attached",
      replayFromSeq: 0,
      outputSeq: 2,
    });
    mountView({ repoId: "repo-a", daemonGeneration: null, tasks: [] });
    await flush();
    const closeTab = container!.querySelector<HTMLButtonElement>('button[aria-label*="Build"]');
    expect(closeTab).not.toBeNull();
    act(() => closeTab!.click());
    await flush();
    expect(bridge.detachTerminal).toHaveBeenCalledWith({
      repoId: "repo-a",
      sessionId: "s-restore",
      attachmentId: "attach-close",
    });
    // tab 条上的关闭按钮与 pane 均随 tab 移除(会话仍留在 attach 下拉里)。
    expect(container!.querySelector('button[aria-label*="Build"]')).toBeNull();
    expect(container!.querySelector('[data-testid="terminal-pane"]')).toBeNull();
  });

  it("keeps the terminal session query scoped to the active repo", async () => {
    stubBridge([sessionRow()], null);
    const client = mountView({ repoId: "repo-a", daemonGeneration: null, tasks: [] });
    await flush();
    expect(client.getQueryData(terminalQueryKeys.sessions("repo-a"))).toBeTruthy();
    expect(client.getQueryData(terminalQueryKeys.sessions("repo-b"))).toBeFalsy();
  });
});

describe("Ctrl+` shortcut wiring", () => {
  function Probe({ onToggleTerminal }: { onToggleTerminal: () => void }) {
    useAppShortcuts({
      onTogglePalette: () => undefined,
      onToggleTerminal,
      onBack: () => undefined,
      onForward: () => undefined,
    });
    return createElement("div");
  }

  it("dispatches Ctrl+` to the terminal toggle handler and nothing else", () => {
    const onToggleTerminal = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(createElement(Probe, { onToggleTerminal })));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "`", ctrlKey: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "`" }));
    });
    expect(onToggleTerminal).toHaveBeenCalledTimes(1);
  });
});
