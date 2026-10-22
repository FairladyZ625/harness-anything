// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  AT,
  agenda,
  setupOverviewBoardEnvironment,
  mountOverview as mount,
  textOf,
  unmountOverview as unmount,
} from "./overview-board.fixtures.ts";

/**
 * 「置顶与议程」区(2026-10-21 四块定案,右上;重构时被撤下的 pin 拿回总览)的行为面:
 * 任务行可派在前、行上就地取消置顶接 pin 写通道;非任务实体(Decision、Schedule…)
 * 同列,行上取消置顶走实体级解 pin 通道(task_9ba495de)。共享挂载夹具在
 * overview-board.fixtures.ts;其余三块的行为面在 overview-board.vitest.tsx。
 */

beforeAll(() => {
  setupOverviewBoardEnvironment();
});

const pinRows = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid="overview-pins"] [data-pin-row]')].map(
    (row) => row.getAttribute("data-pin-row")!,
  );

describe("总览:置顶与议程区", () => {
  it("可派在前,行上就地取消置顶接真实 pin 通道", () => {
    const onUnpin = vi.fn();
    const container = mount({
      onUnpin,
      agenda: agenda({
        pinnedEntities: [
          { ref: "task/task_pin_go", kind: "task", title: "可派的置顶承诺", status: "planned", pinnedAt: AT },
          { ref: "task/task_pin_active", kind: "task", title: "在跑的置顶任务", status: "active", pinnedAt: AT },
        ],
        dispatchable: [
          {
            taskId: "task_pin_go",
            title: "可派的置顶承诺",
            work: null,
            status: "planned",
            pinned: true,
            updatedAt: AT,
            leaseExecutionId: null,
            activeExecutionIds: [],
            blockingAssessment: { state: "clear", blockers: [], warnings: [] },
          },
        ],
      }),
    });
    const pins = container.querySelector('[data-testid="overview-region-pins"]')!;
    expect(textOf(pins)).toContain("置顶与议程");
    expect(pinRows(container)).toEqual(["task_pin_go", "task_pin_active"]);
    const unpin = container.querySelector<HTMLButtonElement>('[data-testid="overview-unpin-task_pin_active"]')!;
    act(() => unpin.click());
    expect(onUnpin).toHaveBeenCalledWith("task_pin_active");
    unmount();
  });

  it("非任务实体(Decision/Schedule)也列出,行上取消置顶走实体解 pin 通道", () => {
    const onUnpin = vi.fn();
    const onUnpinEntity = vi.fn();
    const container = mount({
      onUnpin,
      onUnpinEntity,
      agenda: agenda({
        pinnedEntities: [
          { ref: "task/task_pin_active", kind: "task", title: "在跑的置顶任务", status: "active", pinnedAt: AT },
          { ref: "decision/dec_pin", kind: "decision", title: "置顶的裁决", status: "proposed", pinnedAt: AT },
          { ref: "schedule/sch_pin", kind: "schedule", title: "置顶的巡检", status: "armed", pinnedAt: AT },
        ],
      }),
    });
    // 任务行在前,非任务实体随后;行键用实体 ref。
    expect(pinRows(container)).toEqual(["task_pin_active", "decision/dec_pin", "schedule/sch_pin"]);
    const unpinDecision = container.querySelector<HTMLButtonElement>(
      '[data-testid="overview-unpin-decision/dec_pin"]',
    )!;
    act(() => unpinDecision.click());
    expect(onUnpinEntity).toHaveBeenCalledWith("decision/dec_pin");
    expect(onUnpin).not.toHaveBeenCalled();
    // 任务行不受影响:仍走 task 解 pin 通道。
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="overview-unpin-task_pin_active"]')!.click());
    expect(onUnpin).toHaveBeenCalledWith("task_pin_active");
    unmount();
  });

  it("空态如实给入口提示,不冒充空壳", () => {
    const container = mount();
    const empty = container.querySelector('[data-testid="overview-pins-empty"]')!;
    expect(textOf(empty)).toContain("没有置顶");
    unmount();
  });
});
