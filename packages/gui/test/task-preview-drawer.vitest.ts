// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { TaskPreviewDrawer } from "../src/renderer/components/TaskPreviewDrawer.tsx";
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
      const refButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
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
      const backdrop = document.body.querySelector('[data-testid="drawer-backdrop"]') as HTMLElement;
      // 压暗层不接指针事件:它下面的看板卡照常收到那一次点击,换卡才只需点一次。
      expect(backdrop.className).toContain("pointer-events-none");
      expect((document.body.querySelector("aside") as HTMLElement).className).toContain("pointer-events-auto");
      const inside = document.body.querySelector("aside h2") as HTMLElement;
      act(() => {
        inside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        inside.click();
      });
      expect(onClose).not.toHaveBeenCalled();
      const pinToggle = document.body.querySelector('[data-testid="task-preview-pin-toggle"]') as HTMLElement;
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
});
