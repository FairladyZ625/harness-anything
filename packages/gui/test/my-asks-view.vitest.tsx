// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { harnessClient } from "../src/renderer/api-client.ts";
import { MyAsksView } from "../src/renderer/views/my-asks/MyAsksView.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { WorkBriefsRead } from "../src/api/renderer-dto.ts";

/** daemon 推导的切面样例:顺序即读面交付顺序(等你 > 卡住 > 在做 > 状态不明 > 已完成)。 */
const briefs: WorkBriefsRead = {
  schema: "daemon.work-briefs/v1",
  ok: true,
  status: "ready",
  watermark: 9,
  sourceRevision: 9,
  warnings: [],
  briefs: [
    {
      taskId: "task_waiting",
      title: "桌面 App 一体化分发",
      bucket: "waiting",
      lastActivityAt: "2026-10-17T19:46:47.183Z",
      deliveredAt: null,
      sentenceParts: [
        { kind: "ask", title: "签名证书", askKind: "question" },
        { kind: "executing", title: "首次启动一体化" },
      ],
      asks: [
        {
          relationId: "rel_1",
          relationRevision: 3,
          sourceRef: "task/task_leaf",
          title: "签名证书",
          status: "active",
          personId: "person_zeyu",
          askKind: "question",
          question: "签名卡在等你建 Apple 证书",
          askedAt: "2026-10-17T00:00:00.000Z",
          askedBy: "agent:ceo",
        },
      ],
      openTasks: [
        { taskId: "task_leaf", title: "首次启动一体化", status: "active", updatedAt: "2026-10-17T19:00:00.000Z" },
      ],
      deliveredTasks: [],
      pullRequests: [
        {
          taskId: "task_leaf",
          branch: "task_task_leaf",
          prNumber: 3701,
          pass: true,
          occurredAt: "2026-10-17T10:00:00.000Z",
        },
      ],
    },
    {
      taskId: "task_stuck",
      title: "边缘自助接入",
      bucket: "stuck",
      lastActivityAt: "2026-10-17T16:27:33.078Z",
      deliveredAt: null,
      sentenceParts: [
        { kind: "blocked", title: "邀请链接过期" },
        { kind: "executing", title: "登录即加入" },
      ],
      asks: [],
      openTasks: [
        { taskId: "task_stuck_leaf", title: "邀请链接过期", status: "blocked", updatedAt: "2026-10-17T16:00:00.000Z" },
      ],
      deliveredTasks: [],
      pullRequests: [],
    },
    {
      taskId: "task_running",
      title: "编排器持续优化",
      bucket: "running",
      lastActivityAt: "2026-10-17T19:42:24.288Z",
      deliveredAt: null,
      sentenceParts: [{ kind: "executing", title: "调度回路压测" }],
      asks: [],
      openTasks: [
        { taskId: "task_running_leaf", title: "调度回路压测", status: "active", updatedAt: "2026-10-17T19:00:00.000Z" },
      ],
      deliveredTasks: [],
      pullRequests: [],
    },
    {
      taskId: "task_unclear",
      title: "命令面逐步退役",
      bucket: "unclear",
      lastActivityAt: "2026-10-17T16:19:03.878Z",
      deliveredAt: null,
      sentenceParts: [{ kind: "planned" }],
      asks: [],
      openTasks: [
        { taskId: "task_unclear_leaf", title: "盘点命令面", status: "planned", updatedAt: "2026-10-17T16:00:00.000Z" },
      ],
      deliveredTasks: [],
      pullRequests: [],
    },
    {
      taskId: "task_done",
      title: "GUI 视觉规范 v2",
      bucket: "done",
      lastActivityAt: "2026-10-14T00:20:07.374Z",
      deliveredAt: "2026-10-16T12:00:00.000Z",
      sentenceParts: [{ kind: "delivered", title: "可读性基线" }],
      asks: [],
      openTasks: [],
      deliveredTasks: [
        { taskId: "task_done_leaf", title: "可读性基线", status: "done", updatedAt: "2026-10-16T12:00:00.000Z" },
      ],
      pullRequests: [],
    },
  ],
};

const mounted: { readonly root: Root; readonly client: QueryClient; readonly container: HTMLDivElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(async () => {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mountView() {
  const opened: string[] = [],
    container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mounted.push({ root, client, container });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MyAsksView, {
          repoId: "repo",
          onOpenTask: (taskId) => opened.push(taskId),
          onNavigateEntity: () => undefined,
        }),
      ),
    );
  });
  return { opened };
}

/** react-query 的取数落在微任务与下一个宏任务里;逐轮 act 冲干净再断言。 */
async function flushQueries() {
  for (let round = 0; round < 4; round += 1)
    await act(async () => {
      await Promise.resolve();
    });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function textOf(body: Element): string {
  return body.textContent ?? "";
}

describe("my asks view (redesign zone, dec_C612E69B7C7E3480A5F9D2CAD3)", () => {
  it("renders one row per ask in daemon order with bucket, title and the localized sentence", async () => {
    vi.spyOn(harnessClient, "getWorkBriefs").mockResolvedValue(briefs);
    mountView();
    await flushQueries();
    const rows = document.body.querySelectorAll("[data-testid^='my-asks-row-']");
    expect(rows.length).toBe(4);
    const text = textOf(document.body);
    // 首屏三样:状态、标题、一句人话;不出现 ID、revision 与计数统计。
    expect(text).toContain("桌面 App 一体化分发");
    expect(text).toContain("「签名证书」在等你答复；「首次启动一体化」在做");
    expect(text).toContain("「邀请链接过期」卡住了；「登录即加入」在做");
    expect(text).toContain("「调度回路压测」在做");
    expect(text).toContain("还剩没开工的事");
    expect(text).not.toContain("task_waiting");
    expect(text).not.toContain("sourceRevision");
  });

  it("folds delivered works behind a toggle and only expands on demand", async () => {
    vi.spyOn(harnessClient, "getWorkBriefs").mockResolvedValue(briefs);
    mountView();
    await flushQueries();
    expect(document.body.querySelector("[data-testid='my-asks-row-task_done']")).toBeNull();
    await act(async () => {
      document.body
        .querySelector("[data-testid='my-asks-done-toggle']")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const done = document.body.querySelector("[data-testid='my-asks-row-task_done']");
    expect(done?.textContent).toContain("GUI 视觉规范 v2");
  });

  it("opens a single-level drawer with the ask, its tasks and the branch pull request", async () => {
    vi.spyOn(harnessClient, "getWorkBriefs").mockResolvedValue(briefs);
    const view = mountView();
    await flushQueries();
    await act(async () => {
      document.body
        .querySelector("[data-testid='my-asks-row-task_waiting'] button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const drawer = document.body.querySelector("[data-testid='my-asks-drawer']");
    expect(drawer?.textContent).toContain("签名卡在等你建 Apple 证书");
    expect(drawer?.textContent).toContain("首次启动一体化");
    expect(drawer?.textContent).toContain("PR #3701");
    // 抽屉的任务行点击走完整任务详情。
    const openTask = [...drawer!.querySelectorAll("button")].find((button) => button.textContent === "打开任务详情");
    await act(async () => {
      openTask!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(view.opened).toContain("task_leaf");
  });

  it("shows the honest loading and failure states instead of inventing rows", async () => {
    vi.spyOn(harnessClient, "getWorkBriefs").mockResolvedValue(briefs);
    mountView();
    expect(textOf(document.body)).toContain("正在读取…");
    await flushQueries();
    expect(textOf(document.body)).toContain("桌面 App 一体化分发");
    vi.spyOn(harnessClient, "getWorkBriefs").mockRejectedValue(new Error("bridge down"));
    mountView();
    await flushQueries();
    expect(textOf(document.body)).toContain("读取失败：bridge down");
  });
});
