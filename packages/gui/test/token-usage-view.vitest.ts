// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TokenUsageView } from "../src/renderer/views/TokenUsageView.tsx";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import type {
  AgentRuntimeTokenUsageDetailResult,
  AgentRuntimeTokenUsageResult,
} from "@harness-anything/daemon/protocol";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

import {
  axisScale,
  cacheHitRate,
  periodChange,
  rankBarShare,
  rankLogFloor,
  rankScaleFor,
  sessionBinLabel,
  successRate,
  tokenComposition,
  tokensPerSuccess,
} from "../src/renderer/token-usage-model.ts";
import { percentText, preciseTokens } from "../src/renderer/token-format.ts";

/**
 * 系统 Tab「Token 消耗」分析页:daemon 聚合读(repo.agentRuntime.tokenUsage / tokenUsageDetail)
 * 的渲染面。逐条对着页面要回答的问题断言:总量与环比、三类 token 构成与缓存命中率、趋势与悬停
 * 明细、谁花的、花在什么事上、单个会话、值不值、未上报的 provider;「未上报」与 0 分开,
 * 成员详情经 focusedEntityRef 推栈并能跳会话/任务。
 */

const noOutcomes = { succeededSessions: 0, failedSessions: 0, abortedSessions: 0 };

const usage: AgentRuntimeTokenUsageResult = {
  ok: true,
  status: "ready",
  range: "today",
  since: "2026-09-18T00:00:00.000Z",
  bucketMs: 3_600_000,
  totals: {
    sessionCount: 3,
    inputTokens: 13_500,
    cacheReadTokens: 340,
    cacheWriteTokens: 4,
    outputTokens: 1_160,
    totalTokens: 15_000,
    toolCallCount: 57,
    usageReportedDispatches: 2,
    usageUnavailableDispatches: 3,
    // 新输入 13,156×$4 + 缓存读 340×$0.4 + 缓存写 4×$5 + 输出 1,160×$20(每 1M,gpt-5.6-sol 价,
    // 写价 = 输入价 1.25 倍)。
    costUsd: 0.075_98,
    // swe2 那 120 个 token 无公开价,不计入金额。
    unpricedTokens: 120,
  },
  pricing: { version: "2026-10-10" },
  buckets: [
    {
      bucketStart: "2026-09-18T12:00:00.000Z",
      dispatchCount: 1,
      inputTokens: 1_500,
      cacheReadTokens: 340,
      cacheWriteTokens: 4,
      outputTokens: 260,
      totalTokens: 2_100,
      toolCallCount: 17,
      usageReportedDispatches: 1,
      usageUnavailableDispatches: 0,
      costUsd: 0.009_98,
    },
    {
      bucketStart: "2026-09-18T13:00:00.000Z",
      dispatchCount: 1,
      inputTokens: 12_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 900,
      totalTokens: 12_900,
      toolCallCount: 40,
      usageReportedDispatches: 1,
      usageUnavailableDispatches: 0,
      costUsd: 0.066,
    },
  ],
  agents: [
    {
      agentId: "terra",
      agentName: "Terra",
      sessionCount: 2,
      inputTokens: 1_500,
      cacheReadTokens: 340,
      cacheWriteTokens: 4,
      outputTokens: 260,
      totalTokens: 2_100,
      toolCallCount: 17,
      usageReportedDispatches: 1,
      usageUnavailableDispatches: 0,
      succeededSessions: 1,
      failedSessions: 1,
      abortedSessions: 0,
      costUsd: 0.009_98,
      unpricedTokens: 0,
    },
    {
      agentId: "sol",
      agentName: "Sol",
      sessionCount: 1,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCallCount: 3,
      usageReportedDispatches: 0,
      usageUnavailableDispatches: 2,
      ...noOutcomes,
      costUsd: 0,
      unpricedTokens: 0,
    },
  ],
  squads: [
    {
      squadId: "core-squad",
      squadName: "Core",
      sessionCount: 3,
      inputTokens: 12_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 900,
      totalTokens: 12_900,
      toolCallCount: 40,
      usageReportedDispatches: 1,
      usageUnavailableDispatches: 1,
      ...noOutcomes,
      costUsd: 0.066,
      unpricedTokens: 0,
    },
  ],
  models: [
    {
      model: "gpt-5.6-sol",
      sessionCount: 1,
      inputTokens: 12_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 900,
      totalTokens: 12_900,
      toolCallCount: 40,
      usageReportedDispatches: 1,
      usageUnavailableDispatches: 0,
      succeededSessions: 1,
      failedSessions: 0,
      abortedSessions: 0,
      costUsd: 0.066,
      unpricedTokens: 0,
    },
    {
      model: "swe2",
      sessionCount: 2,
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
      totalTokens: 120,
      toolCallCount: 17,
      usageReportedDispatches: 1,
      usageUnavailableDispatches: 0,
      succeededSessions: 1,
      failedSessions: 1,
      abortedSessions: 0,
      costUsd: 0,
      unpricedTokens: 120,
    },
  ],
  previous: {
    since: "2026-09-17T00:00:00.000Z",
    until: "2026-09-17T13:30:00.000Z",
    totals: {
      sessionCount: 2,
      inputTokens: 9_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
      totalTokens: 10_000,
      toolCallCount: 20,
      usageReportedDispatches: 2,
      usageUnavailableDispatches: 0,
      costUsd: 0.056,
      unpricedTokens: 0,
    },
  },
  tasks: [
    {
      taskId: "task-big",
      title: "Rework the read surface",
      workId: "work-root",
      workTitle: "Release line",
      sessionCount: 1,
      totalTokens: 12_900,
      costUsd: 0.066,
    },
    {
      taskId: "task-small",
      title: "Fix a typo",
      workId: "task-small",
      workTitle: "Fix a typo",
      sessionCount: 2,
      totalTokens: 2_100,
      costUsd: 0.009_98,
    },
  ],
  works: [
    { workId: "work-root", title: "Release line", taskCount: 1, sessionCount: 1, totalTokens: 12_900, costUsd: 0.066 },
  ],
  sessions: {
    reportedSessions: 2,
    averageTokens: 7_500,
    medianTokens: 1_000,
    p90Tokens: 12_900,
    maxTokens: 12_900,
    averageDurationMs: 300_000,
    timedSessions: 2,
    averageToolCalls: 19,
    distribution: [
      { ceiling: 10_000, sessionCount: 1, totalTokens: 2_100 },
      { ceiling: 100_000, sessionCount: 1, totalTokens: 12_900 },
      { ceiling: 1_000_000, sessionCount: 0, totalTokens: 0 },
      { ceiling: 10_000_000, sessionCount: 0, totalTokens: 0 },
      { ceiling: 100_000_000, sessionCount: 0, totalTokens: 0 },
      { ceiling: null, sessionCount: 0, totalTokens: 0 },
    ],
    top: [
      {
        runtimeSessionId: "runtime-big",
        agentId: "terra",
        agentName: "Terra",
        taskId: "task-big",
        taskTitle: "Rework the read surface",
        model: "gpt-5.6-sol",
        startedAt: "2026-09-18T13:00:00.000Z",
        durationMs: 540_000,
        outcome: "succeeded",
        totalTokens: 12_900,
        toolCallCount: 40,
      },
      {
        runtimeSessionId: "runtime-small",
        agentId: null,
        agentName: null,
        taskId: null,
        taskTitle: null,
        model: null,
        startedAt: "2026-09-18T12:00:00.000Z",
        durationMs: null,
        outcome: "failed",
        totalTokens: 2_100,
        toolCallCount: 17,
      },
    ],
  },
  outcomes: [
    { outcome: "succeeded", sessionCount: 1, totalTokens: 12_900 },
    { outcome: "failed", sessionCount: 1, totalTokens: 1_500 },
    { outcome: "aborted", sessionCount: 1, totalTokens: 600 },
    { outcome: "running", sessionCount: 0, totalTokens: 0 },
    { outcome: "unknown", sessionCount: 0, totalTokens: 0 },
  ],
  trend: {
    agents: [
      { key: "terra", name: "Terra", totalTokens: [2_100, 12_000] },
      { key: null, name: "", totalTokens: [0, 900] },
    ],
    models: [{ key: "gpt-5.6-sol", name: "gpt-5.6-sol", totalTokens: [2_100, 12_900] }],
  },
  unreported: [
    { kindId: "zcode", instanceId: "zcode-main", dispatchCount: 2 },
    { kindId: "claude", instanceId: "claude-main", dispatchCount: 1 },
  ],
  watermark: 3,
  sourceRevision: 3,
};

const detail: AgentRuntimeTokenUsageDetailResult = {
  ok: true,
  status: "ready",
  range: "today",
  since: "2026-09-18T00:00:00.000Z",
  bucketMs: 3_600_000,
  member: { kind: "agent", agentId: "terra", agentName: "Terra" },
  totals: {
    sessionCount: 2,
    inputTokens: 1_500,
    cacheReadTokens: 340,
    cacheWriteTokens: 4,
    outputTokens: 260,
    totalTokens: 2_100,
    toolCallCount: 17,
    usageReportedDispatches: 2,
    usageUnavailableDispatches: 0,
    costUsd: 0.009_98,
    unpricedTokens: 0,
  },
  pricing: { version: "2026-10-10" },
  buckets: usage.buckets,
  sessions: [
    {
      dispatchId: "dispatch_00000000000000000000aa01",
      runtimeSessionId: "runtime-terra",
      taskId: "task-tokens",
      model: "swe2",
      startedAt: "2026-09-18T12:00:00.000Z",
      endedAt: "2026-09-18T12:05:00.000Z",
      durationMs: 300_000,
      outcome: "succeeded",
      inputTokens: 1_500,
      cacheReadTokens: 340,
      cacheWriteTokens: 4,
      outputTokens: 260,
      totalTokens: 2_100,
      toolCallCount: 17,
      usage: "reported",
    },
    {
      dispatchId: "dispatch_00000000000000000000aa02",
      runtimeSessionId: "runtime-sol",
      taskId: null,
      model: null,
      startedAt: "2026-09-18T11:00:00.000Z",
      endedAt: null,
      durationMs: null,
      outcome: "running",
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCallCount: 0,
      usage: "unavailable",
    },
  ],
  watermark: 3,
  sourceRevision: 3,
};

let mounted: { readonly root: Root; readonly client: QueryClient }[] = [];
let focusedMemberRef: string | null = null;
const onSelectEntity = vi.fn(),
  onOpenTask = vi.fn();

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const { root } of mounted) root.unmount();
  mounted = [];
  focusedMemberRef = null;
  onSelectEntity.mockReset();
  onOpenTask.mockReset();
});

async function renderView(): Promise<HTMLDivElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TokenUsageView, {
          repoId: "canonical",
          focusedEntityRef: focusedMemberRef,
          onFocusMember: (ref) => {
            focusedMemberRef = ref;
          },
          onSelectEntity,
          onOpenTask,
        }),
      ),
    );
  });
  for (let round = 0; round < 4; round += 1)
    await act(async () => {
      await Promise.resolve();
    });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  expect(button, `button ${label}`).toBeTruthy();
  return button!;
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement => {
  const element = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(element, testId).toBeTruthy();
  return element!;
};

describe("TokenUsageView", () => {
  it("leads with the total, the change against the previous period and the composition", async () => {
    const tokenUsage = vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    expect(tokenUsage).toHaveBeenCalledWith("canonical", "today");
    const totals = byTestId(container, "token-usage-totals");
    expect(totals.textContent).toContain("15K");
    // 环比:15,000 对上一周期的 10,000 = 多 50%,并说出参照周期与当时的量。
    const change = byTestId(container, "token-usage-change");
    expect(change.textContent).toContain("50%");
    expect(change.textContent).toContain("more than the same hours yesterday (10K then)");
    // 构成四段互不重叠,加起来等于总量:缓存读 340 + 缓存写 4 + 新输入 13,156 + 输出 1,160。
    const composition = byTestId(container, "token-usage-composition");
    expect(composition.textContent).toContain("Cache read340");
    expect(composition.textContent).toContain("Cache write4");
    expect(composition.textContent).toContain("Fresh input13.2K");
    expect(composition.textContent).toContain("Output tokens1.16K");
    // 缓存写的口径说明:独立计数起点、历史并入新输入、未上报按 0。
    expect(byTestId(container, "token-usage-cache-write-note").textContent).toContain(
      "counted separately and priced at the cache-write rate since 2026-10-10",
    );
    // 有派工未上报时明说总量是下界。
    expect(byTestId(container, "token-usage-conclusion").textContent).toContain("3 dispatches");
    // 折算金额:口径(公开价、非实际花费)、价格表版本与未计价占比都在大数字旁边。
    const cost = byTestId(container, "token-usage-cost").textContent ?? "";
    expect(cost).toContain("$0.08");
    expect(cost).toContain("converted at public API list prices, not actual spend");
    expect(cost).toContain("price table 2026-10-10");
    expect(cost).toContain("0.8% of usage (120 tokens) has no public price and is excluded");
    // 计价与用量同等分量:两个主指标同为 44px 主数字,金额侧有自己的环比
    // (0.07598 对 0.056,显示 +36%;参照段金额 $0.06)与「哪些是下界」的口径说明。
    expect(byTestId(container, "token-usage-totals").querySelector("p")?.className).toContain("text-[44px]");
    expect(byTestId(container, "token-usage-cost").querySelector("p")?.className).toContain("text-[44px]");
    const costChange = byTestId(container, "token-usage-cost-change").textContent ?? "";
    expect(costChange).toContain("36%");
    expect(costChange).toContain("more than the same hours yesterday ($0.06 then)");
    expect(byTestId(container, "token-usage-cost-precision").textContent).toContain(
      "long-context, peak-hour and cache-storage surcharges are not applied",
    );
    // 四个关键数字:会话、缓存命中率(340/13,500)、白花(2,100/15,000)、未上报。
    const view = byTestId(container, "token-usage-view").textContent ?? "";
    expect(view).toContain("Cache hit rate2.5%");
    expect(view).toContain("Spent on failed or aborted14%");
    expect(view).toContain("2 sessions, 2.1K tokens");
    // 每一条文案的插值都被填上。
    expect(view).not.toMatch(/\{[a-zA-Z]+\}/u);
  });

  it("says there is nothing to compare when the previous period is empty", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue({
      ...usage,
      previous: { ...usage.previous, totals: { ...usage.previous.totals, totalTokens: 0 } },
    });
    const container = await renderView();
    expect(byTestId(container, "token-usage-change").textContent).toBe(
      "No consumption in the same hours yesterday to compare against",
    );
  });

  it("says the cost has no base when the previous period has no priced amount", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue({
      ...usage,
      previous: { ...usage.previous, totals: { ...usage.previous.totals, costUsd: 0 } },
    });
    const container = await renderView();
    expect(byTestId(container, "token-usage-cost-change").textContent).toBe(
      "No converted amount in the same hours yesterday to compare against",
    );
  });

  it("switches the range and refetches with the selector", async () => {
    const tokenUsage = vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    act(() => findButton(container, "7 days").click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(tokenUsage).toHaveBeenLastCalledWith("canonical", "7d");
  });

  it("draws one stacked bar per bucket, labels the peak and reads a bucket out on hover and arrow keys", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    const bars = container.querySelectorAll('[data-testid^="token-usage-trend-bar-"]');
    expect(bars.length).toBe(2);
    const chart = byTestId(container, "token-usage-trend"),
      svg = chart.querySelector("svg")!;
    // 只有最高柱直接标值;纵轴最上一条刻度不低于峰值。
    expect([...svg.querySelectorAll("text")].filter((text) => text.textContent === "12.9K").length).toBe(1);
    expect([...svg.querySelectorAll("text")].some((text) => text.textContent === "15K")).toBe(true);
    expect(container.querySelector('[data-testid="token-usage-trend-readout"]')).toBeNull();
    // 悬停第一桶:明细列出每一层的数值与占比、派工数与缓存命中率。
    const hit = bars[0]!.lastElementChild!;
    act(() => {
      hit.dispatchEvent(new Event("pointermove", { bubbles: true }));
    });
    const readout = byTestId(container, "token-usage-trend-readout").textContent ?? "";
    expect(readout).toContain("2.1K");
    expect(readout).toContain("Cache read340");
    expect(readout).toContain("1 dispatches");
    expect(readout).toContain("cache hit 23%");
    // 悬停明细带该桶的折算金额。
    expect(readout).toContain("converted <$0.01");
    // 键盘右键移到下一桶(峰值桶)。
    act(() => {
      svg.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(byTestId(container, "token-usage-trend-readout").textContent).toContain("12.9K");
  });

  it("restacks the trend by worker or model with a legend naming every series", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    const legend = () => byTestId(container, "token-usage-trend-legend").textContent ?? "";
    expect(legend()).toContain("Cache read");
    act(() => findButton(container, "By worker").click());
    expect(legend()).toContain("Terra14.1K");
    expect(legend()).toContain("Everything else900");
    act(() => findButton(container, "By model").click());
    expect(legend()).toContain("gpt-5.6-sol15K");
    // 表格等价视图跟着同一组层:每个系列一列。
    act(() => findButton(byTestId(container, "token-usage-trend-card"), "Table").click());
    const table = byTestId(container, "token-usage-trend-table");
    expect([...table.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "Bucket",
      "Dispatches",
      "gpt-5.6-sol",
      "Total tokens",
      "Converted cost",
    ]);
  });

  it("ranks workers, squads and models with value and share side by side", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    const rankRow = byTestId(container, "token-usage-rank-terra");
    expect(rankRow.textContent).toContain("Terra");
    expect(rankRow.textContent).toContain("2.1K");
    expect(rankRow.textContent).toContain("14%");
    expect(rankRow.textContent).toContain("2 sessions · 17 tool calls");
    // 金额与 token 量同一层级:同一行的兄弟格(与「花在什么事上」同序:金额、量、占比)。
    const line = rankRow.querySelector("span")!;
    const cells = [...line.children].map((cell) => cell.textContent);
    expect(cells).toContain("<$0.01");
    expect(cells.indexOf("<$0.01")).toBeLessThan(cells.indexOf("2.1K"));
    // 未上报成员显示徽标而不是 0。
    expect(byTestId(container, "token-usage-rank-sol").textContent).toContain("Not reported");
    // 模型排行:量级差 100 倍以上默认对数刻度,小的那条仍然看得出长度;模型行不可点。
    act(() => findButton(container, "Model").click());
    const small = byTestId(container, "token-usage-rank-swe2");
    expect(small.tagName).toBe("DIV");
    // 无公开价的模型显示「无价格」而不是 $0.00。
    expect(small.textContent).toContain("no price");
    expect(small.textContent).not.toContain("$0.00");
    expect(findButton(container, "Log").getAttribute("aria-pressed")).toBe("true");
    const barWidth = (row: HTMLElement): number =>
      Number.parseFloat(row.querySelector<HTMLElement>("[style*='width']")!.style.width);
    const logWidth = barWidth(small);
    expect(logWidth).toBeGreaterThan(20);
    act(() => findButton(container, "Linear").click());
    expect(barWidth(byTestId(container, "token-usage-rank-swe2"))).toBeCloseTo((120 / 12_900) * 100, 3);
    expect(byTestId(container, "token-usage-rank-swe2").textContent).toContain("0.8%");
  });

  it("presents the ranking as a donut with tokens and cost side by side on both bases", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    act(() => findButton(container, "Donut").click());
    // 环心同时给窗口总量与总金额:两个数同层级。
    const center = byTestId(container, "token-usage-share-center").textContent ?? "";
    expect(center).toContain("15K");
    expect(center).toContain("$0.08");
    // 图例行金额、token、占比并排;未上报成员显示徽标而不是 0。
    const terra = byTestId(container, "token-usage-share-row-terra").textContent ?? "";
    expect(terra).toContain("<$0.01");
    expect(terra).toContain("2.1K");
    expect(terra).toContain("14%");
    expect(byTestId(container, "token-usage-share-row-sol").textContent).toContain("Not reported");
    // token 口径下零值成员无弧:Worker 视角只有 terra 一条弧。
    expect(container.querySelectorAll('[data-testid^="token-usage-share-arc-"]').length).toBe(1);
    // 模型维度:两个有值模型两条弧;无价格模型的金额格写「无价格」。
    act(() => findButton(container, "Model").click());
    expect(container.querySelectorAll('[data-testid^="token-usage-share-arc-"]').length).toBe(2);
    expect(byTestId(container, "token-usage-share-row-swe2").textContent).toContain("no price");
    // 金额口径:无价模型金额为 0、无弧,只剩有价模型一条弧;环心口径不变。
    act(() => findButton(container, "Cost").click());
    expect(container.querySelectorAll('[data-testid^="token-usage-share-arc-"]').length).toBe(1);
    expect(byTestId(container, "token-usage-share-center").textContent).toContain("$0.08");
    // 点图例行打开成员详情,与清单同一条路。
    act(() => findButton(container, "Tokens").click());
    act(() => findButton(container, "Worker").click());
    act(() => byTestId(container, "token-usage-share-row-terra").click());
    expect(focusedMemberRef).toBe("tokenAgent/terra");
  });

  it("draws one line per series for the trend and reads a bucket out on hover and arrow keys", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    act(() => findButton(byTestId(container, "token-usage-trend-card"), "Line").click());
    const chart = byTestId(container, "token-usage-trend-line"),
      svg = chart.querySelector("svg")!;
    // 四类 token 各一条线;纵轴最高刻度不低于最高单层值(新输入 13,156)。
    expect(chart.querySelectorAll("polyline").length).toBe(4);
    expect([...svg.querySelectorAll("text")].some((text) => text.textContent === "15K")).toBe(true);
    expect(container.querySelector('[data-testid="token-usage-trend-readout"]')).toBeNull();
    // 悬停第一桶:明细复用柱状的同一条路,给出每层数值与占比。
    const hit = svg.querySelector("rect[fill='transparent']")!;
    act(() => {
      hit.dispatchEvent(new Event("pointermove", { bubbles: true }));
    });
    const readout = byTestId(container, "token-usage-trend-readout").textContent ?? "";
    expect(readout).toContain("2.1K");
    expect(readout).toContain("Cache read340");
    expect(readout).toContain("converted <$0.01");
    // 键盘右键移到下一桶(总量峰值桶)。
    act(() => {
      svg.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(byTestId(container, "token-usage-trend-readout").textContent).toContain("12.9K");
    // 图例带窗口合计与占比,与柱状共用。
    expect(byTestId(container, "token-usage-trend-legend").textContent).toContain("Cache read");
  });

  it("opens the member detail by ref, with session/task jumps and back", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const detailRead = vi.spyOn(agentRuntimeClient, "tokenUsageDetail").mockResolvedValue(detail);
    const container = await renderView();
    act(() => byTestId(container, "token-usage-rank-terra").click());
    expect(focusedMemberRef).toBe("tokenAgent/terra");
    // focusedEntityRef 变化 = App 推栈后重渲;这里直接以新 ref 再渲一次。
    const rerendered = await renderView();
    expect(detailRead).toHaveBeenCalledWith("canonical", { kind: "agent", agentId: "terra" }, "today");
    const sessionRow = byTestId(rerendered, "token-usage-session-dispatch_00000000000000000000aa01");
    expect(rerendered.textContent).not.toMatch(/\{[a-zA-Z]+\}/u);
    // 详情总量卡带折算金额。
    expect(byTestId(rerendered, "token-usage-detail-totals").textContent).toContain("<$0.01");
    expect(sessionRow.textContent).toContain("runtime-terra");
    expect(sessionRow.textContent).toContain("task-tokens");
    // 未上报会话行的阴性对照:与 SessionsPanel 同一「provider 未上报」措辞,不是裸 0。
    expect(byTestId(rerendered, "token-usage-session-dispatch_00000000000000000000aa02").textContent).toContain(
      "Unavailable (provider reports no tokens)",
    );
    act(() => byTestId(rerendered, "token-usage-detail-back").click());
    expect(focusedMemberRef).toBeNull();
  });

  it("switches the ranking to its table equivalent with success rate and cost per success", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    act(() => findButton(byTestId(container, "token-usage-ranking-card"), "Table").click());
    const table = byTestId(container, "token-usage-agents-table");
    // 表格视图保留完整行:terra 的精确值进 title。
    expect(table.querySelector('td[title="2,100"]')?.textContent).toBe("2.1K");
    const terra = byTestId(container, "token-usage-row-terra").textContent ?? "";
    expect(terra).toContain("50%");
    expect(terra).toContain("2.1K");
    // 表格视图带折算金额列。
    expect(terra).toContain("<$0.01");
    // 还没有会话结束的成员没有成功率,不写成 0%。
    expect(byTestId(container, "token-usage-row-sol").textContent).toContain("—");
  });

  it("lists what the tokens were spent on by task title and opens the task", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    const task = byTestId(container, "token-usage-spend-task-big");
    expect(task.textContent).toContain("Rework the read surface");
    expect(task.textContent).toContain("12.9K");
    expect(task.textContent).toContain("86%");
    // 任务/工作行带折算金额。
    expect(task.textContent).toContain("$0.07");
    expect(task.textContent).toContain("Release line · 1 sessions");
    // 自成一个工作的任务不重复写工作名。
    expect(byTestId(container, "token-usage-spend-task-small").textContent).not.toContain("Fix a typo ·");
    act(() => task.click());
    expect(onOpenTask).toHaveBeenCalledWith("task-big");
    act(() => findButton(container, "Works").click());
    const work = byTestId(container, "token-usage-spend-work-root");
    expect(work.textContent).toContain("1 tasks · 1 sessions");
    act(() => work.click());
    expect(onOpenTask).toHaveBeenLastCalledWith("work-root");
  });

  it("describes a single session: statistics, size distribution and the largest ones", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    const sessions = byTestId(container, "token-usage-sessions").textContent ?? "";
    expect(sessions).toContain("Average7.5K");
    expect(sessions).toContain("Median1K");
    expect(sessions).toContain("Largest12.9K");
    expect(sessions).toContain("average run 5m");
    // 默认读出会话最多的一档(并列时取靠前的);聚焦另一档读出那一档。
    const readout = () => byTestId(container, "token-usage-distribution-readout").textContent ?? "";
    expect(readout()).toBe("<10K: 1 sessions (50%), 2.1K spent (14% of the total)");
    act(() => byTestId(container, "token-usage-bin-1").focus());
    expect(readout()).toBe("10K–100K: 1 sessions (50%), 12.9K spent (86% of the total)");
    // 最大的会话:任务标题、离群标记(中位数 10 倍以上)、可跳会话页;没有任务的会话显示会话 id。
    const top = byTestId(container, "token-usage-top-session-runtime-big");
    expect(top.textContent).toContain("Rework the read surface");
    expect(top.textContent).toContain("13× the median");
    expect(top.textContent).toContain("Terra · gpt-5.6-sol · 9m · 40 tool calls");
    const small = byTestId(container, "token-usage-top-session-runtime-small");
    expect(small.textContent).toContain("runtime-small");
    expect(small.textContent).not.toContain("the median");
    expect(small.textContent).toContain("Failed");
    act(() => top.click());
    expect(onSelectEntity).toHaveBeenCalledWith("session/runtime-big");
  });

  it("shows what failed or aborted sessions cost and each worker's success rate", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    const worth = byTestId(container, "token-usage-worth").textContent ?? "";
    expect(worth).toContain("14%");
    expect(worth).toContain("2 sessions, 2.1K tokens");
    // 结果图例只列出现过的结果。
    const outcomes = byTestId(container, "token-usage-outcomes").textContent ?? "";
    expect(outcomes).toContain("Succeeded112.9K");
    expect(outcomes).toContain("Aborted1600");
    expect(outcomes).not.toContain("Running");
    const terra = byTestId(container, "token-usage-efficiency-terra").textContent ?? "";
    expect(terra).toContain("50%");
    expect(terra).toContain("1/2");
    expect(terra).toContain("2.1K");
    // 没有任何会话结束的 worker 不进效率表。
    expect(container.querySelector('[data-testid="token-usage-efficiency-sol"]')).toBeNull();
  });

  it("names the providers behind unreported dispatches and what the count means", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    const unreported = byTestId(container, "token-usage-unreported").textContent ?? "";
    expect(unreported).toContain("3 finished dispatches came back without token usage");
    expect(unreported).toContain("zcode");
    expect(unreported).toContain("zcode-main");
    expect(unreported).toContain("claude-main");
    // 阴性对照:全部上报时这一块整个不出现。
    act(() => {
      for (const { root } of mounted) root.unmount();
    });
    mounted = [];
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue({
      ...usage,
      totals: { ...usage.totals, usageUnavailableDispatches: 0 },
      unreported: [],
    });
    const clean = await renderView();
    expect(clean.querySelector('[data-testid="token-usage-unreported"]')).toBeNull();
    expect(clean.querySelector('[data-testid="token-usage-conclusion"]')).toBeNull();
  });

  it("states honestly when nothing was consumed in the range", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue({
      ...usage,
      totals: { ...usage.totals, sessionCount: 0, usageUnavailableDispatches: 0 },
      buckets: usage.buckets.map((bucket) => ({ ...bucket, dispatchCount: 0 })),
      agents: [],
      squads: [],
      models: [],
      tasks: [],
      works: [],
      unreported: [],
    });
    const container = await renderView();
    expect(container.textContent).toContain("No attributed dispatch consumption in this range yet.");
    expect(container.textContent).toContain("No dispatch in this range was bound to a task.");
  });

  it("surfaces a failed aggregate read as an alert", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockRejectedValue(new Error("bridge down"));
    const container = await renderView();
    expect(container.querySelector('[data-testid="runtime-read-error"]')?.textContent).toContain("bridge down");
  });
});

describe("token usage display model", () => {
  it("splits consumption into four non-overlapping parts that add up to the total", () => {
    // daemon 的 inputTokens 含缓存读取与缓存写入,totalTokens = 输入 + 输出。
    const parts = tokenComposition({
      inputTokens: 1_000,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
      outputTokens: 50,
    });
    expect(parts).toEqual({ cacheRead: 700, cacheWrite: 100, freshInput: 200, output: 50 });
    expect(parts.cacheRead + parts.cacheWrite + parts.freshInput + parts.output).toBe(1_050);
    // 读+写超过输入时逐段截断:新输入不为负(历史记录缺写计数时按 0,同一条路径)。
    const clamped = tokenComposition({
      inputTokens: 1_000,
      cacheReadTokens: 700,
      cacheWriteTokens: 500,
      outputTokens: 0,
    });
    expect(clamped).toEqual({ cacheRead: 700, cacheWrite: 300, freshInput: 0, output: 0 });
    const legacy = tokenComposition({
      inputTokens: 1_000,
      cacheReadTokens: 700,
      cacheWriteTokens: 0,
      outputTokens: 50,
    });
    expect(legacy).toEqual({ cacheRead: 700, cacheWrite: 0, freshInput: 300, output: 50 });
    expect(cacheHitRate({ inputTokens: 1_000, cacheReadTokens: 700 })).toBe(0.7);
    expect(cacheHitRate({ inputTokens: 1_000, cacheReadTokens: -10 })).toBe(0);
    expect(cacheHitRate({ inputTokens: 1_000, cacheReadTokens: 1_100 })).toBe(1);
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0 })).toBeNull();
  });

  it("keeps the tallest bar under the top gridline with round ticks", () => {
    expect(axisScale(646_000_000)).toEqual({
      max: 800_000_000,
      ticks: [0, 200_000_000, 400_000_000, 600_000_000, 800_000_000],
    });
    for (const peak of [1, 7, 99, 1_234, 50_000, 3_100_000_000]) {
      const { max, ticks } = axisScale(peak);
      expect(max).toBeGreaterThanOrEqual(peak);
      expect(ticks.at(-1)).toBe(max);
      expect(ticks.length).toBeLessThanOrEqual(6);
    }
    expect(axisScale(0)).toEqual({ max: 1, ticks: [0] });
  });

  it("gives magnitudes that differ a thousandfold visibly different bar lengths on the log scale", () => {
    const values = [1_900_000_000, 237_000_000, 7_900_000, 853_000],
      floor = rankLogFloor(values),
      shares = values.map((value) => rankBarShare(value, values[0]!, floor, "log"));
    expect(rankScaleFor(values)).toBe("log");
    expect(shares[0]).toBe(1);
    // 相邻两行的条长差得出来(旧版线性条把后几行都画成最小宽度)。
    for (let index = 1; index < shares.length; index += 1)
      expect(shares[index - 1]! - shares[index]!).toBeGreaterThan(0.05);
    expect(shares.at(-1)).toBeGreaterThan(0.1);
    expect(rankBarShare(0, values[0]!, floor, "log")).toBe(0);
    expect(rankBarShare(237_000_000, 1_900_000_000, floor, "linear")).toBeCloseTo(0.1247, 3);
    expect(rankScaleFor([900, 500, 100])).toBe("linear");
  });

  it("derives change, success rate and cost per success only when there is a base", () => {
    expect(periodChange(150, 100)).toBe(0.5);
    expect(periodChange(50, 100)).toBe(-0.5);
    expect(periodChange(50, 0)).toBeNull();
    expect(successRate({ succeededSessions: 3, failedSessions: 1, abortedSessions: 0 })).toBe(0.75);
    expect(successRate(noOutcomes)).toBeNull();
    expect(tokensPerSuccess({ totalTokens: 900, succeededSessions: 3 })).toBe(300);
    expect(tokensPerSuccess({ totalTokens: 900, succeededSessions: 0 })).toBeNull();
  });

  it("formats shares, precise token counts and bin labels", () => {
    expect([0, 0.0004, 0.003, 0.068, 0.5, 1].map(percentText)).toEqual(["0%", "<0.1%", "0.3%", "6.8%", "50%", "100%"]);
    expect([1_960_000_000, 536_000_000, 7_560_000, 340].map(preciseTokens)).toEqual(["1.96B", "536M", "7.56M", "340"]);
    expect(sessionBinLabel(10_000, 0, preciseTokens)).toBe("<10K");
    expect(sessionBinLabel(1_000_000, 100_000, preciseTokens)).toBe("100K–1M");
    expect(sessionBinLabel(null, 100_000_000, preciseTokens)).toBe("≥100M");
  });
});
