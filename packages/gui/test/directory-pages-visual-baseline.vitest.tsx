// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdaptersView } from "../src/renderer/views/AdaptersView.tsx";
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 目录页视觉基线 v1(gui-visual-language-standard §2.5)的结构断言:行用 DenseRow、
 * 状态用有底色的 StatusTag(data-status-tone)、异常项置顶并用红竖线(.status-edge
 * 的 --status-edge 自定义属性)强调、空态只一行不画大框。
 */

const mounted: { readonly root: Root; readonly container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const { root } of mounted.splice(0)) root.unmount();
});

async function unmountAll(): Promise<void> {
  await act(async () => {
    for (const { root } of mounted.splice(0)) root.unmount();
  });
}

describe("AdaptersView 目录行(标准 §2.5)", () => {
  it("不可用的 adapter 置顶带红竖线;投影任务数回答「谁在用它」", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(catalogQueryKeys.snapshot("canonical"), {
      schema: "gui-catalog-snapshot/v1",
      ok: true,
      status: "ready",
      repoId: "canonical",
      observedAt: "2026-09-30T00:00:00.000Z",
      defaults: { verticalId: "software/coding", presetId: "standard-task", profileId: null, locale: "zh-CN" },
      presets: [],
      verticals: [],
      templates: [],
      scaffolds: { task: [], repository: [] },
      ciWorkflows: [],
      bundledAgents: [],
      adapters: [
        {
          adapterId: "zeta-ok",
          registered: true as const,
          capabilities: ["task"],
          writability: "read-write" as const,
          defaultProvider: true,
          unavailableReason: null,
        },
        {
          adapterId: "alpha-down",
          registered: true as const,
          capabilities: [],
          writability: "read-only" as const,
          defaultProvider: false,
          unavailableReason: "engine process missing",
        },
      ],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(AdaptersView, {
            repoId: "canonical",
            tasks: [{ engine: "zeta-ok" }, { engine: "zeta-ok" }] as never,
          }),
        ),
      );
    });
    const rows = [...container.querySelectorAll('[data-testid="adapters-content"] > div')];
    expect(rows.length).toBe(2);
    const down = rows[0]! as HTMLElement;
    expect(down.textContent).toContain("alpha-down");
    expect(down.querySelector("[data-status-tone]")?.getAttribute("data-status-tone")).toBe("bad");
    expect(down.textContent).toContain("engine process missing");
    expect(down.style.getPropertyValue("--status-edge")).toContain("var(--color-status-blocked)");
    const ok = rows[1]! as HTMLElement;
    expect(ok.querySelector("[data-status-tone]")?.getAttribute("data-status-tone")).toBe("neutral");
    expect(ok.textContent).toContain("2 个任务在用");
    expect(ok.textContent).toContain("默认");
    await unmountAll();
  });
});
