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
 * 置顶承诺区(总览「执行与下钻 → 置顶承诺」tab 与放大层)的行为面:任务行可派在前、
 * 行上就地取消置顶接 pin 写通道;非任务实体(Decision、Schedule…)同列,行上取消置顶
 * 走实体级解 pin 通道(task_9ba495de)。共享挂载夹具在 overview-board.fixtures.ts;
 * 泳道与其余 tab 的行为面在 overview-board.vitest.tsx。
 */

beforeAll(() => {
  setupOverviewBoardEnvironment();
});

const drillRows = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid="overview-drill-list"] [data-drill-row]')].map(
    (row) => row.getAttribute("data-drill-row")!,
  );

describe("总览:置顶承诺区", () => {
  it("置顶承诺 tab:可派在前,行上就地取消置顶接真实 pin 通道", () => {
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
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    expect(textOf(drill)).toContain("置顶承诺");
    act(() => (drill.querySelector('[data-testid="overview-drill-pinned"]') as HTMLElement).click());
    expect(drillRows(container)).toEqual(["task_pin_go", "task_pin_active"]);
    const unpin = container.querySelector<HTMLButtonElement>('[data-testid="overview-unpin-task_pin_active"]')!;
    act(() => unpin.click());
    expect(onUnpin).toHaveBeenCalledWith("task_pin_active");
    unmount();
  });

  it("置顶承诺 tab:非任务实体(Decision/Schedule)也列出,行上取消置顶走实体解 pin 通道", () => {
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
    const drill = container.querySelector('[data-testid="overview-region-drill"]')!;
    act(() => (drill.querySelector('[data-testid="overview-drill-pinned"]') as HTMLElement).click());
    // 任务行在前,非任务实体随后;行键用实体 ref,数与 tab 徽标一致(3)。
    expect(drillRows(container)).toEqual(["task_pin_active", "decision/dec_pin", "schedule/sch_pin"]);
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
});
