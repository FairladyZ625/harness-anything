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

function readFailure(code: string, hint: string) {
  return { ok: false as const, error: { code, hint } };
}

async function mountApp(options: { readonly code: string; readonly hint: string }): Promise<HTMLElement> {
  const bridge: Record<string, (payload?: Record<string, unknown> | null) => Promise<unknown>> = {
    getSystemStatus: async () => ({
      schema: "gui-system-status/v1",
      ok: true,
      observedAt: AT,
      daemon: { uptimeMs: 1 },
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
    getTasks: async () => readFailure(options.code, options.hint),
    getWorkspaceSummary: async () => readFailure(options.code, options.hint),
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
    value: new Proxy(bridge, {
      get(target, method: string) {
        if (method in target) return target[method];
        // 与侧栏无关的读面统一回空成功:断言面不扩到它们。
        return async () => ({ ok: true });
      },
    }),
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
    const container = await mountApp({
      code: "authentication_required",
      hint: "Sign in with the configured identity provider.",
    });
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
    const container = await mountApp({ code: "replica_unavailable", hint });
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
});
