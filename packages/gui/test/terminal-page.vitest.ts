// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAppShortcuts } from "../src/renderer/navigation/useAppShortcuts.ts";
import { terminalQueryKeys } from "../src/renderer/terminal-client.ts";
import { TerminalView } from "../src/renderer/views/TerminalView.tsx";

vi.mock("../src/renderer/components/terminal/TerminalPane.tsx", async () => {
  const { useTerminalPaneActions } = await vi.importActual<
    typeof import("../src/renderer/components/terminal/terminal-pane-context.ts")
  >("../src/renderer/components/terminal/terminal-pane-context.ts");
  return {
    // W2:顺手捕获 pane actions 与 openUrl 注入,链接分发测试从这里取。
    TerminalPane: ({ output, openUrl }: { readonly output: string; readonly openUrl: unknown }) => {
      paneProbe.actions = useTerminalPaneActions();
      paneProbe.openUrl = openUrl;
      return createElement("div", { "data-testid": "terminal-pane", "data-output": output });
    },
  };
});

const paneProbe = vi.hoisted(() => ({ actions: null as unknown, openUrl: undefined as unknown }));

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
  paneProbe.actions = null;
  paneProbe.openUrl = undefined;
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
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TerminalView, {
          repoRoot: null,
          onNavigateEntity: () => undefined,
          onOpenDocument: () => undefined,
          ...props,
        }),
      ),
    );
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

  // Regression: under StrictMode (dev) the page mounts, its cleanup runs, then it remounts. The
  // release effect only reset `mounted` to false in cleanup and never back to true on (re)mount, so
  // after the remount `mounted` was stuck false and start() spawned a session but returned before
  // attaching it — every "new terminal" (auto-start and the + button) silently did nothing.
  it("spawns and attaches a new terminal after a StrictMode mount/cleanup/remount", async () => {
    const stop = vi.fn();
    const spawnedRow = sessionRow({ sessionId: "s-new", name: "Spawned" });
    let rows: Row[] = [];
    const bridge = {
      listTerminalSessions: vi.fn(async () => sessionList(rows)),
      spawnTerminal: vi.fn(async () => {
        rows = [spawnedRow];
        return controlReceipt("s-new");
      }),
      attachTerminal: vi.fn((_payload: Row, onValue: (value: Row) => void) => {
        onValue({
          schema: "terminal-attach/v1",
          ok: true,
          sessionId: "s-new",
          attachmentId: "attach-new",
          daemonGeneration: 7,
          status: "attached",
          replayFromSeq: 0,
          outputSeq: 0,
        });
        return stop;
      }),
      sendTerminalInput: vi.fn(async () => ({ schema: "terminal-input-ack/v1", ok: true, acceptedThrough: 1 })),
      resizeTerminal: vi.fn(async () => controlReceipt("s-new")),
      detachTerminal: vi.fn(async () => ({ schema: "terminal-detach-ack/v1", ok: true, state: "detached" })),
      terminateTerminal: vi.fn(async () => controlReceipt("s-new")),
    };
    (window as unknown as Record<string, unknown>).harness = bridge;

    container = document.createElement("div");
    document.body.append(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(
          StrictMode,
          null,
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
        ),
      );
    });
    await flush();

    expect(bridge.spawnTerminal).toHaveBeenCalled();
    expect(bridge.attachTerminal).toHaveBeenCalledWith(
      { repoId: "repo-a", sessionId: "s-new", afterSeq: 0 },
      expect.any(Function),
    );
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

/** 受控 input:必须走原生 value setter 再派 input,否则 React 的 value tracker 会把事件当无变化吞掉。 */
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("task binding (searchable picker + open-from-task-detail)", () => {
  const manyTasks = Array.from({ length: 300 }, (_, index) => ({
    taskId: `task_${String(index).padStart(4, "0")}`,
    title: index === 42 ? "Fix xterm colour palette" : `Task number ${index}`,
  }));

  it("binds a task picked from the tree popover (search hit + ancestor context) to the custom launch", async () => {
    const { bridge } = stubBridge([sessionRow()], null); // 已有会话 → 进页只附加,不自动 spawn。
    const tree = [
      { taskId: "root", title: "Terminal milestone", status: "active" as const },
      ...manyTasks.map((task) => ({ ...task, parentTaskId: "root", status: "planned" as const })),
    ];
    mountView({ repoId: "repo-a", daemonGeneration: null, tasks: tree });
    await flush();
    // 启动选项收在侧栏的气泡里,task 选择器又是它里面的大气泡:两层都要点开。
    act(() => container!.querySelector<HTMLButtonElement>('[data-testid="terminal-launch-options"]')!.click());
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="terminal-task-tree"]')!;
    expect(trigger.textContent).toBe("unbound");
    act(() => trigger.click());
    // 浏览模式:只列根,不把几百个子节点塞进 DOM。
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    act(() =>
      typeInto(document.querySelector<HTMLInputElement>('[data-testid="terminal-task-tree-search"]')!, "colour"),
    );
    const rows = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(rows.map((row) => [row.dataset.taskId, row.dataset.hit])).toEqual([
      ["root", "false"],
      ["task_0042", "true"],
    ]);
    act(() => rows[1].querySelectorAll("button")[1].click());
    expect(document.querySelector('[data-testid="terminal-task-tree-panel"]')).toBeNull();
    expect(trigger.textContent).toBe("Fix xterm colour palette");
    act(() =>
      document.querySelector<HTMLFormElement>('[data-testid="terminal-launch-options-panel"] form')!.requestSubmit(),
    );
    await flush();
    expect(bridge.spawnTerminal).toHaveBeenCalledTimes(1);
    expect(bridge.spawnTerminal.mock.calls[0][0]).toMatchObject({ taskId: "task_0042" });
  });

  it("spawns one session bound to the launch task when entered from task detail, even under StrictMode", async () => {
    const { bridge } = stubBridge([], null);
    const launchTask = { requestId: "req-1", taskId: "task_0042", title: "Fix xterm colour palette" };
    container = document.createElement("div");
    document.body.append(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(
          StrictMode,
          null,
          createElement(
            QueryClientProvider,
            { client },
            createElement(TerminalView, {
              repoId: "repo-a",
              daemonGeneration: null,
              tasks: manyTasks,
              repoRoot: null,
              launchTask,
              onNavigateEntity: () => undefined,
              onOpenDocument: () => undefined,
            }),
          ),
        ),
      );
    });
    await flush();
    expect(bridge.spawnTerminal).toHaveBeenCalledTimes(1);
    expect(bridge.spawnTerminal.mock.calls[0][0]).toMatchObject({
      taskId: "task_0042",
      name: "Fix xterm colour palette",
    });
  });
});

describe("terminal links dispatch (PLT-TerminalWorkspace W2)", () => {
  function attachBridge() {
    return stubBridge([sessionRow()], {
      schema: "terminal-attach/v1",
      ok: true,
      sessionId: "s-restore",
      attachmentId: "attach-links",
      daemonGeneration: 7,
      status: "attached",
      replayFromSeq: 0,
      outputSeq: 2,
    });
  }

  it("routes entity links to the entity navigation callback and path links to the document opener", async () => {
    attachBridge();
    const onNavigateEntity = vi.fn();
    const onOpenDocument = vi.fn();
    mountView({
      repoId: "repo-a",
      daemonGeneration: null,
      tasks: [],
      repoRoot: "/repo/a",
      onNavigateEntity,
      onOpenDocument,
    });
    await flush();
    const actions = paneProbe.actions as {
      readonly openLink: (match: unknown, text: string, cwd: string | null) => void;
    } | null;
    expect(actions).not.toBeNull();
    act(() => {
      actions!.openLink(
        { kind: "entity", ref: "task/01cb8cf64ad28a48b4a7506b85", start: 0, end: 31 },
        "task_01cb8cf64ad28a48b4a7506b85",
        "/repo/a",
      );
      actions!.openLink(
        { kind: "path", path: "packages/gui/src/a.ts", line: 3, start: 0, end: 27 },
        "packages/gui/src/a.ts:3",
        "/repo/a",
      );
    });
    expect(onNavigateEntity).toHaveBeenCalledWith("task/01cb8cf64ad28a48b4a7506b85");
    expect(onOpenDocument).toHaveBeenCalledWith("/repo/a/packages/gui/src/a.ts");
  });

  it("copies the link text when no base can resolve a relative path", async () => {
    attachBridge();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onNavigateEntity = vi.fn();
    const onOpenDocument = vi.fn();
    mountView({ repoId: "repo-a", daemonGeneration: null, tasks: [], onNavigateEntity, onOpenDocument });
    await flush();
    const actions = paneProbe.actions as {
      readonly openLink: (match: unknown, text: string, cwd: string | null) => void;
    } | null;
    act(() => {
      actions!.openLink({ kind: "path", path: "src/a.ts", line: null, start: 0, end: 8 }, "src/a.ts", null);
    });
    await flush();
    expect(writeText).toHaveBeenCalledWith("src/a.ts");
    expect(onNavigateEntity).not.toHaveBeenCalled();
    expect(onOpenDocument).not.toHaveBeenCalled();
  });

  it("threads the openUrl seam to the pane; null keeps the web-links default", async () => {
    attachBridge();
    mountView({ repoId: "repo-a", daemonGeneration: null, tasks: [] });
    await flush();
    expect(paneProbe.openUrl).toBeNull();
    const openUrl = vi.fn();
    mountView({ repoId: "repo-a", daemonGeneration: null, tasks: [], openUrl });
    await flush();
    expect(paneProbe.openUrl).toBe(openUrl);
  });
});
