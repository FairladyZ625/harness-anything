// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskRow } from "../src/renderer/model/types.ts";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";
import { TaskPreviewDrawer } from "../src/renderer/components/TaskPreviewDrawer.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task-a",
    title: "Alpha",
    projectId: "p",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    lastKnownAt: "2026-07-09T00:00:00.000Z",
    gates: [],
    docs: [],
    ...projectedTaskFields(overrides.coordinationStatus ?? "active", {
      archived: (overrides.packageDisposition ?? "active") !== "active",
    }),
    ...overrides,
  };
}

const noop = () => undefined;

// 泳道读面(repo.task.dispatches)是预览里唯一的额外读:测试按同一 DTO 形状给桩,
// 不拉起 daemon,也不改组件取数路径。
const { getTaskDispatches } = vi.hoisted(() => ({ getTaskDispatches: vi.fn() }));
// §4 的静态渲染用例不关心泳道:默认给一份空读,别让 react-query 收到 undefined
// (那会在无关用例里打「Query data cannot be undefined」)。
getTaskDispatches.mockResolvedValue({
  ok: true,
  status: "ready",
  taskId: "task-a",
  dispatches: [],
  watermark: 1,
  sourceRevision: 1,
});
vi.mock("../src/renderer/api-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/api-client.ts")>();
  return { ...actual, harnessClient: { ...actual.harnessClient, getTaskDispatches } };
});

const dispatchRow = (patch: Partial<TaskDispatchProjectionRow> = {}): TaskDispatchProjectionRow =>
  ({
    dispatchId: "dispatch-r1",
    taskId: "task-a",
    executionId: "execution-r1",
    runtimeSessionId: "runtime-r1",
    instanceId: "instance-r1",
    attemptGroupId: "attempt-r1",
    attemptIndex: 0,
    provider: { instance: "instance-r1", model: "glm-5.3" },
    classification: null,
    reason: null,
    fallbackState: null,
    nextDispatchId: null,
    providerSessionId: null,
    eventStreamRef: null,
    agentName: "GLM-5.3",
    startedAt: "2026-10-20T10:00:00.000Z",
    endedAt: null,
    outcome: null,
    status: "running",
    ...patch,
  }) as TaskDispatchProjectionRow;

const dispatchRead = (rows: readonly TaskDispatchProjectionRow[]) => ({
  ok: true,
  status: "ready" as const,
  taskId: "task-a",
  dispatches: rows,
  outcome: "unknown" as const,
  exitCode: 0,
  watermark: 1,
  sourceRevision: 1,
});

describe("task preview drawer §4 内容契约", () => {
  const drawerMarkup = (task: TaskRow) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(TaskPreviewDrawer, {
          task,
          tasks: [task],
          relations: [],
          onClose: noop,
          onOpenDetail: noop,
          onPreviewTask: noop,
        }),
      ),
    );

  it("生命周期进度、卡在哪、关键记录都在;标题经 TitleText 拆分", () => {
    const task = makeTask({
      title: "任务预览抽屉:按 §4 重做",
      // 已 submit 后未过的门/缺失文档才是卡点(rework-1);active 未提交不渲染卡在哪。
      coordinationStatus: "in_review",
      gates: [
        { name: "local-check", ok: true },
        { name: "lint", ok: false, detail: "G05 rethrow required" },
      ],
      docs: [
        { path: "closeout.md", title: "收口报告", group: "收口", required: true, present: false, presence: "missing" },
      ],
      events: [
        { projectId: "p", taskId: "task-a", at: "2026-08-23T10:20:00.000Z", summary: "Review approved" },
        { projectId: "p", taskId: "task-a", at: "2026-08-22T09:00:00.000Z", summary: "Execution submitted" },
      ],
      parentTaskId: "task-root",
      workId: "task-root",
      workTitle: "基线升级",
    });
    const markup = drawerMarkup(task);
    // 生命周期:阶段步进条在抽屉正文里(§4),不再是完整详情页专属。
    expect(markup).toContain("Lifecycle");
    // 标题经 TitleText:冒号后补充段染弱。
    expect(markup).toContain('<span class="text-text-faint">:按 §4 重做</span>');
    // 卡在哪:未过的门与缺失必填文档都是有底色的 bad 状态标签行(§3);未映射的
    // 机器 reason 码翻成按状态兜底的人话,原文进 title 提示。
    expect(markup).toContain("Where it is stuck");
    expect(markup).toContain('data-status-tone="bad"');
    expect(markup).toContain("lint");
    expect(markup).toContain("this gate did not pass");
    expect(markup).toContain("收口报告");
    // 关键记录:按天收束,全部事件都在标记里(2026-08-25 完整渲染裁决)。
    expect(markup).toContain("Key records");
    expect(markup.match(/data-day=/gu)).toHaveLength(2);
    expect(markup).toContain("Review approved");
    expect(markup).toContain("Execution submitted");
    // 归属一行:parent 与 work 是实体链接,不是死文本。
    expect(markup).toContain("task-root");
  });

  it("卡在哪只收真正的阻塞:active 未提交不渲染;blocked 依赖与待返工才渲染", () => {
    // active 未提交:提交前的完成门/缺失文档是「完成前还需要」,不是卡点。
    const preSubmit = drawerMarkup(
      makeTask({
        gates: [{ name: "ci", ok: false, status: "missing", detail: "no submitted execution cut" }],
        docs: [
          {
            path: "closeout.md",
            title: "收口报告",
            group: "收口",
            required: true,
            present: false,
            presence: "missing",
          },
        ],
      }),
    );
    expect(preSubmit).not.toContain("Where it is stuck");
    // 已知机器 reason 码也不在一级位置出现(只有 title 提示承载原文)。
    expect(preSubmit).not.toContain("no submitted execution cut");

    const blocked = drawerMarkup(
      makeTask({
        coordinationStatus: "blocked",
        blocking: "blocked",
        blockingLabel: "relations",
        blockers: [
          {
            relationId: "rel-dep",
            kind: "depends-on",
            sourceTaskId: "task-a",
            targetTaskId: "task-upstream",
            rationale: "upstream slice lands first",
          },
        ],
      }),
    );
    expect(blocked).toContain("Where it is stuck");
    expect(blocked).toContain("dependency");
    expect(blocked).toContain("task-upstream");
    expect(blocked).toContain("upstream slice lands first");

    const rework = drawerMarkup(
      makeTask({
        iteration: 2,
        executions: [
          {
            schema: "execution/v1",
            executionId: "exe-1",
            taskId: "task-a",
            nodeId: "implementation",
            iteration: 1,
            state: "changes_requested",
            actor: { principal: { personId: "person-owner" }, executor: null },
            claimedAt: "2026-08-20T09:00:00.000Z",
            submittedAt: "2026-08-21T10:00:00.000Z",
            closedAt: "2026-08-21T12:00:00.000Z",
            submission: {
              completionClaim: "done",
              deliverables: [],
              outputs: [],
              verificationNotes: [],
              knownGaps: [],
              residualRisks: [],
              commitSha: "a".repeat(40),
            },
          },
        ],
      }),
    );
    expect(rework).toContain("returned for rework");
    expect(rework).toContain("the previous submission was returned");
    expect(rework).toContain("iteration 2 awaits a new claim");
  });

  it("无卡点时「卡在哪」整块消失;门禁全过时给一句话,不画大框(§1.5)", () => {
    const markup = drawerMarkup(makeTask({ gates: [{ name: "local-check", ok: true }] }));
    expect(markup).not.toContain("Where it is stuck");
    expect(markup).toContain("1 gate checks passed");
    const empty = drawerMarkup(makeTask());
    expect(empty).not.toContain("卡在哪");
    expect(empty).not.toContain("Key records");
    expect(empty).not.toContain("Associated tasks");
  });
});

describe("task preview 关键记录:引用对象可导航(task 详情同一机制)", () => {
  it("带 recordRef 的编号是原生按钮,点击带出 (taskId, recordRef);整行打开详情不受影响", async () => {
    const onOpenRecord = vi.fn(),
      onOpenDetail = vi.fn();
    const task = makeTask({
      events: [
        {
          projectId: "p",
          taskId: "task-a",
          at: "2026-08-23T09:00:00.000Z",
          kind: "start",
          ref: "execution-w3",
          recordRef: "execution/execution-w3",
          summary: "开始执行",
        },
      ],
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
            createElement(TaskPreviewDrawer, {
              task,
              tasks: [task],
              relations: [],
              onClose: noop,
              onOpenDetail,
              onPreviewTask: noop,
              onOpenRecord,
            }),
          ),
        ),
      );
      const refButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "execution-w3",
      );
      expect(refButton, "关键记录的 execution 编号应渲染为可激活按钮").toBeTruthy();
      await act(async () => {
        refButton!.click();
      });
      expect(onOpenRecord).toHaveBeenCalledTimes(1);
      expect(onOpenRecord).toHaveBeenCalledWith("task-a", "execution/execution-w3");
      // 不给 onOpenRecord 时不造死链接(接线是 App 的职责)。
      expect(onOpenDetail).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe("task preview dismissal", () => {
  it("closes on an outside press, lets the dimmed board keep its clicks, and keeps pin independent", async () => {
    const onClose = vi.fn(),
      onSetPin = vi.fn();
    const task = makeTask();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
            createElement(TaskPreviewDrawer, {
              task,
              tasks: [task],
              relations: [],
              onClose,
              onOpenDetail: noop,
              onPreviewTask: noop,
              onSetPin,
            }),
          ),
        ),
      );
      const backdrop = container.querySelector('[data-testid="drawer-backdrop"]') as HTMLElement;
      // 压暗层不接指针事件:它下面的看板卡照常收到那一次点击,换卡才只需点一次。
      expect(backdrop.className).toContain("pointer-events-none");
      expect((container.querySelector("aside") as HTMLElement).className).toContain("pointer-events-auto");
      const inside = container.querySelector("aside h2") as HTMLElement;
      act(() => {
        inside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        inside.click();
      });
      expect(onClose).not.toHaveBeenCalled();
      const pinToggle = container.querySelector('[data-testid="task-preview-pin-toggle"]') as HTMLElement;
      act(() => {
        pinToggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        pinToggle.click();
      });
      expect(onSetPin).toHaveBeenCalledWith(task, true);
      expect(onClose).not.toHaveBeenCalled();
      // 抽屉外按下 = 关闭(原来的「点中遮罩」判据换成「按下位置不在抽屉里」)。
      const outside = document.createElement("div");
      document.body.append(outside);
      act(() => outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      expect(onClose).toHaveBeenCalledTimes(1);
      outside.remove();
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      expect(onClose).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("ignores outside presses owned by another control: interactive elements and non-primary buttons (F-9280B707)", async () => {
    const onClose = vi.fn();
    const task = makeTask();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
            createElement(TaskPreviewDrawer, {
              task,
              tasks: [task],
              relations: [],
              onClose,
              onOpenDetail: noop,
              onPreviewTask: noop,
            }),
          ),
        ),
      );
      // 压在自身会激活的控件(顶栏前进/后退、看板卡)上:那次按下归控件自己,
      // 抽屉不再抢先关闭——否则 onClose 的弹栈与控件自身的导航相互抵消/叠加。
      const navButton = document.createElement("button");
      navButton.textContent = "forward";
      document.body.append(navButton);
      act(() => {
        navButton.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
        navButton.click();
      });
      expect(onClose).not.toHaveBeenCalled();
      // 侧键 3/4 是 App 级前进/后退的按下,不是「点外部关闭」。
      act(() => navButton.dispatchEvent(new MouseEvent("mousedown", { button: 3, bubbles: true })));
      expect(onClose).not.toHaveBeenCalled();
      navButton.remove();
      // 对照:惰性空白上的主键按下仍关闭——收窄没有把「点外部关闭」收没。
      const blank = document.createElement("div");
      document.body.append(blank);
      act(() => blank.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true })));
      blank.remove();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

/** 交互式挂载(renderToStaticMarkup 跑不了点击与读取):与 §4 的内容契约分开。 */
async function mountDrawer() {
  const container = document.createElement("div"),
    root = createRoot(container),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  document.body.append(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TaskPreviewDrawer, {
          task: makeTask(),
          tasks: [],
          relations: [],
          onClose: noop,
          onOpenDetail: noop,
          onPreviewTask: noop,
        }),
      ),
    );
  });
  return {
    container,
    cleanup: () =>
      act(() => {
        root.unmount();
        container.remove();
      }),
  };
}

const until = async (predicate: () => boolean, rounds = 200): Promise<void> => {
  for (let round = 0; round < rounds && !predicate(); round += 1)
    await act(async () => {
      await Promise.resolve();
    });
};

describe("task preview drawer · 执行泳道(R9)", () => {
  // 交互式挂载需要 act 环境(§4 的静态渲染用例不需要)。
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    getTaskDispatches.mockReset();
    getTaskDispatches.mockResolvedValue({
      ok: true,
      status: "ready",
      taskId: "task-a",
      dispatches: [],
      watermark: 1,
      sourceRevision: 1,
    });
  });

  it("有派工轮次就给可展开入口;展开前不画泳道,展开后画出该任务的真实轮次块", async () => {
    setActiveLocale("zh-CN");
    // 起止时间贴着「现在」:泳道的默认时间窗只覆盖近期,拿十月的固定时刻会被窗口
    // 过滤掉——测试要验的是块状态与标签,不是窗口裁剪(窗口有单独的模型测试)。
    const startedAt = new Date(Date.now() - 20 * 60_000).toISOString(),
      endedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    getTaskDispatches.mockResolvedValue(
      dispatchRead([
        dispatchRow({
          dispatchId: "dispatch-r1",
          agentName: "GLM-5.3",
          status: "succeeded",
          startedAt,
          endedAt,
        }),
        dispatchRow({
          dispatchId: "dispatch-r2",
          attemptIndex: 1,
          agentName: "Sol",
          status: "running",
          startedAt: endedAt,
        }),
      ]),
    );
    const { container, cleanup } = await mountDrawer();
    try {
      await until(() => container.querySelector('[data-testid="task-preview-lanes-toggle"]') !== null);
      // 入口在:文案是人话「展开泳道」,并带轮次数——不是只有一个图标。
      const toggle = container.querySelector<HTMLButtonElement>('[data-testid="task-preview-lanes-toggle"]')!;
      expect(toggle.textContent).toContain("展开泳道");
      expect(toggle.getAttribute("aria-label")).toBe("展开泳道");
      expect(container.textContent).toContain("2 轮");
      // 收起态不渲染泳道本体:点开之前屏幕上没有第二个同一实体的时间线(§5.2)。
      expect(container.querySelector('[data-testid="task-preview-lanes"]')).toBeNull();

      act(() => toggle.click());
      const lanes = container.querySelector('[data-testid="task-preview-lanes"]');
      expect(lanes).not.toBeNull();
      // 泳道块就是复用的 AgentLanes 块:一块一轮,块 id 是派工 id,状态如实映射。
      const blocks = [...container.querySelectorAll('[data-testid^="task-preview-lane-task-"]')];
      expect(blocks.map((block) => block.getAttribute("data-lane-status"))).toEqual(["done", "running"]);
      expect(blocks[0]!.getAttribute("aria-label")).toContain("第 1 轮");
      // 收起:点了再收回去,入口文案跟着换。
      act(() => toggle.click());
      expect(container.querySelector('[data-testid="task-preview-lanes"]')).toBeNull();
      expect(
        container.querySelector<HTMLButtonElement>('[data-testid="task-preview-lanes-toggle"]')!.textContent,
      ).toContain("展开泳道");
    } finally {
      cleanup();
    }
  });

  it("没有派工轮次时如实说空,不给假展开入口(§1.5)", async () => {
    setActiveLocale("zh-CN");
    getTaskDispatches.mockResolvedValue(dispatchRead([]));
    const { container, cleanup } = await mountDrawer();
    try {
      await until(() => container.querySelector('[data-testid="task-preview-lanes-empty"]') !== null);
      expect(container.querySelector('[data-testid="task-preview-lanes-empty"]')!.textContent).toContain(
        "还没有派工轮次",
      );
      expect(container.querySelector('[data-testid="task-preview-lanes-toggle"]')).toBeNull();
      expect(container.querySelector('[data-testid="task-preview-lanes"]')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("读取失败时就地给真实错误与下一步,不静默成空", async () => {
    setActiveLocale("zh-CN");
    getTaskDispatches.mockRejectedValue(new Error("daemon unreachable"));
    const { container, cleanup } = await mountDrawer();
    try {
      await until(() => container.querySelector('[data-testid="task-preview-lanes-error"]') !== null);
      const error = container.querySelector('[data-testid="task-preview-lanes-error"]')!;
      expect(error.getAttribute("role")).toBe("alert");
      expect(error.textContent).toContain("泳道读取失败");
      expect(error.textContent).toContain("daemon unreachable");
    } finally {
      cleanup();
    }
  });
});
