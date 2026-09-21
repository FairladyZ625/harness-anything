// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { AppSidebar } from "../src/renderer/components/AppSidebar.tsx";

// 侧栏的「置顶工作」是唯一展示置顶集的地方。业主 2026-09-21 报告他找不到取消置顶的入口:
// 当时这一段每项只是一个打开按钮,解除 pin 只存在于关系图页的抽屉里。这条测试守住入口本身。
it("每个置顶项都带解除置顶入口,点击用该 task 调 onUnpinWork", async () => {
  const onUnpinWork = vi.fn(),
    onOpenWorkspace = vi.fn(),
    host = document.createElement("div"),
    root = createRoot(host),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AppSidebar
          project={{ name: "harness-anything", preset: "standard-task" } as never}
          repos={[]}
          activeRepoId={null}
          view="home"
          hasSelection={false}
          poolBadgeCount={undefined}
          projectSwitcherOpen={false}
          onProjectSwitcherToggle={() => {}}
          onOpenProject={() => {}}
          onOpenProjectManager={() => {}}
          onNavigate={() => {}}
          pinnedWork={[
            { taskId: "task_aaa", title: "第一条置顶" },
            { taskId: "task_bbb", title: "第二条置顶" },
          ]}
          onOpenWorkspace={onOpenWorkspace}
          onUnpinWork={onUnpinWork}
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
  );

  const unpins = host.querySelectorAll<HTMLButtonElement>('[data-testid^="sidebar-unpin-"]');
  expect(unpins).toHaveLength(2);
  // 入口不靠 hover 才出现:业主的抱怨就是找不到它。
  expect(unpins[0]!.className).not.toContain("opacity-0");
  expect(unpins[0]!.getAttribute("aria-label")).toBe("解除置顶:第一条置顶");

  await act(async () => unpins[1]!.click());
  expect(onUnpinWork).toHaveBeenCalledWith("task_bbb");
  // 解除置顶不应顺带打开该工作。
  expect(onOpenWorkspace).not.toHaveBeenCalled();

  act(() => root.unmount());
  client.clear();
});
