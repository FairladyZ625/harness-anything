// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import {
  cleanupMountedDetail,
  clickTab,
  flushEffects,
  installBridge,
  mount,
  mounted,
  prepareDetailEnvironment,
  task as baseTask,
} from "./task-detail.fixtures.ts";

/**
 * 时间线实体引用可导航(task 详情概况时间线):事件引用的 execution/review 记录
 * 可点击、可键盘激活(原生 button),落点是该记录在收口页签的对应详情行——
 * 不是一律跳任务概况;没有结构化引用的事件保持纯文本,不误导航。
 */

beforeAll(prepareDetailEnvironment);

// cleanup 在 afterEach unstub 全局,桥每个用例重装。
beforeEach(() => {
  installBridge();
});

afterEach(cleanupMountedDetail);

/** 概况时间线里显示某编号的行尾元素(时间线区域内的精确文本匹配)。 */
function timelineTail(id: string): HTMLElement {
  const timeline = document.querySelector('[data-testid="task-progress-timeline"]');
  expect(timeline, "概况页签的进展时间线未渲染").toBeInstanceOf(HTMLElement);
  const tail = [...timeline!.querySelectorAll<HTMLElement>("span, button")].find((node) => node.textContent === id);
  expect(tail, `时间线行尾未显示 ${id}`).toBeTruthy();
  return tail!;
}

const taskWithTimelineRefs: TaskRow = {
  ...baseTask,
  events: [
    {
      projectId: "repo-a",
      taskId: baseTask.taskId,
      at: "2026-08-23T09:00:00.000Z",
      kind: "start",
      ref: "execution-w3",
      recordRef: "execution/execution-w3",
      summary: "开始执行",
    },
    {
      projectId: "repo-a",
      taskId: baseTask.taskId,
      at: "2026-08-23T10:20:00.000Z",
      kind: "approved",
      ref: "review-w3",
      recordRef: "review/review-w3",
      summary: "评审通过",
    },
    {
      // 无结构化引用的事件(如手工写入的旧记录):行尾保持纯文本。
      projectId: "repo-a",
      taskId: baseTask.taskId,
      at: "2026-08-23T10:22:00.000Z",
      summary: "手写关键记录",
    },
  ],
};

describe("任务详情概况时间线:实体引用可导航", () => {
  it("execution 与 review 引用渲染成原生按钮(可键盘激活),点击落收口页签对应记录行", async () => {
    await mount({ task: taskWithTimelineRefs });

    expect(timelineTail("execution-w3").tagName).toBe("BUTTON");
    expect(timelineTail("review-w3").tagName).toBe("BUTTON");

    // 点击 execution 引用:收口页签打开,Execution 输出里对应 execution 行在且被聚焦。
    await act(async () => {
      timelineTail("execution-w3").click();
    });
    await flushEffects();
    expect(document.querySelector('[data-testid="task-closeout-tab"]')).not.toBeNull();
    const executionRow = document.querySelector('[data-testid="task-execution-execution-w3"]');
    expect(executionRow).not.toBeNull();
    expect(executionRow!.className).toContain("accent");

    // 回到概况再点 review 引用:落 Review 分组的对应评审记录行,同样聚焦。
    // (页签切换会重挂概况,元素每次现查,不吃旧引用。)
    await clickTab("概况");
    await act(async () => {
      timelineTail("review-w3").click();
    });
    await flushEffects();
    const reviewRow = document.getElementById("closeout-record-review-review-w3");
    expect(reviewRow).not.toBeNull();
    expect(reviewRow!.className).toContain("accent");
    // 打开的是这条 review 的记录行,不是笼统的任务概况:Execution 输出行未被聚焦。
    expect(document.querySelector('[data-testid="task-execution-execution-w3"]')!.className).not.toContain("accent");
  });

  it("无结构化引用的事件行尾是纯文本,不渲染可点元素", async () => {
    await mount({ task: taskWithTimelineRefs });
    const plainTail = timelineTail("手写关键记录");
    expect(plainTail.tagName).toBe("SPAN");
  });

  it("导航发生在任务详情内部:任务上下文与返回出口保持不变", async () => {
    await mount({ task: taskWithTimelineRefs });
    await act(async () => {
      timelineTail("execution-w3").click();
    });
    await flushEffects();
    // 仍是同一个任务详情页(页头/页签都在),没有离开任务。
    expect(document.querySelector('[data-testid="task-detail-view"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="task-detail-tabs"]')).not.toBeNull();
    // 回概况:时间线还在原处,返回上下文未被破坏。
    await clickTab("概况");
    expect(document.querySelector('[data-testid="task-progress-timeline"]')).not.toBeNull();
  });

  it("点击后聚焦行滚入视野;一次导航恰一次滚动", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
    try {
      await mount({ task: taskWithTimelineRefs });
      await act(async () => {
        timelineTail("execution-w3").click();
      });
      await flushEffects();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      // 换一个引用(重新从概况点开收口):新的聚焦各滚一次,不重复也不漏。
      await clickTab("概况");
      await act(async () => {
        timelineTail("review-w3").click();
      });
      await flushEffects();
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "center" });
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it("StrictMode 重放不吞滚动:真实入口的 effect 重放下聚焦引用仍恰好滚一次", async () => {
    // renderer/main.tsx 在 StrictMode 下挂载:mount effect 会跑两遍,首帧被清理
    // 取消。若"已处理"标记在帧执行前置位,第二遍直接短路,滚动永远丢失——
    // 这里用同一入口形态(strict 挂载)复现并钉死。
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
    try {
      await mount({ task: taskWithTimelineRefs, strict: true });
      await act(async () => {
        timelineTail("execution-w3").click();
      });
      await flushEffects();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it("completion read arriving after navigation positions the focused row only after layout is ready", async () => {
    const bridge = installBridge();
    const response = await bridge.getTaskCompletion({ taskId: baseTask.taskId });
    let release!: (value: typeof response) => void;
    bridge.getTaskCompletion.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
    try {
      await mount({ task: taskWithTimelineRefs });
      await act(async () => {
        timelineTail("execution-w3").click();
      });
      await flushEffects();
      expect(scroll).not.toHaveBeenCalled();
      expect(document.querySelector('[data-testid="task-completion-next"]')).toBeNull();
      await act(async () => {
        release(response);
      });
      await flushEffects();
      expect(document.querySelector('[data-testid="task-completion-next"]')).not.toBeNull();
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.instances.at(-1)).toBe(document.getElementById("closeout-record-execution-execution-w3"));
      // An unrelated query refresh with the same data must not steal the user's scroll.
      await act(async () => {
        mounted.at(-1)!.client.setQueryData(["tasks", "repo-a", baseTask.taskId, "completion"], response);
      });
      await flushEffects();
      expect(scroll).toHaveBeenCalledTimes(1);
    } finally {
      scroll.mockRestore();
    }
  });
});
