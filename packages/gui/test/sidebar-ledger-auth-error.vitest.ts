import { mockRpcBridge } from "./mock-rpc-bridge.ts";
// harness-test-tier: fast
// @vitest-environment happy-dom
//
// 会话失效时侧栏底部不得再重复顶部读面横幅的认证错误(task_d149780d)。
//
// 缺陷现场:顶部横幅已经给出「需要登录 + 登录按钮」,侧栏左下角仍把
// `authentication_required` 渲染成「台账桥读取失败: 需要登录后才能…」,既与账号卡
// 「尚未登录」重复又因侧栏宽度被硬裁断。这里挂真实的 App,用桥接替身让两条台账读
// 都回 authentication_required——断言的是业主在 DOM 上看到的侧栏,而不是某个内部函数。
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../src/renderer/App.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const REPO_ID = "canonical";
const AT = "2026-11-05T00:00:00.000Z";

const mounted: { root: Root; container: HTMLElement }[] = [];

interface ReadFailure {
  readonly code: string;
  readonly hint: string;
  readonly syncProgress?: Record<string, unknown>;
}

function readFailure(failure: ReadFailure) {
  return {
    ok: false as const,
    error: {
      code: failure.code,
      hint: failure.hint,
      ...(failure.syncProgress ? { syncProgress: failure.syncProgress } : {}),
    },
  };
}

async function mountApp(options: { readonly summary: ReadFailure; readonly tasks: ReadFailure }): Promise<HTMLElement> {
  const bridge: Record<string, (payload?: Record<string, unknown> | null) => Promise<unknown>> = {
    getSystemStatus: async () => ({
      schema: "gui-system-status/v1",
      ok: true,
      observedAt: AT,
      // Full `gui-system-status/v1` daemon shape: `build` is required by the daemon contract.
      daemon: {
        daemonId: "daemon-probe",
        pid: 1,
        startedAt: AT,
        protocolVersion: { major: 1, minor: 0 },
        uptimeMs: 1,
        endpoint: "sock",
        build: { version: "probe", commitSha: null },
        activeControl: null,
      },
      repos: [
        {
          repoId: REPO_ID,
          displayName: "Probe",
          canonicalRoot: "/tmp/probe",
          authoredBranch: "main",
          registrationState: "enabled",
          mode: "local",
          connectionId: "local",
          cellState: "attached",
          generation: 1,
          queueDepth: 0,
          lockState: "not_applicable",
          recoveryMs: null,
          lastError: null,
          unavailableReason: null,
        },
      ],
    }),
    getTasks: async () => readFailure(options.tasks),
    getWorkspaceSummary: async () => readFailure(options.summary),
    getAgenda: async () => ({
      ok: true,
      status: "ready",
      inFlight: [],
      pinnedEntities: [],
      pinnedEntityOverflow: 0,
      awaitingRestart: [],
      awaitingRework: [],
      awaitingAdjudication: [],
      underReview: [],
      awaitingYou: [],
      answeredForYou: [],
      decisionReviewInProgress: [],
      awaitingDecisionReview: [],
      awaitingDecision: [],
      waitingOnOthers: [],
      dispatchable: [],
      summary: "",
      page: { sourceLimit: 100, cursor: null, nextCursor: null },
      watermark: 1_000,
      sourceRevision: 1_000,
    }),
  };
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: mockRpcBridge(
      new Proxy(bridge, {
        get(target, method: string) {
          if (method in target) return target[method];
          // 与侧栏无关的读面统一回空成功:断言面不扩到它们。
          return async () => ({ ok: true });
        },
      }),
      {
        "daemon.gui.system.read": "getSystemStatus",
        "repo.tasks.list": "getTasks",
        "repo.workspace.summary.read": "getWorkspaceSummary",
        "repo.agenda.read": "getAgenda",
      },
    ),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(App)));
  });
  // 挂载链(systemStatus → repoId → 两条台账读)跨多个 promise 世代;排空 0ms 宏任务,
  // 不等待固定墙钟时间。
  for (let turn = 0; turn < 8; turn += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return container;
}

function statusPanel(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="sidebar-system-status"]') as HTMLElement;
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  Reflect.deleteProperty(window, "harness");
  window.localStorage.clear();
});

describe("sidebar ledger failure surface", () => {
  it("does not repeat an authentication failure that the read banner already owns", async () => {
    const authenticationRequired = {
      code: "authentication_required",
      hint: "Sign in with the configured identity provider.",
    };
    const container = await mountApp({ summary: authenticationRequired, tasks: authenticationRequired });
    const panel = statusPanel(container);
    expect(panel).not.toBeNull();
    // 横幅/账号卡是唯一入口:侧栏状态区不出现认证错误文案,也不出现失败行与刷新按钮。
    expect(panel.textContent).not.toContain("台账桥读取失败");
    expect(panel.textContent).not.toContain("需要登录");
    expect(panel.textContent).not.toContain("Sign in with the configured identity provider.");
    expect(panel.querySelector('[data-testid="task-error-state"]')).toBeNull();
    expect(panel.querySelector('[data-testid="ledger-refresh-button"]')).toBeNull();
    // 系统运行区的健康行照常存在,删掉的只是重复的认证错误行。
    expect(panel.querySelector('[data-testid="sidebar-system-status-open"]')).not.toBeNull();
  });

  it("still shows a non-authentication ledger failure in full", async () => {
    const hint = "Replica is unavailable; retry after the cell reattaches.";
    const container = await mountApp({
      summary: { code: "replica_unavailable", hint },
      tasks: { code: "replica_unavailable", hint },
    });
    const panel = statusPanel(container);
    expect(panel.querySelector('[data-testid="task-error-state"]')).not.toBeNull();
    expect(panel.textContent).toContain("台账桥读取失败");
    expect(panel.textContent).toContain(hint);
    // 错误行让出整行宽度并允许折行,不再被刷新时间挤到溢出裁切。
    const errorLine = panel.querySelector('[data-testid="ledger-error"]') as HTMLElement;
    expect(errorLine.textContent).toContain(hint);
    expect(errorLine.className).toContain("break-words");
    expect(panel.textContent).not.toContain("刚刚刷新");
  });

  it("keeps the tasks failure visible when the workspace summary requires authentication", async () => {
    const hint = "Replica is unavailable; retry after the cell reattaches.";
    const container = await mountApp({
      summary: { code: "authentication_required", hint: "Sign in with the configured identity provider." },
      tasks: { code: "replica_unavailable", hint },
    });
    const panel = statusPanel(container);
    // 认证错误不能把另一条读的非认证故障一起藏掉:状态栏显示 tasks 的 replica 故障。
    expect(panel.textContent).toContain("台账桥读取失败");
    expect(panel.textContent).toContain(hint);
    expect(panel.textContent).not.toContain("需要登录");
    expect(panel.querySelector('[data-testid="task-error-state"]')).not.toBeNull();
  });

  it("keeps the workspace summary failure visible when the tasks read requires authentication", async () => {
    const hint = "Workspace projection is unavailable; retry shortly.";
    const container = await mountApp({
      summary: { code: "replica_unavailable", hint },
      tasks: { code: "authentication_required", hint: "Sign in with the configured identity provider." },
    });
    const panel = statusPanel(container);
    // 反过来同样成立:非认证错误在第一条时照常显示,不因另一条读认证失败而消失。
    expect(panel.textContent).toContain("台账桥读取失败");
    expect(panel.textContent).toContain(hint);
    expect(panel.textContent).not.toContain("需要登录");
    expect(panel.querySelector('[data-testid="task-error-state"]')).not.toBeNull();
  });

  it("renders amber syncing progress in both sidebar and main surface during replica_syncing", async () => {
    const syncing: ReadFailure = {
      code: "replica_syncing",
      hint: "objects · 3/5 objects · 60% (12.0 MiB / 20.0 MiB)",
      syncProgress: {
        step: "objects",
        receivedBytes: 12 * 1024 * 1024,
        totalBytes: 20 * 1024 * 1024,
        receivedObjects: 3,
        totalObjects: 5,
        updatedAt: AT,
      },
    };
    const container = await mountApp({ summary: syncing, tasks: syncing });
    const panel = statusPanel(container);
    expect(panel.querySelector('[data-testid="ledger-syncing-state"]')).not.toBeNull();
    expect(panel.querySelector('[data-testid="task-error-state"]')).toBeNull();
    expect(panel.textContent).not.toContain("台账桥读取失败");
    expect(panel.textContent).toContain("初始副本同步 60%");
    expect(panel.textContent).toContain("大对象分片传输");
    expect(panel.querySelector('[data-testid="ledger-sync-progress"]')?.getAttribute("aria-valuenow")).toBe("60");

    const mainCard = container.querySelector('[data-testid="workspace-replica-syncing"]') as HTMLElement;
    expect(mainCard).not.toBeNull();
    expect(mainCard.textContent).toContain("正在同步初始台账副本");
    expect(mainCard.textContent).toContain("60%");
    expect(mainCard.textContent).toContain("3 / 5");
    expect(mainCard.textContent).toContain("12.0 MiB / 20.0 MiB");
    expect(
      mainCard.querySelector('[data-testid="workspace-replica-sync-progress"]')?.getAttribute("aria-valuenow"),
    ).toBe("60");
  });

  it("automatically recovers workspace summary and leaves syncing state when tasksQuery probe observes an activated replica cut", async () => {
    const syncing: ReadFailure = {
      code: "replica_syncing",
      hint: "installing · 100% (20.0 MiB / 20.0 MiB)",
      syncProgress: {
        step: "installing",
        receivedBytes: 20 * 1024 * 1024,
        totalBytes: 20 * 1024 * 1024,
        updatedAt: AT,
      },
    };
    let activated = false;
    let summaryReads = 0;
    const bridge: Record<string, (payload?: Record<string, unknown> | null) => Promise<unknown>> = {
      getSystemStatus: async () => ({
        schema: "gui-system-status/v1",
        ok: true,
        observedAt: AT,
        daemon: {
          daemonId: "daemon-probe",
          pid: 1,
          startedAt: AT,
          protocolVersion: { major: 1, minor: 0 },
          uptimeMs: 1,
          endpoint: "sock",
          build: { version: "probe", commitSha: null },
          activeControl: null,
        },
        repos: [
          {
            repoId: REPO_ID,
            displayName: "Probe",
            canonicalRoot: "/tmp/probe",
            authoredBranch: "main",
            registrationState: "enabled",
            mode: "remote-edge",
            connectionId: "edge-1",
            cellState: "attached",
            generation: 1,
            queueDepth: 0,
            lockState: "not_applicable",
            recoveryMs: null,
            lastError: null,
            unavailableReason: null,
          },
        ],
      }),
      getTasks: async () =>
        activated
          ? {
              ok: true,
              status: "ready",
              rows: [],
              invalidRows: [],
              watermark: 1_000,
              sourceRevision: 1_000,
              warnings: [],
            }
          : readFailure(syncing),
      getWorkspaceSummary: async () => {
        summaryReads += 1;
        if (!activated) return readFailure(syncing);
        return {
          schema: "daemon.workspace-summary/v1",
          ok: true,
          status: "ready",
          tasks: { lastChangedAt: null, total: 0, byStatus: {} },
          decisions: {
            total: 0,
            inboxCount: 0,
            byState: { proposed: 0, in_effect: 0, rejected: 0, deferred: 0, superseded: 0, outcome_retired: 0 },
            groups: [
              { id: "proposed", states: ["proposed"], count: 0, decisionIds: [] },
              { id: "in_effect", states: ["in_effect"], count: 0, decisionIds: [] },
              { id: "rejected", states: ["rejected"], count: 0, decisionIds: [] },
              { id: "deferred", states: ["deferred"], count: 0, decisionIds: [] },
              { id: "retired", states: ["superseded", "outcome_retired"], count: 0, decisionIds: [] },
            ],
          },
          watermark: 1_000,
          sourceRevision: 1_000,
          warnings: [],
        };
      },
      getWorkIndex: async () => ({
        ok: true,
        status: "ready",
        works: [],
        tasksByWork: {},
        watermark: 1_000,
        sourceRevision: 1_000,
        warnings: [],
      }),
      getAgenda: async () =>
        activated
          ? {
              ok: true,
              status: "ready",
              inFlight: [],
              pinnedEntities: [],
              pinnedEntityOverflow: 0,
              awaitingRestart: [],
              awaitingRework: [],
              awaitingAdjudication: [],
              underReview: [],
              awaitingYou: [],
              answeredForYou: [],
              decisionReviewInProgress: [],
              awaitingDecisionReview: [],
              awaitingDecision: [],
              waitingOnOthers: [],
              dispatchable: [],
              summary: "",
              page: { sourceLimit: 100, cursor: null, nextCursor: null },
              watermark: 1_000,
              sourceRevision: 1_000,
              warnings: [],
            }
          : readFailure(syncing),
    };
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: mockRpcBridge(
        new Proxy(bridge, {
          get(target, method: string) {
            if (method in target) return target[method];
            return async () => ({ ok: true });
          },
        }),
        {
          "daemon.gui.system.read": "getSystemStatus",
          "repo.tasks.list": "getTasks",
          "repo.works.index": "getWorkIndex",
          "repo.workspace.summary.read": "getWorkspaceSummary",
          "repo.agenda.read": "getAgenda",
        },
      ),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(App)));
    });
    for (let turn = 0; turn < 8; turn += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    expect(container.querySelector('[data-testid="workspace-replica-syncing"]')).not.toBeNull();
    expect(statusPanel(container).querySelector('[data-testid="ledger-syncing-state"]')).not.toBeNull();
    const initialSummaryReads = summaryReads;

    // 模拟边缘节点 current.json 激活后,仅 tasksQuery 周期探针重取成功(不手工重取 workspaceSummary)。
    activated = true;
    await act(async () => {
      await client.refetchQueries({ queryKey: ["tasks", REPO_ID, "list"] });
    });
    for (let turn = 0; turn < 8; turn += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    expect(summaryReads).toBeGreaterThan(initialSummaryReads);
    expect(container.querySelector('[data-testid="workspace-replica-syncing"]')).toBeNull();
    expect(statusPanel(container).querySelector('[data-testid="ledger-syncing-state"]')).toBeNull();
    expect(statusPanel(container).querySelector('[data-testid="task-error-state"]')).toBeNull();
  });

  it("recovers workspace summary after switching repositories when a pre-activation replica_syncing summary resolves after tasksQuery cut hydration", async () => {
    const syncing: ReadFailure = {
      code: "replica_syncing",
      hint: "projecting · 100% (20.0 MiB / 20.0 MiB)",
      syncProgress: {
        step: "projecting",
        receivedBytes: 20 * 1024 * 1024,
        totalBytes: 20 * 1024 * 1024,
        updatedAt: AT,
      },
    };
    let currentPhase: "repo-a" | "edge-b" = "repo-a";
    let edgeSummaryCalls = 0;
    let resolveInFlightEdgeSummary: ((value: unknown) => void) | null = null;
    const readySummary = (rev: number) => ({
      schema: "daemon.workspace-summary/v1",
      ok: true,
      status: "ready",
      tasks: { lastChangedAt: null, total: 0, byStatus: {} },
      decisions: {
        total: 0,
        inboxCount: 0,
        byState: { proposed: 0, in_effect: 0, rejected: 0, deferred: 0, superseded: 0, outcome_retired: 0 },
        groups: [
          { id: "proposed", states: ["proposed"], count: 0, decisionIds: [] },
          { id: "in_effect", states: ["in_effect"], count: 0, decisionIds: [] },
          { id: "rejected", states: ["rejected"], count: 0, decisionIds: [] },
          { id: "deferred", states: ["deferred"], count: 0, decisionIds: [] },
          { id: "retired", states: ["superseded", "outcome_retired"], count: 0, decisionIds: [] },
        ],
      },
      watermark: rev,
      sourceRevision: rev,
      warnings: [],
    });
    const bridge: Record<string, (payload?: Record<string, unknown> | null) => Promise<unknown>> = {
      getSystemStatus: async () => ({
        schema: "gui-system-status/v1",
        ok: true,
        observedAt: AT,
        daemon: {
          daemonId: "daemon-probe",
          pid: 1,
          startedAt: AT,
          protocolVersion: { major: 1, minor: 0 },
          uptimeMs: 1,
          endpoint: "sock",
          build: { version: "probe", commitSha: null },
          activeControl: null,
        },
        repos:
          currentPhase === "repo-a"
            ? [
                {
                  repoId: "repo-a",
                  displayName: "Repo A",
                  canonicalRoot: "/tmp/repo-a",
                  authoredBranch: "main",
                  registrationState: "enabled",
                  mode: "local",
                  connectionId: "local",
                  cellState: "attached",
                  generation: 1,
                  queueDepth: 0,
                  lockState: "not_applicable",
                  recoveryMs: null,
                  lastError: null,
                  unavailableReason: null,
                },
              ]
            : [
                {
                  repoId: REPO_ID,
                  displayName: "Edge B",
                  canonicalRoot: "/tmp/edge-b",
                  authoredBranch: "main",
                  registrationState: "enabled",
                  mode: "remote-edge",
                  connectionId: "edge-1",
                  cellState: "attached",
                  generation: 1,
                  queueDepth: 0,
                  lockState: "not_applicable",
                  recoveryMs: null,
                  lastError: null,
                  unavailableReason: null,
                },
              ],
      }),
      getTasks: async (payload) => {
        const rev = payload?.repoId === "repo-a" ? 1 : 1_000;
        return {
          ok: true,
          status: "ready",
          rows: [],
          invalidRows: [],
          watermark: rev,
          sourceRevision: rev,
          warnings: [],
        };
      },
      getWorkspaceSummary: async (payload) => {
        if (payload?.repoId === "repo-a") return readySummary(1);
        edgeSummaryCalls += 1;
        if (edgeSummaryCalls === 1) {
          return new Promise((resolve) => {
            resolveInFlightEdgeSummary = resolve;
          });
        }
        return readySummary(1_000);
      },
      getWorkIndex: async (payload) => {
        const rev = payload?.repoId === "repo-a" ? 1 : 1_000;
        return {
          ok: true,
          status: "ready",
          works: [],
          tasksByWork: {},
          watermark: rev,
          sourceRevision: rev,
          warnings: [],
        };
      },
      getAgenda: async (payload) => {
        const rev = payload?.repoId === "repo-a" ? 1 : 1_000;
        return {
          ok: true,
          status: "ready",
          inFlight: [],
          pinnedEntities: [],
          pinnedEntityOverflow: 0,
          awaitingRestart: [],
          awaitingRework: [],
          awaitingAdjudication: [],
          underReview: [],
          awaitingYou: [],
          answeredForYou: [],
          decisionReviewInProgress: [],
          awaitingDecisionReview: [],
          awaitingDecision: [],
          waitingOnOthers: [],
          dispatchable: [],
          summary: "",
          page: { sourceLimit: 100, cursor: null, nextCursor: null },
          watermark: rev,
          sourceRevision: rev,
          warnings: [],
        };
      },
    };
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: mockRpcBridge(
        new Proxy(bridge, {
          get(target, method: string) {
            if (method in target) return target[method];
            return async () => ({ ok: true });
          },
        }),
        {
          "daemon.gui.system.read": "getSystemStatus",
          "repo.tasks.list": "getTasks",
          "repo.works.index": "getWorkIndex",
          "repo.workspace.summary.read": "getWorkspaceSummary",
          "repo.agenda.read": "getAgenda",
        },
      ),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(App)));
    });
    for (let turn = 0; turn < 8; turn += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    // 切到边缘仓 B:tasksQuery 立即返回已激活的 cut 1000,而首条 getWorkspaceSummary 仍在途。
    currentPhase = "edge-b";
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["system"] });
    });
    for (let turn = 0; turn < 8; turn += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    expect(edgeSummaryCalls).toBe(1);
    expect(resolveInFlightEdgeSummary).not.toBeNull();

    // 首条在途 getWorkspaceSummary 晚于 tasksQuery 落定为发布前的 replica_syncing,应自动补拉第 2 次并退出同步态。
    await act(async () => {
      resolveInFlightEdgeSummary!(readFailure(syncing));
    });
    for (let turn = 0; turn < 10; turn += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    expect(edgeSummaryCalls).toBe(2);
    expect(container.querySelector('[data-testid="workspace-replica-syncing"]')).toBeNull();
    expect(statusPanel(container).querySelector('[data-testid="ledger-syncing-state"]')).toBeNull();
    expect(statusPanel(container).querySelector('[data-testid="task-error-state"]')).toBeNull();
  });

  it("renders identity-unavailable instead of sign-in banner when OIDC renewal is transiently unreachable", async () => {
    const hint = "Keycloak could not be reached to renew the session.";
    const authChanged = [];
    const onAuthChanged = () => authChanged.push(true);
    window.addEventListener("harness-auth-changed", onAuthChanged);
    try {
      const container = await mountApp({
        summary: { code: "oidc_session_unavailable", hint },
        tasks: { code: "oidc_session_unavailable", hint },
      });
      const readState = container.querySelector('[data-testid="repository-read-state"]');
      expect(readState?.getAttribute("data-state")).toBe("identity-unavailable");
      expect(container.querySelector('[data-testid="repository-read-sign-in"]')).toBeNull();
      expect(container.textContent).toContain("认证服务暂时不可达");
      expect(container.textContent).not.toContain("会话已结束或无法再用当前凭据读取台账");
      expect(authChanged).toHaveLength(0);
    } finally {
      window.removeEventListener("harness-auth-changed", onAuthChanged);
    }
  });
});
