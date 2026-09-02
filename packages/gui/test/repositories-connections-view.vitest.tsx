// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SystemRepoRow } from "../src/renderer/api-client.ts";
import { connectionQueryKeys } from "../src/renderer/connection-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { RepositoriesAndConnectionsView } from "../src/renderer/views/settings/RepositoriesAndConnectionsView.tsx";

/**
 * Settings → 仓库与连接(PLT-EdgeGUI-W3,设计稿 §3.2)的行为判据:
 * ①左树呈现本机/远端端点/中心占位三段,仓库按 connectionId 挂载并带模式徽标;
 * ②添加连接 = register + 立即 probe,显示远端版本与仓列表,勾选注册为 remote-proxy;
 * ③编辑连接/移除(有启用仓时禁用并提示先移仓库);
 * ④remote-proxy 仓不出现模式切换器,显示「SSH 到服务器或注册本机仓」;
 * ⑤local ↔ remote-edge 仅在有中心连接时可用;
 * ⑥添加本机仓:有台账走注册,无台账走 bootstrap(沿用首次运行 IPC);
 * ⑦空态并入本页(无仓时显示添加引导,而非独立对话框)。
 */

const localRepo: SystemRepoRow = {
  repoId: "local-repo",
  displayName: "Local Repo",
  canonicalRoot: "/repo/local",
  authoredBranch: "main",
  registrationState: "enabled",
  mode: "local",
  connectionId: "local",
  cellState: "attached",
  generation: 1,
  queueDepth: 0,
  lockState: "held",
  recoveryMs: null,
  lastError: null,
  unavailableReason: null,
};
const proxyRepo: SystemRepoRow = {
  repoId: "server-ledger",
  displayName: "Server Ledger",
  canonicalRoot: null,
  authoredBranch: null,
  registrationState: "enabled",
  mode: "remote-proxy",
  connectionId: "server-b",
  cellState: "not_loaded",
  generation: null,
  queueDepth: null,
  lockState: "not_applicable",
  recoveryMs: null,
  lastError: null,
  unavailableReason: null,
};
const CONNECTIONS = [
  { id: "local", kind: "local", displayName: "This device", state: "enabled" },
  {
    id: "server-b",
    kind: "remote-endpoint",
    displayName: "Server B",
    state: "enabled",
    endpoint: "tcp://127.0.0.1:9911",
  },
];

const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

interface Bridge {
  readonly connections: Record<string, ReturnType<typeof vi.fn>>;
  readonly repoAdmin: Record<string, ReturnType<typeof vi.fn>>;
  readonly firstRun: Record<string, ReturnType<typeof vi.fn>>;
}

async function mountView(
  options: {
    readonly repos?: readonly SystemRepoRow[];
    readonly connections?: unknown;
    readonly probeResult?: unknown;
  } = {},
): Promise<{ container: HTMLElement; bridge: Bridge }> {
  const bridge: Bridge = {
    connections: {
      status: vi.fn(async () => ({ ok: true, connections: options.connections ?? CONNECTIONS })),
      probe: vi.fn(async () =>
        options.probeResult === undefined
          ? {
              ok: true,
              endpoint: "tcp://127.0.0.1:9911",
              protocolVersion: { major: 1, minor: 0 },
              build: { commit: "abcdef1234567890" },
              repos: [
                { repoId: "server-ledger", mode: "local", state: "attached" },
                { repoId: "server-other", mode: "local", state: "attached" },
              ],
            }
          : options.probeResult,
      ),
      register: vi.fn(async () => ({
        schema: "command-receipt/v2",
        ok: true,
        command: "daemon-connection-register",
        outcome: "applied",
        connection: CONNECTIONS[1],
      })),
      update: vi.fn(async () => ({
        schema: "command-receipt/v2",
        ok: true,
        command: "daemon-connection-update",
        outcome: "applied",
      })),
      unregister: vi.fn(async () => ({
        schema: "command-receipt/v2",
        ok: true,
        command: "daemon-connection-unregister",
        outcome: "applied",
      })),
    },
    repoAdmin: {
      register: vi.fn(async () => ({
        schema: "command-receipt/v2",
        ok: true,
        command: "daemon-repo-register",
        outcome: "applied",
      })),
      update: vi.fn(async () => ({
        schema: "command-receipt/v2",
        ok: true,
        command: "daemon-repo-update",
        outcome: "applied",
      })),
      unregister: vi.fn(async () => ({
        schema: "command-receipt/v2",
        ok: true,
        command: "daemon-repo-unregister",
        outcome: "applied",
      })),
      inspectWorkspace: vi.fn(async () => ({ ok: true, hasWorkspace: false, suggestedRepoId: "picked" })),
    },
    firstRun: {
      chooseRepository: vi.fn(async () => "/repo/picked"),
      bootstrap: vi.fn(async () => ({ ok: true, command: "init" })),
    },
  };
  vi.stubGlobal("window", { harness: bridge });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(connectionQueryKeys.status(), options.connections ?? CONNECTIONS);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RepositoriesAndConnectionsView, {
          repos: options.repos ?? [localRepo, proxyRepo],
          activeRepoId: "local-repo",
          onOpenProject: () => undefined,
        }),
      ),
    );
  });
  await settle();
  return { container, bridge };
}

async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  const target = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
  expect(target, `${testId} 未渲染`).toBeTruthy();
  await act(async () => target.click());
}

async function type(container: HTMLElement, testId: string, value: string): Promise<void> {
  const input = container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
  expect(input, `${testId} 未渲染`).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("repositories and connections page", () => {
  it("renders the local, remote-endpoint, and center nodes with repos under their connections", async () => {
    const { container } = await mountView();
    expect(container.querySelector('[data-testid="connection-node-local"]')?.textContent).toContain("This device");
    expect(container.querySelector('[data-testid="connection-node-remote:server-b"]')?.textContent).toContain(
      "Server B",
    );
    expect(container.querySelector('[data-testid="connection-node-center"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="connection-repo-local-repo"]')?.textContent).toContain("Local Repo");
    expect(container.querySelector('[data-testid="connection-repo-server-ledger"]')?.textContent).toContain(
      "Server Ledger",
    );
    expect(container.querySelector('[data-testid="repo-mode-badge-remote-proxy"]')?.textContent).toContain("view-only");
  });

  it("adds a connection, probes immediately, and registers a checked repo as remote-proxy", async () => {
    const { container, bridge } = await mountView();
    await click(container, "connection-add-open");
    await type(container, "connection-display-name", "Server B");
    await type(container, "connection-endpoint", "tcp://127.0.0.1:9911");
    await click(container, "connection-submit");
    expect(bridge.connections.register).toHaveBeenCalledWith({
      displayName: "Server B",
      endpoint: "tcp://127.0.0.1:9911",
    });
    expect(bridge.connections.probe).toHaveBeenCalledWith({ endpoint: "tcp://127.0.0.1:9911" });
    expect(container.textContent).toContain("v1.0");
    await click(container, "probe-repo-check-server-other");
    await click(container, "probe-register-selected");
    expect(bridge.repoAdmin.register).toHaveBeenCalledWith({
      repoId: "server-other",
      mode: "remote-proxy",
      connectionId: "server-b",
    });
  });

  it("blocks removing a connection while it still has enabled repositories", async () => {
    const { container, bridge } = await mountView();
    await click(container, "connection-node-remote:server-b");
    const remove = container.querySelector('[data-testid="connection-remove"]') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(container.textContent).toContain("Remove its repositories first");
    expect(bridge.connections.unregister).not.toHaveBeenCalled();
  });

  it("shows the SSH guidance instead of a mode switch for a remote-proxy repository", async () => {
    const { container, bridge } = await mountView();
    await click(container, "connection-repo-server-ledger");
    expect(container.textContent).toContain("SSH to the server or register a repository on this device");
    expect(container.querySelector('[data-testid="repo-feedback"]')).toBeNull();
    expect(bridge.repoAdmin.update).not.toHaveBeenCalled();
  });

  it("keeps local to edge switching gated on a center connection", async () => {
    const { container, bridge } = await mountView();
    await click(container, "connection-repo-local-repo");
    expect(container.textContent).toContain("Switching to edge requires a center connection");
    expect(bridge.repoAdmin.update).not.toHaveBeenCalled();
  });

  it("registers a picked folder that already has a ledger instead of bootstrapping", async () => {
    const { container, bridge } = await mountView({ repos: [] });
    expect(container.querySelector('[data-testid="local-empty-state"]')?.textContent).toContain(
      "Add a repository or a connection",
    );
    bridge.repoAdmin.inspectWorkspace.mockImplementation(
      vi.fn(async () => ({ ok: true, hasWorkspace: true, suggestedRepoId: "picked" })),
    );
    await click(container, "add-local-choose");
    expect(bridge.repoAdmin.inspectWorkspace).toHaveBeenCalledWith({ rootDir: "/repo/picked" });
    expect(container.querySelector('[data-testid="add-local-person-id"]')).toBeNull();
    await click(container, "add-local-register");
    expect(bridge.repoAdmin.register).toHaveBeenCalledWith({
      rootDir: "/repo/picked",
      repoId: "picked",
      mode: "local",
    });
    expect(bridge.firstRun.bootstrap).not.toHaveBeenCalled();
  });

  it("bootstraps a folder without a ledger through the first-run IPC", async () => {
    const { container, bridge } = await mountView({ repos: [] });
    await click(container, "add-local-choose");
    await type(container, "add-local-person-id", "person_owner");
    await type(container, "add-local-display-name", "Owner");
    await click(container, "add-local-bootstrap");
    expect(bridge.firstRun.bootstrap).toHaveBeenCalledWith({
      rootDir: "/repo/picked",
      repoId: "picked",
      personId: "person_owner",
      displayName: "Owner",
      name: "picked",
    });
    expect(bridge.repoAdmin.register).not.toHaveBeenCalled();
  });
});
