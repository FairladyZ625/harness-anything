// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionGroupList } from "../src/renderer/components/sessions/SessionGroupList.tsx";
import type { SessionGroup, SessionWorkGroup } from "../src/renderer/sessions-model.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 组头只有三种诚实形态(task_4b83acdd 五条反馈):
 * - 可展开:工作/任务/Decision → button + aria-expanded;
 * - 可钻入:有 agentId/squadId 的 Agent/小队 → button,点进去看该执行者的全部会话;
 * - 静态:时间组与没有 id 的 Direct/未归属桶 → div,无指针、无误导副行。
 * 「全页不存在点了没反应的行」由这个三分法保证,而不是给静态行加假 hover。
 */

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

const noop = () => undefined;
const mounted: { readonly root: Root; readonly container: HTMLElement }[] = [];

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

const taskGroup: SessionGroup = {
  key: "task_1",
  kind: "task",
  label: "Task One",
  taskId: "task_1",
  latestStatus: "running",
  latestActivityAt: "2026-10-19T10:00:00.000Z",
  runningCount: 1,
  sessionCount: 2,
  roundCount: 2,
  latestRound: {
    runtimeSessionId: "runtime_1",
    dispatchId: "dispatch_1",
    agentName: "GLM-5.3",
    instanceId: "instance_1",
    status: "running",
    startedAt: "2026-10-19T10:00:00.000Z",
  },
};

const groups: readonly SessionGroup[] = [
  taskGroup,
  {
    key: "2026-10-19",
    kind: "day",
    label: "2026-10-19",
    day: "2026-10-19",
    latestStatus: "succeeded",
    latestActivityAt: "2026-10-19T09:00:00.000Z",
    runningCount: 0,
    sessionCount: 1,
    roundCount: 1,
    latestRound: {
      runtimeSessionId: "runtime_day",
      dispatchId: "dispatch_day",
      agentName: "GLM-5.3",
      instanceId: "instance_1",
      status: "succeeded",
      startedAt: "2026-10-19T09:00:00.000Z",
    },
  },
  {
    key: "agent_1",
    kind: "agent",
    label: "Reviewer",
    agentId: "agent_1",
    latestStatus: "failed",
    latestActivityAt: "2026-10-19T08:00:00.000Z",
    runningCount: 0,
    sessionCount: 1,
    roundCount: 1,
    latestRound: null,
  },
  {
    key: "instance:direct",
    kind: "agent",
    label: "Direct (instance-direct)",
    latestStatus: "succeeded",
    latestActivityAt: "2026-10-19T07:00:00.000Z",
    runningCount: 0,
    sessionCount: 1,
    roundCount: 0,
    latestRound: null,
  },
  {
    key: "squad_1",
    kind: "squad",
    label: "Squad One",
    squadId: "squad_1",
    latestStatus: "running",
    latestActivityAt: "2026-10-19T06:00:00.000Z",
    runningCount: 1,
    sessionCount: 1,
    roundCount: 1,
    latestRound: null,
  },
  {
    key: "unattributed:no-squad",
    kind: "unattributed",
    label: "No squad",
    latestStatus: "unknown",
    latestActivityAt: "2026-10-19T05:00:00.000Z",
    runningCount: 0,
    sessionCount: 1,
    roundCount: 0,
    latestRound: null,
  },
];

const workGroup: SessionWorkGroup = {
  key: "work:task-work",
  kind: "work",
  label: "Work One",
  workTaskId: "task-work",
  taskGroups: [taskGroup],
  taskCount: 1,
  sessionCount: 2,
  roundCount: 2,
  runningCount: 1,
  latestStatus: "running",
  latestActivityAt: "2026-10-19T10:00:00.000Z",
};

const baseProps = () => ({
  groups,
  pending: false,
  truncated: false,
  expandedKeys: new Set<string>(),
  rowsByGroup: new Map(),
  selectedId: null,
  query: "",
  decisionRefsFor: () => [],
  onSelectSession: noop,
  onToggleGroup: noop,
  onOpenTask: noop,
  onSelectEntity: noop,
  onDrill: noop,
  workGroups: undefined as readonly SessionWorkGroup[] | undefined,
  workExpandedKeys: new Set<string>(),
  onToggleWork: noop,
});

function mount(overrides: Partial<ReturnType<typeof baseProps>> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(createElement(SessionGroupList, { ...baseProps(), ...overrides }));
  });
  return container;
}

describe("会话页:组头三分法", () => {
  it("任务/Decision 是可展开按钮,时间组是静态行且不挂执行者名", () => {
    const container = mount();
    const taskToggle = container.querySelector('[data-testid="session-group-toggle-task_1"]');
    expect(taskToggle?.tagName).toBe("BUTTON");
    expect(taskToggle?.getAttribute("aria-expanded")).toBe("false");
    const day = container.querySelector('[data-testid="session-group-static-2026-10-19"]');
    expect(day?.tagName).toBe("DIV");
    expect(container.querySelector('[data-testid="session-group-toggle-2026-10-19"]')).toBeNull();
    expect(day?.textContent).not.toContain("GLM-5.3");
    // 诚实静态:没有 hover 指针。
    expect(day?.querySelector(".cursor-pointer")).toBeNull();
    expect(day?.textContent).toContain("1 rounds");
  });

  it("有 agentId/squadId 的组头变成钻入按钮,点击回调精确目标;没有 id 的组不可点", () => {
    const onDrill = vi.fn();
    const container = mount({ onDrill });
    const agentDrill = container.querySelector<HTMLButtonElement>('[data-testid="session-group-drill-agent_1"]');
    const squadDrill = container.querySelector<HTMLButtonElement>('[data-testid="session-group-drill-squad_1"]');
    expect(agentDrill?.tagName).toBe("BUTTON");
    expect(squadDrill?.tagName).toBe("BUTTON");
    expect(agentDrill?.getAttribute("title")).toContain("Reviewer");
    act(() => agentDrill!.click());
    expect(onDrill).toHaveBeenLastCalledWith({ kind: "agent", id: "agent_1", label: "Reviewer" });
    act(() => squadDrill!.click());
    expect(onDrill).toHaveBeenLastCalledWith({ kind: "squad", id: "squad_1", label: "Squad One" });

    // 没有 agentId 的 Direct 组、没有 squadId 的未归属组:静态行,点不出动作。
    for (const key of ["instance:direct", "unattributed:no-squad"]) {
      expect(container.querySelector(`[data-testid="session-group-drill-${key}"]`)).toBeNull();
      expect(container.querySelector(`[data-testid="session-group-static-${key}"]`)?.tagName).toBe("DIV");
    }
    expect(onDrill).toHaveBeenCalledTimes(2);
  });

  it("工作组头可展开:收起时只见工作,展开后任务组挂在工作下面", () => {
    const onToggleWork = vi.fn();
    const collapsed = mount({ workGroups: [workGroup], onToggleWork });
    expect(collapsed.querySelector('[data-testid="session-work-toggle-work:task-work"]')).not.toBeNull();
    expect(collapsed.querySelector('[data-testid="session-group-task_1"]')).toBeNull();
    expect(collapsed.textContent).toContain("1 tasks · 2 sessions");

    const expanded = mount({ workGroups: [workGroup], workExpandedKeys: new Set(["work:task-work"]), onToggleWork });
    expect(expanded.querySelector('[data-testid="session-group-task_1"]')).not.toBeNull();
    act(() => expanded.querySelector<HTMLButtonElement>('[data-testid="session-work-toggle-work:task-work"]')!.click());
    expect(onToggleWork).toHaveBeenLastCalledWith("work:task-work");
  });
});
