// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SystemView, observeRouteRepoId } from "../src/renderer/views/SystemView.tsx";
import { harnessClient } from "../src/renderer/api-client.ts";
import type { ObserveTailRead } from "../src/api/renderer-dto.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 系统 tab 的常驻守护进程日志面板:
 *  - 挂载即读,不需要先选仓、不需要进二级页;来源可在 lifecycle ↔ conn 之间切;
 *  - `observe.tail` 是 requiresRepo 的读面,零 attached 仓时显式说明为何读不到,
 *    不以空列表冒充正常;
 *  - 复用 DaemonTailPane 的同一条轮询循环与暂停语义,不另起第二套机制。
 * 实时性不用裸 sleep 等,由 mock 的下一页返回驱动断言。
 */

const REPO_ID = "sys-probe",
  AT = "2026-09-04T05:00:00.000Z",
  mounted: { root: Root; container: HTMLElement }[] = [];

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
  vi.restoreAllMocks();
});

function repoRow(overrides: Record<string, unknown> = {}) {
  return {
    repoId: REPO_ID,
    displayName: "System Probe",
    canonicalRoot: "/tmp/sys-probe",
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
    ...overrides,
  };
}

function seedStatus(client: QueryClient, repos: readonly ReturnType<typeof repoRow>[]): void {
  client.setQueryData(["system", "global", "status"], {
    schema: "gui-system-status/v1",
    ok: true,
    observedAt: AT,
    daemon: {
      daemonId: "default",
      pid: 42,
      startedAt: AT,
      protocolVersion: { major: 1, minor: 0 },
      uptimeMs: 1_000,
      endpoint: "sock",
      build: { version: "sys", commitSha: null },
      activeControl: null,
    },
    repos,
  });
}

function tailPage(kind: "lifecycle" | "daemon-log", event: string): ObserveTailRead {
  return {
    schema: "daemon.observe-tail/v3",
    ok: true,
    repoId: REPO_ID,
    mode: "local",
    kind,
    direction: "history",
    status: "ready",
    items: [
      kind === "lifecycle"
        ? { schema: "daemon-lifecycle/v1", at: AT, daemonId: "default", pid: 42, event }
        : { schema: "daemon-conn-log/v1", at: AT, method: event, ok: false, code: "repo_unavailable", durationMs: 4 },
    ],
    historyCursor: { kind, fileId: "file-sys", offset: 0 },
    liveCursor: { kind, fileId: "file-sys", offset: 96 },
    sourceCursor: { kind, fileId: "file-sys", offset: 96 },
    done: true,
  };
}

/** Records every requested kind so "mounted and already tailing" is an observation, not a wait. */
function mockTail(pages: Partial<Record<string, ObserveTailRead>>): string[] {
  const calls: string[] = [];
  vi.spyOn(harnessClient, "tailObservability").mockImplementation(async (payload) => {
    const { kind, direction } = payload as { readonly kind: string; readonly direction: string };
    calls.push(kind);
    const page = pages[kind] ?? tailPage("lifecycle", "process_start");
    return direction === "follow" ? { ...page, direction: "follow", items: [], done: true } : page;
  });
  return calls;
}

async function mountSystem(repos: readonly ReturnType<typeof repoRow>[]): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedStatus(client, repos);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const element = createElement(SystemView, {
    activeRepoId: REPO_ID,
    onOpenObserve: () => undefined,
    onNavigateEntity: () => undefined,
  });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  for (let settle = 0; settle < 3; settle += 1)
    await act(async () => {
      await Promise.resolve();
    });
  return container;
}

describe("observe.tail 的按仓路由在系统页的取仓口径", () => {
  it("优先借当前仓,当前仓未挂载时借任一已挂载仓", () => {
    const attachedOther = repoRow({ repoId: "other" }),
      warmingCurrent = repoRow({ cellState: "warming" });
    expect(observeRouteRepoId([repoRow()], REPO_ID)).toBe(REPO_ID);
    expect(observeRouteRepoId([warmingCurrent, attachedOther], REPO_ID)).toBe("other");
  });

  it("零 attached 仓时没有可借的路由,返回 null 而不是随便挑一个", () => {
    expect(observeRouteRepoId([repoRow({ cellState: "warming" })], REPO_ID)).toBeNull();
    expect(observeRouteRepoId([repoRow({ cellState: "unavailable" })], null)).toBeNull();
    expect(observeRouteRepoId([], REPO_ID)).toBeNull();
  });
});

describe("系统 tab 的常驻守护进程日志面板", () => {
  it("挂载即在读 lifecycle,无需任何点击,并说明日志只属于本节点", async () => {
    const calls = mockTail({ lifecycle: tailPage("lifecycle", "runtime_spawn") }),
      container = await mountSystem([repoRow()]);
    expect(calls).toContain("lifecycle");
    expect(container.querySelector('[data-testid="system-daemon-logs"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="observe-pane-lifecycle"]')).not.toBeNull();
    const rows = container.querySelectorAll('[data-testid="observe-pane-lifecycle"] [data-testid="observe-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0]!.textContent).toContain("runtime_spawn");
    const scope = container.querySelector('[data-testid="system-daemon-logs-scope"]');
    expect(scope?.textContent).toContain("本节点");
    expect(scope?.textContent).toContain("default");
  });

  it("切到请求来源后发的是 daemon-log kind,行形状随之变成 method + 失败码", async () => {
    const calls = mockTail({
        lifecycle: tailPage("lifecycle", "runtime_spawn"),
        "daemon-log": tailPage("daemon-log", "repo.tasks.list"),
      }),
      container = await mountSystem([repoRow()]);
    expect(calls).not.toContain("daemon-log");
    const connOption = container.querySelector('[data-testid="observe-kind-daemon-log"]') as HTMLButtonElement;
    expect(connOption).not.toBeNull();
    await act(async () => {
      connOption.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let settle = 0; settle < 3; settle += 1)
      await act(async () => {
        await Promise.resolve();
      });
    expect(calls).toContain("daemon-log");
    const row = container.querySelector('[data-testid="observe-pane-daemon-log"] [data-testid="observe-row"]');
    expect(row?.textContent).toContain("repo.tasks.list");
    expect(row?.textContent).toContain("repo_unavailable");
  });

  it("零 attached 仓时说明这条读面按仓路由,而不是显示一个空日志列表", async () => {
    const calls = mockTail({}),
      container = await mountSystem([repoRow({ cellState: "warming" })]);
    const notice = container.querySelector('[data-testid="system-daemon-logs-unavailable"]');
    expect(notice?.textContent).toContain("按仓库路由");
    expect(notice?.textContent).toContain("这不是");
    expect(container.querySelector('[data-testid="observe-pane-lifecycle"]')).toBeNull();
    expect(container.querySelector('[data-testid="observe-empty-lifecycle"]')).toBeNull();
    expect(calls).toEqual([]);
  });
});
