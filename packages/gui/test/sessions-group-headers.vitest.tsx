// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionGroupList } from "../src/renderer/components/sessions/SessionGroupList.tsx";
import type { SessionGroup, SessionRound, SessionWorkGroup } from "../src/renderer/sessions-model.ts";
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

/** 同一个工作头的另一组计数:用来锁住复数的任务、单数的会话。 */
const workGroupMany: SessionWorkGroup = {
  ...workGroup,
  key: "work:task-work-many",
  label: "Work Many",
  taskCount: 2,
  sessionCount: 1,
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

describe("会话页:行级缓存倒计时接线", () => {
  const NOW = Date.parse("2026-10-19T10:00:00.000Z");
  const round = (overrides: Partial<SessionRound>): SessionRound => ({
    kind: "round",
    roundIndex: 1,
    runtimeSessionId: "runtime_run",
    dispatchId: "dispatch_run",
    agentId: null,
    agentName: null,
    squadId: null,
    instanceId: "instance_claude",
    taskId: "task_1",
    taskTitle: "Task One",
    startedAt: "2026-10-19T09:30:00.000Z",
    endedAt: null,
    status: "running",
    classification: null,
    resume: null,
    nextAction: null,
    delegation: null,
    ...overrides,
  });

  it("在跑轮不显示倒计时(触达证据再旧也不判 expired);收口的 claude 轮按真实 TTL 倒计时", () => {
    const container = mount({
      nowMs: NOW,
      expandedKeys: new Set(["task_1"]),
      rowsByGroup: new Map([
        [
          "task_1",
          {
            rounds: [
              round({ runtimeSessionId: "runtime_run", dispatchId: "dispatch_run", status: "running" }),
              round({
                runtimeSessionId: "runtime_done",
                dispatchId: "dispatch_done",
                roundIndex: 2,
                status: "succeeded",
                endedAt: "2026-10-19T09:58:00.000Z",
              }),
              round({
                runtimeSessionId: "runtime_ds",
                dispatchId: "dispatch_ds",
                roundIndex: 3,
                status: "succeeded",
                endedAt: "2026-10-19T09:58:00.000Z",
              }),
            ],
            orphans: [],
            pending: false,
            error: null,
          },
        ],
      ]),
      // 三轮都有 started 触达(29 分钟前):修前这一证据会让在跑轮判 expired。
      sessionTouches: new Map([
        ["runtime_run", NOW - 29 * 60_000],
        ["runtime_done", NOW - 2 * 60_000],
        ["runtime_ds", NOW - 2 * 60_000],
      ]),
      sessionCacheTtlMs: new Map([
        ["runtime_run", 300_000],
        ["runtime_done", 300_000],
        // DeepSeek:无确定 TTL。
        ["runtime_ds", null],
      ]),
    });
    // 在跑轮:触达 29 分钟前也不渲染计时器(轮内缓存由模型调用保温)。
    expect(container.querySelector('[data-testid="session-card-cache-timer-runtime_run"]')).toBeNull();
    // 收口的 claude 轮:触达 2 分钟前 + 5 分钟 TTL → 剩余 3 分钟,normal 档倒计时。
    const done = container.querySelector('[data-testid="session-card-cache-timer-runtime_done"]');
    expect(done?.getAttribute("data-cache-state")).toBe("normal");
    expect(done?.textContent).toContain("3m");
    // 收口但 provider 无确定 TTL(DeepSeek):不虚构倒计时。
    expect(container.querySelector('[data-testid="session-card-cache-timer-runtime_ds"]')).toBeNull();
  });
});

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
    expect(day?.textContent).toContain("1 round");
    expect(day?.textContent).not.toContain("1 rounds");
    // 任务组有 2 轮,锁住复数一侧没有被单数分支误伤。
    expect(taskToggle?.textContent).toContain("2 rounds");
    // 只绑了 1 个会话、0 轮的静态组也要用单数会话。
    const direct = container.querySelector('[data-testid="session-group-static-instance:direct"]');
    expect(direct?.textContent).toContain("1 session");
    expect(direct?.textContent).not.toContain("1 sessions");
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
    expect(collapsed.textContent).toContain("1 task · 2 sessions");
    expect(collapsed.textContent).not.toContain("1 tasks");

    const many = mount({ workGroups: [workGroupMany], onToggleWork });
    expect(many.textContent).toContain("2 tasks · 1 session");
    expect(many.textContent).not.toContain("1 sessions");

    const expanded = mount({ workGroups: [workGroup], workExpandedKeys: new Set(["work:task-work"]), onToggleWork });
    expect(expanded.querySelector('[data-testid="session-group-task_1"]')).not.toBeNull();
    act(() => expanded.querySelector<HTMLButtonElement>('[data-testid="session-work-toggle-work:task-work"]')!.click());
    expect(onToggleWork).toHaveBeenLastCalledWith("work:task-work");
  });

  it("pluralizes the truncated-groups footer", () => {
    const one = mount({ groups: [taskGroup], truncated: true });
    expect(one.querySelector('[data-testid="sessions-groups-truncated"]')?.textContent).toContain(
      "First 1 group listed",
    );
    const many = mount({ groups: [taskGroup, groups[1]!], truncated: true });
    expect(many.querySelector('[data-testid="sessions-groups-truncated"]')?.textContent).toContain(
      "First 2 groups listed",
    );
  });
});
