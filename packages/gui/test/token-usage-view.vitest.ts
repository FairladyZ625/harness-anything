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
} from "../../daemon/src/agent-runtime-token-usage.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 系统 Tab「Token 消耗」页(task_7a1bd444 重做):daemon 聚合读(repo.agentRuntime.tokenUsage
 * / tokenUsageDetail)的渲染面 —— 指标条/趋势/排行可切表格,「未上报」与 0 分开,成员
 * 详情经 focusedEntityRef 推栈并能跳会话/任务。
 */

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
    outputTokens: 1_160,
    totalTokens: 15_000,
    toolCallCount: 57,
    usageReportedDispatches: 2,
    usageUnavailableDispatches: 3,
  },
  buckets: [
    {
      bucketStart: "2026-09-18T12:00:00.000Z",
      dispatchCount: 1,
      inputTokens: 1_500,
      cacheReadTokens: 340,
      outputTokens: 260,
      totalTokens: 2_100,
      toolCallCount: 17,
      usageReportedDispatches: 1,
      usageUnavailableDispatches: 0,
    },
    {
      bucketStart: "2026-09-18T13:00:00.000Z",
      dispatchCount: 1,
      inputTokens: 12_000,
      cacheReadTokens: 0,
      outputTokens: 900,
      totalTokens: 12_900,
      toolCallCount: 40,
      usageReportedDispatches: 1,
      usageUnavailableDispatches: 0,
    },
  ],
  agents: [
    {
      agentId: "terra",
      agentName: "Terra",
      sessionCount: 2,
      inputTokens: 1_500,
      cacheReadTokens: 340,
      outputTokens: 260,
      totalTokens: 2_100,
      toolCallCount: 17,
      usageReportedDispatches: 1,
      usageUnavailableDispatches: 0,
    },
    {
      agentId: "sol",
      agentName: "Sol",
      sessionCount: 1,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCallCount: 3,
      usageReportedDispatches: 0,
      usageUnavailableDispatches: 2,
    },
  ],
  squads: [
    {
      squadId: "core-squad",
      squadName: "Core",
      sessionCount: 3,
      inputTokens: 12_000,
      cacheReadTokens: 0,
      outputTokens: 900,
      totalTokens: 12_900,
      toolCallCount: 40,
      usageReportedDispatches: 1,
      usageUnavailableDispatches: 1,
    },
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
    outputTokens: 260,
    totalTokens: 2_100,
    toolCallCount: 17,
    usageReportedDispatches: 2,
    usageUnavailableDispatches: 0,
  },
  buckets: usage.buckets,
  sessions: [
    {
      dispatchId: "dispatch_00000000000000000000aa01",
      runtimeSessionId: "runtime-terra",
      taskId: "task-tokens",
      model: "gpt-test",
      startedAt: "2026-09-18T12:00:00.000Z",
      endedAt: "2026-09-18T12:05:00.000Z",
      durationMs: 300_000,
      outcome: "succeeded",
      inputTokens: 1_500,
      cacheReadTokens: 340,
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
          onSelectEntity: vi.fn(),
          onOpenTask: vi.fn(),
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

describe("TokenUsageView", () => {
  it("renders totals, trend and ranking from the range aggregate read", async () => {
    const tokenUsage = vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    expect(tokenUsage).toHaveBeenCalledWith("canonical", "today");
    // 指标条:总量紧凑展示。
    expect(container.querySelector('[data-testid="token-usage-totals"]')?.textContent).toContain("15K");
    expect(container.querySelector('[data-testid="token-usage-totals"]')?.textContent).toContain("3");
    // 趋势 SVG:两个桶,数值进 title。
    expect(container.querySelectorAll('[data-testid^="token-usage-trend-bar-"]').length).toBe(2);
    // 排行行 + 紧凑值上屏。
    const rankRow = container.querySelector('[data-testid="token-usage-rank-terra"]');
    expect(rankRow).toBeTruthy();
    expect(rankRow!.textContent).toContain("Terra");
    expect(rankRow!.textContent).toContain("2.1K");
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

  it("marks a provider that reported no usage as Not reported instead of zero", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    const solRow = container.querySelector('[data-testid="token-usage-rank-sol"]');
    expect(solRow).toBeTruthy();
    expect(solRow!.textContent).toContain("Not reported");
  });

  it("opens the member detail by ref, with session/task jumps and back", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const detailRead = vi.spyOn(agentRuntimeClient, "tokenUsageDetail").mockResolvedValue(detail);
    const container = await renderView();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="token-usage-rank-terra"]')!.click());
    expect(focusedMemberRef).toBe("tokenAgent/terra");
    // focusedEntityRef 变化 = App 推栈后重渲;这里直接以新 ref 再渲一次。
    const rerendered = await renderView();
    expect(detailRead).toHaveBeenCalledWith("canonical", { kind: "agent", agentId: "terra" }, "today");
    const sessionRow = rerendered.querySelector(
      '[data-testid="token-usage-session-dispatch_00000000000000000000aa01"]',
    );
    expect(sessionRow).toBeTruthy();
    // 每一条文案的插值都要被填上:locale 的占位名与调用方传的键不一致时,页面会把 `{name}` 原样显示出来。
    expect(rerendered.textContent).not.toMatch(/\{[a-zA-Z]+\}/u);
    expect(sessionRow!.textContent).toContain("runtime-terra");
    expect(sessionRow!.textContent).toContain("task-tokens");
    const unreportedRow = rerendered.querySelector(
      '[data-testid="token-usage-session-dispatch_00000000000000000000aa02"]',
    );
    // 未上报会话行的阴性对照:与 SessionsPanel 同一「provider 未上报」措辞,不是裸 0。
    expect(unreportedRow!.textContent).toContain("Unavailable (provider reports no tokens)");
    const back = rerendered.querySelector('[data-testid="token-usage-detail-back"]');
    act(() => (back as HTMLButtonElement).click());
    expect(focusedMemberRef).toBeNull();
  });

  it("switches trend and ranking to their table equivalents", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    act(() => findButton(container, "Table").click());
    expect(container.querySelector('[data-testid="token-usage-trend-table"]')).toBeTruthy();
    const rankingTableButton = [...container.querySelectorAll('[data-testid="token-usage-ranking-card"] button')].find(
      (candidate) => candidate.textContent === "Table",
    );
    expect(rankingTableButton).toBeTruthy();
    act(() => rankingTableButton!.click());
    expect(container.querySelector('[data-testid="token-usage-agents-table"]')).toBeTruthy();
    // 表格视图保留完整行:terra 的精确值进 title。
    const totalCell = container.querySelector('[data-testid="token-usage-agents-table"] td[title="2,100"]');
    expect(totalCell?.textContent).toBe("2.1K");
  });

  it("states honestly when nothing was consumed in the range", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue({
      ...usage,
      totals: { ...usage.totals, sessionCount: 0, usageUnavailableDispatches: 0 },
      buckets: usage.buckets.map((bucket) => ({ ...bucket, dispatchCount: 0 })),
      agents: [],
      squads: [],
    });
    const container = await renderView();
    expect(container.textContent).toContain("No attributed dispatch consumption in this range yet.");
  });

  it("surfaces a failed aggregate read as an alert", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockRejectedValue(new Error("bridge down"));
    const container = await renderView();
    expect(container.querySelector('[data-testid="runtime-read-error"]')?.textContent).toContain("bridge down");
  });
});
