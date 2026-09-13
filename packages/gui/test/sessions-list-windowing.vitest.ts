// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  GROUP_HEADER_ESTIMATE_PX,
  GROUP_OVERSCAN,
  SessionGroupList,
} from "../src/renderer/components/sessions/SessionGroupList.tsx";
import type { SessionGroup } from "../src/renderer/sessions-model.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { HAPPY_DOM_VIEWPORT_PX } from "./virtualizedViewport.ts";

/**
 * 会话组列表窗口化(harness 仓 858+ 组,任务包 task_a49911b8):两条判据对应两条症状——
 *  - 渲染面:挂在 DOM 上的组行数只随视口高度 + overscan 走,与组总数无关
 *    (基线 groups.map 一次挂全部,885 组时每 2s 轮询重渲染整列表);
 *  - 重渲染面:台账 cut 扇出的数据刷新里,内容未变的组(react-query 结构共享保持
 *    同一引用)不再重渲染行;decisionRefsFor 每次组渲染都会被调用,是行渲染的
 *    可观测计数器。
 */

const VIEWPORT_HEIGHT = HAPPY_DOM_VIEWPORT_PX;
const TOTAL_GROUPS = 802;

function taskGroup(index: number): SessionGroup {
  return {
    key: `task-${index}`,
    kind: "task",
    label: `Task group ${index}`,
    taskId: `task-${index}`,
    latestStatus: "succeeded",
    latestActivityAt: "2026-09-13T02:00:00.000Z",
    runningCount: 0,
    sessionCount: 1,
    roundCount: 1,
    latestRound: null,
  };
}

const noop = () => undefined;

const mounted: { readonly root: Root; readonly container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  vi.restoreAllMocks();
});

const listProps = (groups: readonly SessionGroup[], decisionRefsFor: (taskId: string) => readonly string[]) => ({
  groups,
  truncated: false,
  expandedKeys: new Set(),
  rowsByGroup: new Map(),
  selectedId: null,
  query: "",
  decisionRefsFor,
  onSelectSession: noop,
  onToggleGroup: noop,
  onOpenTask: noop,
  onSelectEntity: noop,
});

function mountList(
  groups: readonly SessionGroup[],
  decisionRefsFor: (taskId: string) => readonly string[],
): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(createElement(SessionGroupList, listProps(groups, decisionRefsFor)));
  });
  return container;
}

const sectionsIn = (container: HTMLElement) => container.querySelectorAll('[data-testid^="session-group-task-"]');

describe("会话组列表窗口化:DOM 组行数与组总数解耦", () => {
  it("802 组只挂视口附近,深位组不在 DOM", () => {
    const container = mountList(
      Array.from({ length: TOTAL_GROUPS }, (_, index) => taskGroup(index)),
      () => [],
    );
    const sections = sectionsIn(container);
    // 上界 = ceil(视口/估算行高) + 两侧 overscan,再留 1 行测量余量。
    const bound = Math.ceil(VIEWPORT_HEIGHT / GROUP_HEADER_ESTIMATE_PX) + 2 * GROUP_OVERSCAN + 1;
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.length).toBeLessThanOrEqual(bound);
    // 视口外的深位组不挂载(基线全量 map 时它在 DOM 里)。
    expect(container.querySelector('[data-testid="session-group-task-700"]')).toBeNull();
    // 首组在首屏,组头交互面仍在。
    expect(container.querySelector('[data-testid="session-group-toggle-task-0"]')).not.toBeNull();
    // 滚动范围 = spacer 的显式总高度:nav 是 flex 列也是滚动容器,spacer 不带
    // shrink-0 会被 flex-shrink 压回视口高,深位组永远滚不到(实测踩过)。
    const spacer = container.querySelector('[data-testid="sessions-group-list"] > .relative') as HTMLElement;
    expect(spacer.classList.contains("shrink-0")).toBe(true);
    expect(parseFloat(spacer.style.height)).toBeGreaterThanOrEqual((TOTAL_GROUPS - 1) * GROUP_HEADER_ESTIMATE_PX);
  });
});

describe("数据刷新的重渲染收窄:组内容没变不重渲染行", () => {
  it("同引用刷新 decisionRefsFor 零调用;单组变化只重渲染该组", () => {
    const groups = Array.from({ length: TOTAL_GROUPS }, (_, index) => taskGroup(index));
    const decisionRefsFor = vi.fn(() => []);
    const container = mountList(groups, decisionRefsFor);
    expect(decisionRefsFor.mock.calls.length).toBeGreaterThan(0);
    const afterMount = decisionRefsFor.mock.calls.length;

    // 无变化刷新:新数组、同一批组对象引用(react-query 结构共享的形态)。
    const unchangedRefresh = [...groups];
    act(() => {
      mounted[0]!.root.render(createElement(SessionGroupList, listProps(unchangedRefresh, decisionRefsFor)));
    });
    expect(decisionRefsFor.mock.calls.length).toBe(afterMount);

    // 单组变化:只有该组换新引用,其余保持;重渲染数收敛到 1。
    const oneChanged = groups.map((group, index) =>
      index === 2 ? { ...group, latestStatus: "running" as const } : group,
    );
    act(() => {
      mounted[0]!.root.render(createElement(SessionGroupList, listProps(oneChanged, decisionRefsFor)));
    });
    expect(decisionRefsFor.mock.calls.length).toBe(afterMount + 1);
    // 交互面未被刷新破坏。
    expect(container.querySelector('[data-testid="session-group-toggle-task-2"]')).not.toBeNull();
  });
});
