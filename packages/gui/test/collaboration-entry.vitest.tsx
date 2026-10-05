// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, it, vi } from "vitest";
import { AppSidebar } from "../src/renderer/components/AppSidebar.tsx";
import { taskQueryKeys } from "../src/renderer/task-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { SystemRepoRow } from "../src/renderer/api-client.ts";
import type { WorkIndexRead } from "../src/api/renderer-dto.ts";

// 协作入口的解封(task_775fc98c,业主 2026-10-05):本地仓也是舰队中心,侧栏
// 协作导航不再按 activeRepo.mode === "local" 过滤;home(未选中仓)没有仓库视角,
// 入口仍然不出现。这里用真实 AppSidebar 断言入口存在且可点击进入。

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

const EMPTY_WORKS: WorkIndexRead = {
  schema: "daemon.work-index/v1",
  ok: true,
  status: "ready",
  works: [],
  watermark: 0,
  sourceRevision: 0,
  warnings: [],
};

function repo(repoId: string, mode: SystemRepoRow["mode"]): SystemRepoRow {
  return {
    repoId,
    displayName: repoId,
    canonicalRoot: `/tmp/${repoId}`,
    authoredBranch: "main",
    registrationState: "enabled",
    mode,
    connectionId: "local",
    cellState: "attached",
    generation: 1,
    queueDepth: 0,
    lockState: "not_applicable",
    recoveryMs: null,
    lastError: null,
    unavailableReason: null,
  };
}

function mountSidebar(activeRepoId: string | null, repos: readonly SystemRepoRow[]) {
  const onNavigate = vi.fn(),
    host = document.createElement("div"),
    root = createRoot(host),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 工作索引走 App 已挂载的同一查询键:预置空索引,侧栏不依赖 daemon。
  if (activeRepoId !== null) client.setQueryData(taskQueryKeys.works(activeRepoId), EMPTY_WORKS);
  return {
    onNavigate,
    host,
    render: async () =>
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <AppSidebar
              project={{ name: "harness-anything", preset: "standard-task" } as never}
              repos={repos}
              activeRepoId={activeRepoId}
              view="overview"
              hasSelection={false}
              poolBadgeCount={undefined}
              projectSwitcherOpen={false}
              onProjectSwitcherToggle={() => {}}
              onOpenProject={() => {}}
              onOpenProjectManager={() => {}}
              onNavigate={onNavigate}
              pinnedWork={[]}
              onOpenPinned={() => {}}
              onUnpinWork={() => {}}
              ledgerStatus={{
                revision: 1,
                refreshedAgoSec: 0,
                connected: true,
                refreshing: false,
                empty: false,
                error: null,
              }}
              onRefreshLedger={() => {}}
              health={
                {
                  daemon: { state: "responsive", observedAgeSec: 0, uptimeMs: 0 },
                  cell: { state: "loaded", queueDepth: 0, problem: null },
                  projection: { lag: 0, status: "ready" },
                  ledgerChange: { at: null, ageSec: null },
                } as never
              }
              onOpenSystem={() => {}}
            />
          </QueryClientProvider>,
        ),
      ),
    unmount: () => {
      act(() => root.unmount());
      client.clear();
    },
  };
}

function collaborationButton(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("nav button")].find(
    (button) => button.getAttribute("title") === "协作",
  );
}

it("本地仓(mode=local)不再过滤协作入口:入口存在,点击进入 collaboration", async () => {
  const { host, render, unmount, onNavigate } = mountSidebar("repo-local", [repo("repo-local", "local")]);
  await render();
  const entry = collaborationButton(host);
  expect(entry).toBeDefined();
  await act(async () => entry!.click());
  expect(onNavigate).toHaveBeenCalledWith("collaboration");
  unmount();
});

it("远端中心仓入口照常存在(解封不回归既有远端行为)", async () => {
  const { host, render, unmount } = mountSidebar("repo-center", [repo("repo-center", "remote-center")]);
  await render();
  expect(collaborationButton(host)).toBeDefined();
  unmount();
});

it("未选中仓(home)没有仓库视角,协作入口仍不出现", async () => {
  const { host, render, unmount } = mountSidebar(null, [repo("repo-local", "local")]);
  await render();
  expect(collaborationButton(host)).toBeUndefined();
  unmount();
});
