// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TokenUsageView } from "../src/renderer/views/TokenUsageView.tsx";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import type { AgentRuntimeTokenUsageResult } from "../../daemon/src/agent-runtime-token-usage.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 系统 Tab「Token 消耗」页(P1.3):daemon 聚合读(repo.agentRuntime.tokenUsage)的
 * 渲染面——默认单 Worker 视图、可切小队、数字紧凑展示精确值进 title、空/错误态。
 */

const usage: AgentRuntimeTokenUsageResult = {
  ok: true,
  status: "ready",
  since: "2026-09-14T00:00:00.000Z",
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
    },
  ],
  watermark: 3,
  sourceRevision: 3,
};

let mounted: { readonly root: Root; readonly client: QueryClient }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const { root } of mounted) root.unmount();
  mounted = [];
});

async function renderView(): Promise<HTMLDivElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(TokenUsageView, { repoId: "canonical" })));
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

function clickButton(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  expect(button, `segment button ${label}`).toBeTruthy();
  act(() => button!.click());
}

describe("TokenUsageView", () => {
  it("renders today's per-agent aggregate from the daemon read", async () => {
    const tokenUsage = vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    expect(tokenUsage).toHaveBeenCalledWith("canonical");
    const row = container.querySelector('[data-testid="token-usage-row-terra"]');
    expect(row).toBeTruthy();
    // 紧凑值上屏,精确值进 title(1,500 → 1.5K)。
    const totalCell = row!.querySelector("td[title='2,100']");
    expect(totalCell?.textContent).toBe("2.1K");
    expect(row!.textContent).toContain("Terra");
    expect(row!.textContent).toContain("terra");
    expect(container.querySelector('[data-testid="token-usage-row-core-squad"]')).toBeNull();
  });

  it("switches to the squad segment on the same page", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue(usage);
    const container = await renderView();
    clickButton(container, "Squad");
    expect(container.querySelector('[data-testid="token-usage-squads-table"]')).toBeTruthy();
    const row = container.querySelector('[data-testid="token-usage-row-core-squad"]');
    expect(row?.textContent).toContain("Core");
    expect(container.querySelector('[data-testid="token-usage-row-terra"]')).toBeNull();
  });

  it("states honestly when no attributed dispatch consumed anything today", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockResolvedValue({
      ...usage,
      agents: [],
      squads: [],
    });
    const container = await renderView();
    expect(container.textContent).toContain("No attributed dispatch consumption today yet.");
  });

  it("surfaces a failed aggregate read as an alert", async () => {
    vi.spyOn(agentRuntimeClient, "tokenUsage").mockRejectedValue(new Error("bridge down"));
    const container = await renderView();
    expect(container.querySelector('[data-testid="runtime-read-error"]')?.textContent).toContain("bridge down");
  });
});
