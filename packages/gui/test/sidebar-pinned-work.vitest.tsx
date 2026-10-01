// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, it, vi } from "vitest";
import { AppSidebar } from "../src/renderer/components/AppSidebar.tsx";
import { taskQueryKeys } from "../src/renderer/task-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { WorkIndexRead } from "../src/api/renderer-dto.ts";

// 侧栏的「置顶工作」只列置顶的工作根(daemon 工作索引 repo.works.index 判据),
// 其余置顶任务的去处是总览置顶区。业主 2026-10-01:只有工作能单独拎出来,限 5 个、
// 块内滚动不裁半行;取消置顶是无边框小图标,悬停/键盘聚焦时出现(评审第 6 条:
// 此前一列带边框的方块是全页最抢眼的重复图形)。

const WORKS: WorkIndexRead = {
  schema: "daemon.work-index/v1",
  ok: true,
  status: "ready",
  works: [
    {
      taskId: "task_aaa",
      title: "第一条置顶",
      status: "active",
      root: "declared",
      parentTaskId: null,
      taskCount: 2,
      counts: { done: 1, executing: 1, pending: 0, blocked: 0, planned: 0, cancelled: 0 },
      lastActivityAt: "2026-10-01T00:00:00.000Z",
      memberTaskIds: ["task_bbb"],
    },
    {
      taskId: "task_root2",
      title: "第二个工作根",
      status: "planned",
      root: "declared",
      parentTaskId: null,
      taskCount: 1,
      counts: { done: 0, executing: 0, pending: 1, blocked: 0, planned: 0, cancelled: 0 },
      lastActivityAt: "2026-10-01T00:00:00.000Z",
      memberTaskIds: [],
    },
  ],
  watermark: 7,
  sourceRevision: 7,
  warnings: [],
};

beforeAll(() => {
  setActiveLocale("zh-CN");
});

function mountSidebar(
  pinnedWork: readonly { readonly taskId: string; readonly title: string }[],
  works: WorkIndexRead = WORKS,
) {
  const onUnpinWork = vi.fn(),
    onOpenPinned = vi.fn(),
    host = document.createElement("div"),
    root = createRoot(host),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 工作索引走 App 已挂载的同一查询键:预置缓存,侧栏不依赖 daemon 就能判工作根。
  client.setQueryData(taskQueryKeys.works("repo"), works);
  return {
    onUnpinWork,
    onOpenPinned,
    host,
    render: async () =>
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <AppSidebar
              project={{ name: "harness-anything", preset: "standard-task" } as never}
              repos={[]}
              activeRepoId="repo"
              view="home"
              hasSelection={false}
              poolBadgeCount={undefined}
              projectSwitcherOpen={false}
              onProjectSwitcherToggle={() => {}}
              onOpenProject={() => {}}
              onOpenProjectManager={() => {}}
              onNavigate={() => {}}
              pinnedWork={pinnedWork}
              onOpenPinned={onOpenPinned}
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
      ),
    unmount: () => {
      act(() => root.unmount());
      client.clear();
    },
  };
}

it("置顶块只列工作根:普通任务不进侧栏,标题计数只数工作", async () => {
  const { host, render, unmount } = mountSidebar([
    // bbb 是 aaa 工作下的成员任务,ccc 不属于任何工作:置顶了也不进侧栏,
    // 它们的去处是总览置顶区。
    { taskId: "task_bbb", title: "工作里的普通任务" },
    { taskId: "task_aaa", title: "第一条置顶" },
    { taskId: "task_ccc", title: "不是任何工作的任务" },
    { taskId: "task_root2", title: "第二个工作根" },
  ]);
  await render();
  const list = host.querySelector('[data-testid="sidebar-pinned-list"]')!;
  expect(list.textContent).toContain("第一条置顶");
  expect(list.textContent).toContain("第二个工作根");
  expect(list.textContent).not.toContain("工作里的普通任务");
  expect(list.textContent).not.toContain("不是任何工作的任务");
  // 计数只数工作根(2),不是置顶总数(3)。
  const toggle = host.querySelector<HTMLButtonElement>('[data-testid="sidebar-pinned-toggle"]')!;
  expect(toggle.textContent).toContain("置顶工作");
  expect(toggle.textContent).toContain("2");
  unmount();
});

it("没有置顶的工作时整块不出现(空了就消失)", async () => {
  const { host, render, unmount } = mountSidebar([{ taskId: "task_bbb", title: "工作里的普通任务" }]);
  await render();
  expect(host.querySelector('[data-testid="app-sidebar-pinned"]')).toBeNull();
  expect(host.querySelector('[data-testid="sidebar-pinned-work"]')).toBeNull();
  unmount();
});

it("限高按整行取整:行高与 5 行上限同源,块内滚动不裁半行", async () => {
  const six: { readonly taskId: string; readonly title: string }[] = [
    { taskId: "task_aaa", title: "第一条置顶" },
    { taskId: "task_w1", title: "第二条" },
    { taskId: "task_w2", title: "第三条" },
    { taskId: "task_w3", title: "第四条" },
    { taskId: "task_w4", title: "第五条" },
    { taskId: "task_w5", title: "第六条" },
  ];
  const { host, render, unmount } = mountSidebar(six, {
    ...WORKS,
    works: [
      ...WORKS.works,
      ...six
        .filter(({ taskId }) => taskId !== "task_aaa")
        .map(({ taskId, title }): WorkIndexRead["works"][number] => ({
          ...WORKS.works[0]!,
          taskId,
          title,
          memberTaskIds: [],
        })),
    ],
  });
  await render();
  const block = host.querySelector('[data-testid="app-sidebar-pinned"]')!,
    list = host.querySelector('[data-testid="sidebar-pinned-list"]')!;
  // 行高是块上的一份定义:上限 = 5 × 同一个变量,行高变了上限跟着变,永远整行。
  expect(block.className).toContain("[--pinned-row:");
  expect(list.className).toContain("max-h-[calc(var(--pinned-row)*5)]");
  expect(list.className).toContain("overflow-y-auto");
  expect(list.className).toContain("snap-y");
  // 滚动停在行界:每行固定行高 + snap 对齐(行是列表的直接子节点)。
  const rows = list.children;
  expect(rows).toHaveLength(6);
  expect(rows[0]!.className).toContain("h-[var(--pinned-row)]");
  expect(rows[0]!.className).toContain("snap-start");
  // 块固定在头部与导航之间,不随导航滚动(shrink-0),不再按侧栏比例封顶。
  expect(block.className).toContain("shrink-0");
  expect(block.className).not.toContain("max-h-[30%]");
  unmount();
});

it("取消置顶是无边框小图标,悬停或键盘聚焦才出现;点击用该 taskId 调 onUnpinWork", async () => {
  const { host, render, unmount, onUnpinWork, onOpenPinned } = mountSidebar([
    { taskId: "task_aaa", title: "第一条置顶" },
  ]);
  await render();
  const unpin = host.querySelector<HTMLButtonElement>('[data-testid^="sidebar-unpin-"]')!;
  expect(unpin).not.toBeNull();
  expect(unpin.textContent).toBe("");
  expect(unpin.querySelector("svg")).not.toBeNull();
  // 无边框:此前一列带边框的取消按钮是全页最抢眼的重复图形。
  expect(unpin.className).not.toContain("border-border");
  // 平时不占视觉,悬停或键盘聚焦(group 内聚焦)时出现。
  expect(unpin.className).toContain("opacity-0");
  expect(unpin.className).toContain("group-hover:opacity-100");
  expect(unpin.className).toContain("group-focus-within:opacity-100");
  expect(unpin.getAttribute("aria-label")).toBe("解除置顶:第一条置顶");

  await act(async () => unpin.click());
  expect(onUnpinWork).toHaveBeenCalledWith("task_aaa");
  // 解除置顶不顺带打开该工作。
  expect(onOpenPinned).not.toHaveBeenCalled();
  unmount();
});

it("标题行可收起:收起后列表不占位", async () => {
  const { host, render, unmount } = mountSidebar([{ taskId: "task_aaa", title: "第一条置顶" }]);
  await render();
  const toggle = host.querySelector<HTMLButtonElement>('[data-testid="sidebar-pinned-toggle"]')!;
  await act(async () => toggle.click());
  expect(host.querySelector('[data-testid="sidebar-pinned-list"]')!.className).toContain("hidden");
  unmount();
});
