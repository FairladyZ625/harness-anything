// harness-test-tier: fast
// @vitest-environment happy-dom
/**
 * Agent 编排与执行原语库(task_e1123f0660b0ffaba503dcca04 / dec_C0AF8CBBFFECF71F4F34FB76F9 CH2)
 * 的组件判据:CacheTimer TTL 三态与计时器清理、ContextMeter 分段水位与高水位档、
 * AgentTree 多层 Rollup 不重复计费与折叠、AgentLanes 泳道/交接连线/待拍板快捷动作、
 * AgentPlan 编辑契约与失败步重试、AgentSteering 队列流转与 FLIP 滑入。
 * 计时器断言用 fake timers 计数(vi.getTimerCount,含 Date),零墙钟等待;动效走
 * reduced 探针,真机帧的视觉数值不在 happy-dom 伪造。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppMotionConfig } from "../src/renderer/motion-config.tsx";
import { CacheTimer } from "../src/renderer/components/agent-ui/CacheTimer.tsx";
import { ContextMeter, type ContextSegment } from "../src/renderer/components/agent-ui/ContextMeter.tsx";
import { AgentTree, rollupSubtree, type AgentTreeNode } from "../src/renderer/components/agent-ui/AgentTree.tsx";
import { AgentLanes } from "../src/renderer/components/agent-ui/AgentLanes.tsx";
import { AgentPlan, moveStepBefore, type PlanStep } from "../src/renderer/components/agent-ui/AgentPlan.tsx";
import { AgentSteering, type SteerNote } from "../src/renderer/components/agent-ui/AgentSteering.tsx";
import { compactTokens } from "../src/renderer/token-format.ts";
import { formatDuration } from "../src/renderer/model/time.ts";
import { setActiveLocale, t } from "../src/renderer/i18n/core.ts";

vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  useReducedMotion: () => probe.reduced,
}));
const probe = vi.hoisted(() => ({ reduced: false }));

const BASE = 1_760_000_000_000;
const mounted: { root: Root; container: HTMLElement }[] = [];

function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mounted.push({ root, container });
  return container;
}

function rerender(rootIndex: number, element: ReactElement) {
  const { root } = mounted[rootIndex]!;
  act(() => {
    root.render(element);
  });
}

/** 受控 input/textarea/select 在 happy-dom 下的原生写法(绕过 React 值追踪)。 */
function setInputValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

/** 含 Date 的 fake timers:interval 回调读 Date.now(),只 fake 定时器会拿到真实墙钟。 */
function useFakeClock() {
  vi.useFakeTimers({
    now: BASE,
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  probe.reduced = true;
  setActiveLocale("zh-CN");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  probe.reduced = false;
});

// ---------------------------------------------------------------------------
// CacheTimer:5 分钟 Prompt Cache TTL 三态与计时器纪律。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CacheTimer(CEO 返工裁定 F1 后):纯受控展示,只收模型层算好的 remainingMs + state,
// 三态渲染各一条(不再有 TTL 常量、expiresAt 计算与 interval)。
// ---------------------------------------------------------------------------

describe("CacheTimer", () => {
  it("normal renders the neutral mono countdown from the injected remainingMs", () => {
    const container = mount(createElement(CacheTimer, { remainingMs: 200_000, state: "normal", testId: "ct-ok" }));
    const el = container.querySelector('[data-testid="ct-ok"]')!;
    expect(el.getAttribute("data-cache-state")).toBe("normal");
    expect(el.textContent).toBe(formatDuration(200_000));
    // 中性态无脉冲点。
    expect(el.querySelector("span[class*='rounded-full']")).toBeNull();
    expect(el.getAttribute("aria-label")).toBe(t("agentUi.cache.ariaRemaining", { duration: formatDuration(200_000) }));
  });

  it("warning renders the amber countdown with the pulse dot (static under reduced motion)", () => {
    const container = mount(createElement(CacheTimer, { remainingMs: 40_000, state: "warning", testId: "ct-warn" }));
    const el = container.querySelector('[data-testid="ct-warn"]')!;
    expect(el.getAttribute("data-cache-state")).toBe("warning");
    expect(el.textContent).toContain(formatDuration(40_000));
    // 预警脉冲点:reduced-motion 探针下是静止的实心小圆点,无动画样式。
    const dot = el.querySelector("span[class*='rounded-full']")!;
    expect(dot).not.toBeNull();
    expect(dot.getAttribute("style") ?? "").not.toContain("animation");
  });

  it("expired hides the countdown and states the 10x cost in the tooltip and screen-reader text", () => {
    const container = mount(createElement(CacheTimer, { remainingMs: -12_000, state: "expired", testId: "ct-dead" }));
    const el = container.querySelector('[data-testid="ct-dead"]')!;
    expect(el.getAttribute("data-cache-state")).toBe("expired");
    // 过期态:隐藏秒数(含负数),只留计时图标;成本对价写在 data-tip 与 sr-only 读屏文本。
    expect(el.textContent).not.toMatch(/-?\d+s/u);
    const expiredTip = t("agentUi.cache.expiredTip");
    expect(expiredTip).toContain("10x");
    expect(el.getAttribute("data-tip")).toBe(expiredTip);
    expect(el.textContent).toContain("10x");
    expect(el.querySelector("svg")).not.toBeNull();
  });

  it("is purely presentational: mounting any state schedules no timer", () => {
    useFakeClock();
    mount(createElement(CacheTimer, { remainingMs: 200_000, state: "normal" }));
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ContextMeter:分段水位、高水位档与无障碍读数。
// ---------------------------------------------------------------------------

describe("ContextMeter", () => {
  const segments: ContextSegment[] = [
    { kind: "cache", label: "缓存上下文", tokens: 80_000 },
    { kind: "input", label: "本轮输入", tokens: 15_000 },
    { kind: "output", label: "本轮输出", tokens: 5_000 },
  ];

  it("sums segments, renders proportion bars, legend and the meter semantics", () => {
    const container = mount(createElement(ContextMeter, { segments, limitTokens: 200_000, testId: "cm" }));
    const meter = container.querySelector('[role="meter"]')!;
    expect(meter.getAttribute("aria-valuenow")).toBe("100000");
    expect(meter.getAttribute("aria-valuetext")).toContain("100K / 200K");
    expect(container.querySelector('[data-testid="cm"]')!.getAttribute("data-context-level")).toBe("ok");
    expect(meter.textContent).toBe(`${compactTokens(100_000)} / ${compactTokens(200_000)} · 50%`);
    // 三个非零分段各有一块比例条与一条图例。
    const bars = container.querySelectorAll("div[aria-hidden] div[data-tip]");
    expect(bars.length).toBe(3);
    expect([...container.textContent!.matchAll(/缓存上下文/g)]).toHaveLength(1);
  });

  it("keeps the readout and bar in one line in compact rows", () => {
    const container = mount(
      createElement(ContextMeter, { segments, limitTokens: 200_000, testId: "cm-compact", compact: true }),
    );
    const meter = container.querySelector('[role="meter"]')!;
    expect(meter.textContent).toBe("50%");
    expect(meter.getAttribute("aria-valuetext")).toContain("100K / 200K");
    expect(container.querySelector('[data-testid="cm-compact"]')!.className).toContain("items-center");
    expect(container.querySelector("div[aria-hidden]")!.className).toContain("flex-1");
    expect(container.textContent).not.toContain("缓存上下文");
  });

  it("escalates to warn and danger at the high-water ratios", () => {
    const warn = mount(
      createElement(ContextMeter, {
        segments: [...segments.slice(0, 2), { kind: "output", label: "本轮输出", tokens: 75_000 }],
        limitTokens: 200_000,
      }),
    );
    expect(warn.querySelector("[data-context-level]")!.getAttribute("data-context-level")).toBe("warn");
    expect(warn.querySelector('[role="meter"]')!.getAttribute("aria-valuetext")).toContain("高水位");

    const danger = mount(
      createElement(ContextMeter, {
        segments: [...segments.slice(0, 2), { kind: "output", label: "本轮输出", tokens: 95_000 }],
        limitTokens: 200_000,
      }),
    );
    expect(danger.querySelector("[data-context-level]")!.getAttribute("data-context-level")).toBe("danger");
    expect(danger.querySelector('[role="meter"]')!.getAttribute("aria-valuetext")).toContain("接近上限");
  });

  it("zero-token segments stay hidden and a zero limit degrades instead of NaN", () => {
    const container = mount(
      createElement(ContextMeter, { segments: [{ kind: "input", label: "本轮输入", tokens: 0 }], limitTokens: 0 }),
    );
    expect(container.querySelector("div[aria-hidden] div[data-tip]")).toBeNull();
    expect(container.querySelector('[role="meter"]')!.textContent).toContain("0 / 0 · 0%");
  });
});

// ---------------------------------------------------------------------------
// AgentTree:多层 Rollup 不重复计费、折叠与键盘树。
// ---------------------------------------------------------------------------

/** Work → Task → Squad → Worker 四层 checkpoint 夹具:手算总计 5400 tok / 390_000ms。 */
const workerTree: AgentTreeNode = {
  id: "work",
  role: "CEO",
  model: "glm-5.3",
  status: "running",
  ownTokens: 1_000,
  ownDurationMs: 60_000,
  children: [
    {
      id: "task",
      role: "Commander",
      model: "glm-5.3",
      status: "running",
      ownTokens: 400,
      ownDurationMs: 30_000,
      children: [
        {
          id: "squad",
          role: "Squad Alpha",
          status: "running",
          ownTokens: 1_000,
          ownDurationMs: 100_000,
          children: [
            { id: "w1", role: "Worker-1", status: "running", ownTokens: 1_000, ownDurationMs: 100_000 },
            { id: "w2", role: "Worker-2", status: "done", ownTokens: 1_000, ownDurationMs: 100_000 },
          ],
        },
      ],
    },
    {
      id: "direct",
      role: "Worker-Direct",
      status: "done",
      ownTokens: 1_000,
      ownDurationMs: 0,
    },
  ],
};

/** 一支已收口 + 一支在跑的混合树:验证「折叠已完成」只折叠终态分支。 */
const mixedTree: AgentTreeNode = {
  id: "root",
  role: "CEO",
  status: "running",
  ownTokens: 100,
  children: [
    {
      id: "finished",
      role: "Squad Done",
      status: "done",
      ownTokens: 100,
      children: [
        { id: "fw1", role: "Worker-F1", status: "done", ownTokens: 100 },
        { id: "fw2", role: "Worker-F2", status: "failed", ownTokens: 100 },
      ],
    },
    {
      id: "running",
      role: "Squad Live",
      status: "running",
      ownTokens: 100,
      children: [{ id: "rw1", role: "Worker-L1", status: "running", ownTokens: 100 }],
    },
  ],
};

describe("AgentTree", () => {
  it("rollupSubtree counts every own value exactly once across four nesting levels", () => {
    const rollup = rollupSubtree(workerTree);
    // 1_000 + 400 + 1_000 + 1_000 + 1_000 + 1_000 = 5_400;每个 own 只计一次。
    expect(rollup.tokens).toBe(5_400);
    expect(rollup.durationMs).toBe(390_000);
    expect(rollup.descendants).toBe(5);
    expect(rollup.finished).toBe(false);
    // done/failed 都是终态:含 failed 的分支同样算已收口。
    expect(rollupSubtree(mixedTree.children![0]!).finished).toBe(true);
  });

  it("renders per-node own metrics and the subtree Σ rollup on parent rows", () => {
    const container = mount(createElement(AgentTree, { root: workerTree, testId: "tree" }));
    const rootRow = container.querySelector('[data-testid="tree-row-work"]')!;
    expect(rootRow.textContent).toContain(`Σ ${compactTokens(5_400)} tok · ${formatDuration(390_000)}`);
    const workerRow = container.querySelector('[data-testid="tree-row-w1"]')!;
    expect(workerRow.textContent).toContain(compactTokens(1_000));
    expect(workerRow.textContent).not.toContain("Σ");
    // 身份、模型与状态标签在场。
    expect(rootRow.textContent).toContain("CEO");
    expect(rootRow.textContent).toContain("glm-5.3");
    expect(workerRow.textContent).toContain("运行中");
  });

  it("collapses a branch by toggle and restores it", () => {
    const container = mount(createElement(AgentTree, { root: workerTree, testId: "tree" }));
    const squadItem = () => container.querySelector('[data-tree-id="squad"]')!.closest('[role="treeitem"]')!;
    expect(squadItem().getAttribute("aria-expanded")).toBe("true");
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="tree-toggle-squad"]')!.click();
    });
    expect(container.querySelector('[data-testid="tree-row-w1"]')).toBeNull();
    expect(squadItem().getAttribute("aria-expanded")).toBe("false");
    // 折叠后父行 Σ 带后代计数。
    expect(container.querySelector('[data-testid="tree-row-squad"]')!.textContent).toContain("2 节点");
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="tree-toggle-squad"]')!.click();
    });
    expect(container.querySelector('[data-testid="tree-row-w1"]')).not.toBeNull();
  });

  it("collapse-finished folds only terminal branches and keeps running ones expanded", () => {
    const container = mount(createElement(AgentTree, { root: mixedTree, testId: "tree" }));
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="tree-collapse-finished"]')!.click();
    });
    expect(container.querySelector('[data-testid="tree-row-fw1"]')).toBeNull();
    expect(container.querySelector('[data-testid="tree-row-fw2"]')).toBeNull();
    expect(container.querySelector('[data-testid="tree-row-finished"]')!.textContent).toContain("2 节点");
    // 在跑分支保持展开。
    expect(container.querySelector('[data-testid="tree-row-rw1"]')).not.toBeNull();
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="tree-expand-all"]')!.click();
    });
    expect(container.querySelector('[data-testid="tree-row-fw1"]')).not.toBeNull();
  });

  it("hides the collapse-finished action while no branch is fully terminal", () => {
    const container = mount(createElement(AgentTree, { root: workerTree, testId: "tree" }));
    expect(container.querySelector('[data-testid="tree-collapse-finished"]')).toBeNull();
  });

  it("roves focus with arrow keys across the visible rows", () => {
    const container = mount(createElement(AgentTree, { root: workerTree, testId: "tree" }));
    const rows = () => [...container.querySelectorAll<HTMLElement>("[data-tree-id]")];
    act(() => {
      rows()[0]!.focus();
    });
    expect(document.activeElement === rows()[0]!).toBe(true);
    act(() => {
      rows()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement === rows()[1]!).toBe(true);
    act(() => {
      rows()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    // 展开分支上 ArrowRight 进入第一个子行。
    expect(document.activeElement === rows()[2]!).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AgentLanes:泳道、交接连线、待拍板快捷动作与 nowMs 确定性。
// ---------------------------------------------------------------------------

describe("AgentLanes", () => {
  const renderDefaultRange = (ages: readonly number[], testId: string) => {
    const container = mount(
      createElement(AgentLanes, {
        lanes: [
          {
            agentId: "sol",
            role: "Sol",
            tasks: ages.map((ageMinutes, index) => ({
              id: `${testId}-${index}`,
              label: `任务 ${index + 1}`,
              startAt: BASE - ageMinutes * 60_000,
              endAt: BASE - ageMinutes * 60_000 + 60_000,
              status: "done" as const,
            })),
          },
        ],
        nowMs: BASE,
        testId,
      }),
    );
    return [...container.querySelectorAll<HTMLButtonElement>(`[data-testid^="${testId}-range-"]`)].find(
      (button) => button.getAttribute("aria-pressed") === "true",
    )?.dataset.testid;
  };

  it("keeps one older task from widening the four-task default window", () => {
    expect(renderDefaultRange([10, 20, 40, 240], "outlier-lanes")).toBe("outlier-lanes-range-1h");
  });

  it("chooses a supported recent window for one or two tasks", () => {
    expect(renderDefaultRange([40], "single-task-lanes")).toBe("single-task-lanes-range-1h");
    expect(renderDefaultRange([20, 40], "two-task-lanes")).toBe("two-task-lanes-range-30m");
  });

  it("separates four concurrent tasks into non-overlapping subtracks and grows the lane", () => {
    const container = mount(
      createElement(AgentLanes, {
        lanes: [
          {
            agentId: "sol",
            role: "Sol",
            tasks: [
              {
                id: "overlap-1",
                label: "任务一",
                startAt: BASE - 20 * 60_000,
                endAt: BASE - 10 * 60_000,
                status: "running",
              },
              {
                id: "overlap-2",
                label: "任务二",
                startAt: BASE - 19 * 60_000,
                endAt: BASE - 9 * 60_000,
                status: "running",
              },
              {
                id: "overlap-3",
                label: "任务三",
                startAt: BASE - 18 * 60_000,
                endAt: BASE - 8 * 60_000,
                status: "running",
              },
              {
                id: "overlap-4",
                label: "任务四",
                startAt: BASE - 17 * 60_000,
                endAt: BASE - 7 * 60_000,
                status: "running",
              },
            ],
          },
        ],
        nowMs: BASE,
        testId: "concurrent-lanes",
      }),
    );
    const blocks = [...container.querySelectorAll<HTMLElement>('[data-testid^="concurrent-lanes-task-overlap-"]')];
    expect(blocks).toHaveLength(4);
    expect(blocks.map((block) => block.dataset.laneTrack)).toEqual(["0", "1", "2", "3"]);
    expect(blocks.map((block) => Number.parseFloat(block.style.top))).toEqual([29, 69, 109, 149]);
    expect(
      container.querySelector('[data-testid="concurrent-lanes-track"]')?.getAttribute("data-lane-track-count"),
    ).toBe("4");
    const lastBlock = blocks[3]!;
    expect(
      Number.parseFloat(
        container.querySelector('[data-testid="concurrent-lanes-track"]')!.getAttribute("data-height")!,
      ),
    ).toBeGreaterThan(Number.parseFloat(lastBlock.style.top) + Number.parseFloat(lastBlock.style.height));
  });

  it("uses a recent default window, clips older intersecting blocks and lets the user widen the range", () => {
    const container = mount(
      createElement(AgentLanes, {
        lanes: [
          {
            agentId: "sol",
            role: "Sol",
            tasks: [
              {
                id: "old-long",
                label: "四小时前开始的任务",
                startAt: BASE - 4 * 60 * 60_000,
                endAt: BASE - 20 * 60_000,
                status: "done",
              },
              {
                id: "recent-1",
                label: "近期一",
                startAt: BASE - 40 * 60_000,
                endAt: BASE - 35 * 60_000,
                status: "done",
              },
              {
                id: "recent-2",
                label: "近期二",
                startAt: BASE - 30 * 60_000,
                endAt: BASE - 25 * 60_000,
                status: "done",
              },
              {
                id: "recent-3",
                label: "近期三",
                startAt: BASE - 20 * 60_000,
                endAt: BASE - 15 * 60_000,
                status: "done",
              },
              {
                id: "recent-4",
                label: "近期四",
                startAt: BASE - 10 * 60_000,
                endAt: BASE - 5 * 60_000,
                status: "done",
              },
            ],
          },
        ],
        nowMs: BASE,
        testId: "recent-lanes",
      }),
    );
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="recent-lanes-range-1h"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    const oldBlock = container.querySelector<HTMLElement>('[data-testid="recent-lanes-task-old-long"]')!;
    expect(Number.parseFloat(oldBlock.style.left)).toBe(0);
    expect(Number.parseFloat(oldBlock.style.width)).toBeCloseTo((40 / 60) * 100, 5);

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="recent-lanes-range-6h"]')!.click();
    });
    expect(Number.parseFloat(oldBlock.style.left)).toBeCloseTo((2 / 6) * 100, 5);
  });

  it("rounds a short recent-work window down to the nearest supported range", () => {
    const container = mount(
      createElement(AgentLanes, {
        lanes: [
          {
            agentId: "sol",
            role: "Sol",
            tasks: [
              { id: "recent-1", label: "近期一", startAt: BASE - 2 * 60_000, endAt: BASE - 60_000, status: "done" },
              { id: "recent-2", label: "近期二", startAt: BASE - 5 * 60_000, endAt: BASE - 4 * 60_000, status: "done" },
              {
                id: "recent-3",
                label: "近期三",
                startAt: BASE - 10 * 60_000,
                endAt: BASE - 8 * 60_000,
                status: "done",
              },
            ],
          },
        ],
        nowMs: BASE,
        testId: "short-recent-lanes",
      }),
    );
    expect(
      container
        .querySelector<HTMLButtonElement>('[data-testid="short-recent-lanes-range-15m"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("aligns ruler ticks to whole minutes and hides labels that cannot fit readably", () => {
    const container = mount(
      createElement(AgentLanes, {
        lanes: [
          {
            agentId: "agent",
            role: "Agent",
            tasks: [
              {
                id: "tiny",
                label: "不要截成一两个字",
                startAt: BASE - 10 * 60_000,
                endAt: BASE - 10 * 60_000 + 1_000,
                status: "done",
              },
            ],
          },
        ],
        nowMs: BASE + 46_000,
        testId: "readable-lanes",
      }),
    );
    const ticks = [...container.querySelectorAll('[data-testid="readable-lanes-tick-label"]')];
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.map((tick) => tick.textContent).join(" ")).not.toMatch(/\d+s/u);
    const tiny = container.querySelector<HTMLElement>('[data-testid="readable-lanes-task-tiny"]')!;
    expect(tiny.textContent).not.toContain("不要截成一两个字");
    expect(tiny.getAttribute("title")).toContain("不要截成一两个字");
    expect(tiny.getAttribute("aria-label")).toContain("不要截成一两个字");
    expect(tiny.style.minWidth).toBe("8px");
    expect(tiny.className).toContain("justify-center px-0");
    expect(tiny.querySelector("[aria-hidden]")).not.toBeNull();
  });

  it("keeps the label column beside the track and gives both the full expanded lane height", () => {
    const container = mount(
      createElement(AgentLanes, {
        lanes: [
          {
            agentId: "sol",
            role: "Sol",
            tasks: [
              { id: "a", label: "a", startAt: BASE - 20 * 60_000, endAt: BASE - 10 * 60_000, status: "done" },
              { id: "b", label: "b", startAt: BASE - 19 * 60_000, endAt: BASE - 9 * 60_000, status: "done" },
            ],
          },
        ],
        nowMs: BASE,
        testId: "column-lanes",
      }),
    );
    const labels = container.querySelector<HTMLElement>('[data-testid="column-lanes-labels"]')!;
    const track = container.querySelector<HTMLElement>('[data-testid="column-lanes-track"]')!;
    expect(labels.nextElementSibling).toBe(track);
    expect(labels.className).not.toContain("absolute");
    expect(labels.style.width).toBe("144px");
    expect(Number.parseFloat(labels.style.height)).toBe(Number.parseFloat(track.getAttribute("data-height")!));
    expect(Number.parseFloat(track.getAttribute("data-height")!)).toBeGreaterThan(22 + 48);
  });

  it("renders task blocks per lane, handoff connectors, the awaiting badge and proportional widths with injected nowMs", () => {
    const onResolveAwaiting = vi.fn();
    const container = mount(
      createElement(AgentLanes, {
        lanes: [
          {
            agentId: "ceo",
            role: "CEO",
            tasks: [{ id: "t1", label: "派工侦察", startAt: 0, endAt: 60 * 60_000, status: "done" }],
          },
          {
            agentId: "w1",
            role: "Worker-1",
            tasks: [
              { id: "t2", label: "实现泳道", startAt: 90 * 60_000, endAt: null, status: "running" },
              {
                id: "t3",
                label: "等业主拍板",
                startAt: 100 * 60_000,
                endAt: null,
                status: "awaiting",
                awaiting: { question: "选方案 A 还是 B？" },
              },
            ],
          },
        ],
        handoffs: [{ fromTaskId: "t1", toTaskId: "t2", label: "派工" }],
        nowMs: 180 * 60_000,
        onResolveAwaiting,
        testId: "lanes",
      }),
    );
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="lanes-range-3h"]')!.click();
    });
    expect(container.querySelectorAll('[data-testid^="lanes-task-"]').length).toBe(3);
    // handoff:一条虚线曲线路径 + 悬停 title 说明。
    const path = container.querySelector("svg path[d^='M ']");
    expect(path).not.toBeNull();
    expect(path!.getAttribute("stroke-dasharray")).toBe("6 4");
    expect(container.querySelector("svg title")!.textContent).toBe("派工");
    // 选择 3h 窗口覆盖派工与接手:0→60m 的已完成块从窗口左缘开始,宽度占 60m/180m。
    const t1 = container.querySelector<HTMLElement>('[data-testid="lanes-task-t1"]')!;
    expect(t1.getAttribute("data-lane-status")).toBe("done");
    expect(Number.parseFloat(t1.style.left)).toBe(0);
    expect(Number.parseFloat(t1.style.width)).toBeCloseTo((60 / 180) * 100, 10);
    // 待拍板块:徽标按钮可达,点击走快捷动作。
    const resolve = container.querySelector<HTMLButtonElement>('[data-testid="lanes-resolve-t3"]')!;
    expect(resolve.getAttribute("data-tip")).toBe("选方案 A 还是 B？");
    act(() => {
      resolve.click();
    });
    expect(onResolveAwaiting).toHaveBeenCalledWith("t3");
    // 图例在场。
    expect(container.textContent).toContain("派工 / 交接");
    expect(container.textContent).toContain("现在");
  });

  it("skips handoffs that reference unknown tasks instead of crashing", () => {
    const container = mount(
      createElement(AgentLanes, {
        lanes: [
          { agentId: "a", role: "A", tasks: [{ id: "t1", label: "x", startAt: 0, endAt: 10_000, status: "done" }] },
        ],
        handoffs: [{ fromTaskId: "ghost", toTaskId: "t1" }],
        nowMs: 20_000,
      }),
    );
    expect(container.querySelector("svg path[d^='M ']")).toBeNull();
  });

  it("keeps exactly one interval while a task runs without nowMs and clears it when all tasks close", () => {
    useFakeClock();
    const lanes = [
      {
        agentId: "a",
        role: "A",
        tasks: [{ id: "t1", label: "跑着", startAt: BASE - 30_000, endAt: null, status: "running" as const }],
      },
    ];
    mount(createElement(AgentLanes, { lanes }));
    expect(vi.getTimerCount()).toBe(1);
    // 注入 nowMs:卸载 interval。
    rerender(0, createElement(AgentLanes, { lanes, nowMs: BASE }));
    expect(vi.getTimerCount()).toBe(0);
    // 回到实时但全部任务收口:无运行块也不再 tick。
    rerender(
      0,
      createElement(AgentLanes, { lanes: [{ ...lanes[0]!, tasks: [{ ...lanes[0]!.tasks[0]!, endAt: BASE }] }] }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AgentPlan:编辑契约、排序纯函数、运行态计时与失败步重试。
// ---------------------------------------------------------------------------

const editSteps: PlanStep[] = [
  { id: "s1", title: "盘点现状", status: "pending" },
  { id: "s2", title: "实现组件", status: "pending" },
  { id: "s3", title: "补测试", status: "pending" },
];

describe("AgentPlan", () => {
  it("moveStepBefore covers middle-to-front, move-to-end and no-op guards", () => {
    const ids = ["s1", "s2", "s3"];
    expect(moveStepBefore(ids, "s2", "s1")).toEqual(["s2", "s1", "s3"]);
    expect(moveStepBefore(ids, "s1", "end")).toEqual(["s2", "s3", "s1"]);
    expect(moveStepBefore(ids, "s1", "s1")).toEqual(ids);
    expect(moveStepBefore(ids, "ghost", "s1")).toEqual(ids);
    expect(moveStepBefore(ids, "s1", "ghost")).toEqual(ids);
  });

  it("editing phase exposes rename, add and remove contracts with drag handles and insert zones", () => {
    const onRename = vi.fn();
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    const container = mount(
      createElement(AgentPlan, { steps: editSteps, phase: "editing", onRename, onAdd, onRemove, testId: "plan" }),
    );
    expect(container.querySelectorAll('[data-testid^="plan-handle-"]').length).toBe(3);
    expect(container.querySelectorAll('[data-testid^="plan-zone-"]').length).toBe(4);

    // 重命名:点笔进入输入框,Enter 提交。
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="plan-edit-s1"]')!.click();
    });
    const input = container.querySelector<HTMLInputElement>('[data-testid="plan-rename-s1"]')!;
    act(() => {
      setInputValue(input, "重新盘点");
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onRename).toHaveBeenCalledWith("s1", "重新盘点");

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="plan-remove-s2"]')!.click();
    });
    expect(onRemove).toHaveBeenCalledWith("s2");
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="plan-add"]')!.click();
    });
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("running phase shows the live step timer from injected nowMs, final durations and retry-from-step", () => {
    useFakeClock();
    const onRetryFromStep = vi.fn();
    const steps: PlanStep[] = [
      { id: "s1", title: "盘点", status: "done", startedAt: BASE - 60_000, endedAt: BASE - 30_000 },
      { id: "s2", title: "实现", status: "running", startedAt: BASE - 90_000 },
      { id: "s3", title: "测试", status: "failed", startedAt: BASE - 30_000, endedAt: BASE - 10_000 },
    ];
    const container = mount(
      createElement(AgentPlan, { steps, phase: "running", nowMs: BASE, onRetryFromStep, testId: "plan" }),
    );
    // 完成步展示终值时长;运行步按注入 now 计时;注入 nowMs 不建 interval。
    expect(container.querySelector('[data-testid="plan-elapsed-s1"]')!.textContent).toBe(formatDuration(30_000));
    expect(container.querySelector('[data-testid="plan-elapsed-s2"]')!.textContent).toBe(formatDuration(90_000));
    expect(container.querySelector('[data-testid="plan-elapsed-s3"]')!.textContent).toBe(formatDuration(20_000));
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector('[data-testid="plan-step-s2"]')!.classList.contains("live-row")).toBe(true);
    // 运行态没有编辑控件。
    expect(container.querySelector('[data-testid="plan-add"]')).toBeNull();
    expect(container.querySelector('[data-testid="plan-handle-s1"]')).toBeNull();
    // 失败步原位重试。
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="plan-retry-s3"]')!.click();
    });
    expect(onRetryFromStep).toHaveBeenCalledWith("s3");
  });

  it("ticks one interval for the running step without nowMs and stops when it closes", () => {
    useFakeClock();
    const step: PlanStep = { id: "s1", title: "实现", status: "running", startedAt: BASE - 1_000 };
    mount(createElement(AgentPlan, { steps: [step], phase: "running" }));
    expect(vi.getTimerCount()).toBe(1);
    rerender(0, createElement(AgentPlan, { steps: [{ ...step, status: "done", endedAt: BASE }], phase: "running" }));
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AgentSteering:插话入队、撤回、中断与队列 → 步骤卡的 FLIP 流转。
// ---------------------------------------------------------------------------

function SteeringFlowHarness() {
  const [notes, setNotes] = useState<SteerNote[]>([
    { id: "n1", text: "补充:记得检查边界", createdAt: BASE, state: "queued", targetStepId: "s2" },
  ]);
  const [steps, setSteps] = useState<PlanStep[]>([
    { id: "s1", title: "盘点", status: "done" },
    { id: "s2", title: "实现", status: "running" },
  ]);
  return createElement(
    AppMotionConfig,
    null,
    createElement(
      "div",
      null,
      createElement(AgentSteering, {
        notes,
        running: true,
        steps: steps.map((step) => ({ id: step.id, title: step.title })),
        onEnqueue: (text, targetStepId) =>
          setNotes((current) => [
            ...current,
            { id: `n${current.length + 1}`, text, targetStepId, createdAt: BASE, state: "queued" },
          ]),
        onWithdraw: (noteId) => setNotes((current) => current.filter((note) => note.id !== noteId)),
        layoutGroupId: "flow",
        testId: "steer",
      }),
      createElement(AgentPlan, {
        steps,
        phase: "running",
        onRetryFromStep: (id) =>
          setSteps((current) => current.map((step) => (step.id === id ? { ...step, status: "running" } : step))),
        layoutGroupId: "flow",
        testId: "plan",
      }),
      createElement(
        "button",
        {
          "data-testid": "absorb",
          onClick: () =>
            setSteps((current) =>
              current.map((step) =>
                step.id === "s2" ? { ...step, steerNotes: notes.filter((note) => note.state === "absorbed") } : step,
              ),
            ),
        },
        "吸收",
      ),
      createElement(
        "button",
        {
          "data-testid": "advance",
          onClick: () =>
            setNotes((current) =>
              current.map((note) => (note.state === "queued" ? { ...note, state: "absorbed" } : note)),
            ),
        },
        "推进",
      ),
    ),
  );
}

describe("AgentSteering", () => {
  it("enqueues a steer note with its target step, withdraws it and fires interrupt", () => {
    const onEnqueue = vi.fn();
    const onWithdraw = vi.fn();
    const onInterrupt = vi.fn();
    const container = mount(
      createElement(AgentSteering, {
        notes: [{ id: "n1", text: "先看预算", createdAt: BASE, state: "queued" }],
        running: true,
        steps: [{ id: "s1", title: "盘点" }],
        onEnqueue,
        onWithdraw,
        onInterrupt,
        testId: "steer",
      }),
    );
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="steer-textarea"]')!;
    act(() => {
      setInputValue(textarea, "改用方案 B");
    });
    const target = container.querySelector<HTMLSelectElement>('[data-testid="steer-target"]')!;
    act(() => {
      setInputValue(target, "s1");
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="steer-enqueue"]')!.click();
    });
    expect(onEnqueue).toHaveBeenCalledWith("改用方案 B", "s1");
    // 提交后草稿清空。
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="steer-textarea"]')!.value).toBe("");

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="steer-withdraw-n1"]')!.click();
    });
    expect(onWithdraw).toHaveBeenCalledWith("n1");
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="steer-interrupt"]')!.click();
    });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("disables enqueue and textarea when the agent is not running", () => {
    const container = mount(
      createElement(AgentSteering, { notes: [], running: false, onEnqueue: () => {}, testId: "steer" }),
    );
    expect((container.querySelector('[data-testid="steer-enqueue"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="steer-textarea"]') as HTMLTextAreaElement).disabled).toBe(true);
    expect(container.textContent).toContain("Agent 未在运行");
  });

  it("moves a queued note into the target step card through the shared layoutId flow", () => {
    const container = mount(createElement(SteeringFlowHarness));
    // 队列在场,步骤卡尚无纸条。
    expect(container.querySelector('[data-testid="steer-note-n1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plan-note-n1"]')).toBeNull();

    // Agent 推进:纸条转 absorbed,吸收进目标步骤卡 s2。
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="advance"]')!.click();
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="absorb"]')!.click();
    });
    expect(container.querySelector('[data-testid="steer-note-n1"]')).toBeNull();
    const noteInPlan = container.querySelector('[data-testid="plan-note-n1"]')!;
    expect(noteInPlan.textContent).toBe("补充:记得检查边界");
    expect(container.querySelector('[data-testid="plan-step-s2"]')!.contains(noteInPlan)).toBe(true);
    // 队列空态提示。
    expect(container.querySelector('[data-testid="steer"]')!.textContent).toContain("队列为空");
  });
});

// ---------------------------------------------------------------------------
// en-US 文案(CEO 返工裁定 F3):组件文案全部经 agentUi.* i18n,切到 en-US 后
// 按钮、状态词与占位符同步换语言,不留字面中文。
// ---------------------------------------------------------------------------

describe("agentUi i18n (en-US)", () => {
  it("renders buttons, status words and placeholders in en-US after the locale switch", () => {
    setActiveLocale("en-US");
    const steer = mount(
      createElement(AgentSteering, {
        notes: [],
        running: true,
        steps: [{ id: "s1", title: "Survey" }],
        onEnqueue: () => {},
        testId: "steer-en",
      }),
    );
    expect(steer.querySelector('[data-testid="steer-en-enqueue"]')!.textContent).toContain("Add to queue");
    expect(steer.querySelector<HTMLTextAreaElement>('[data-testid="steer-en-textarea"]')!.placeholder).toContain(
      "absorbed when the agent advances",
    );
    expect(steer.querySelector('[data-testid="steer-en-target"] option[value=""]')!.textContent).toBe("Next step");

    const tree = mount(
      createElement(AgentTree, {
        root: { id: "root", role: "CEO", status: "running", ownTokens: 10, children: [] },
        testId: "tree-en",
      }),
    );
    // 状态词经 StatusTag 渲染 en-US 词面。
    expect(tree.querySelector('[data-testid="tree-en-row-root"]')!.textContent).toContain("Running");

    const plan = mount(
      createElement(AgentPlan, {
        steps: [{ id: "s1", title: "Survey", status: "failed" }],
        phase: "running",
        nowMs: BASE,
        onRetryFromStep: () => {},
        testId: "plan-en",
      }),
    );
    expect(plan.querySelector('[data-testid="plan-en-retry-s1"]')!.textContent).toContain("Retry from step");
  });
});
