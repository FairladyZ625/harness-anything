// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HomeView } from "../src/renderer/views/HomeView.tsx";
import { AdaptersView } from "../src/renderer/views/AdaptersView.tsx";
import type { SystemRepoRow } from "../src/renderer/api-client.ts";
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

const repo = (overrides: Partial<SystemRepoRow>): SystemRepoRow => ({
  repoId: "canonical",
  displayName: "Harness Anything",
  canonicalRoot: "/tmp/canonical",
  authoredBranch: "main",
  registrationState: "enabled",
  mode: "local",
  connectionId: "local",
  cellState: "attached",
  generation: 1,
  queueDepth: 2,
  lockState: "not_applicable",
  recoveryMs: null,
  lastError: null,
  unavailableReason: null,
  ...overrides,
});

async function mountHome(
  repos: readonly SystemRepoRow[],
  currentRepoId: string | null,
): Promise<{ readonly container: HTMLElement; readonly opened: readonly string[] }> {
  const opened: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(HomeView, {
        repos,
        currentRepoId,
        onOpenProject: (repoId: string) => opened.push(repoId),
      }),
    );
  });
  return { container, opened };
}

describe("HomeView 目录行(标准 §2.5)", () => {
  it("每仓一行:状态是有底色的 StatusTag,当前仓有标记,点行打开项目", async () => {
    const { container, opened } = await mountHome([repo({})], "canonical");
    const row = container.querySelector('[data-testid="home-repo-canonical"]');
    expect(row).toBeTruthy();
    const tone = row!.querySelector<HTMLElement>("[data-status-tone]");
    expect(tone?.dataset.statusTone).toBe("done");
    expect(row!.textContent).toContain("canonical");
    expect(row!.textContent).toContain("当前");
    await act(async () => {
      row!.querySelector("button")!.click();
    });
    expect(opened).toEqual(["canonical"]);
    await unmountAll();
  });

  it("异常仓置顶并带红竖线强调;停用仓不可进入、就地说明原因", async () => {
    const { container } = await mountHome(
      [
        repo({ repoId: "zz-healthy", displayName: "Healthy Repo" }),
        repo({
          repoId: "aa-broken",
          displayName: "Broken Repo",
          cellState: "unavailable",
          unavailableReason: "ledger unreadable",
        }),
        repo({ repoId: "mid-disabled", registrationState: "disabled", cellState: "not_loaded" }),
      ],
      null,
    );
    const rows = [...container.querySelectorAll("[data-testid^='home-repo-']")];
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "home-repo-aa-broken",
      "home-repo-zz-healthy",
      "home-repo-mid-disabled",
    ]);
    const broken = rows[0]! as HTMLElement;
    expect(broken.querySelector("[data-status-tone]")?.getAttribute("data-status-tone")).toBe("bad");
    expect(broken.textContent).toContain("ledger unreadable");
    expect(broken.style.getPropertyValue("--status-edge")).toContain("var(--color-status-blocked)");
    expect((rows[1]! as HTMLElement).style.getPropertyValue("--status-edge")).toBe("");
    const disabled = rows[2]! as HTMLElement;
    expect(disabled.textContent).toContain("注册已停用");
    expect(disabled.querySelector("button")).toBeNull();
    await unmountAll();
  });

  it("空目录只有一行说明,不渲染大框", async () => {
    const { container } = await mountHome([], null);
    expect(container.querySelector('[data-testid="home-content"]')).toBeNull();
    const body = container.querySelector('[data-testid="home-view"]');
    expect(body?.querySelectorAll("p").length).toBe(2); // 页头摘要一行 + 空态一行,没有第三块
    expect(body?.textContent).toContain("还没有仓库");
    await unmountAll();
  });
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
    expect(ok.querySelector("[data-status-tone]")?.getAttribute("data-status-tone")).toBe("done");
    expect(ok.textContent).toContain("2 个任务在用");
    expect(ok.textContent).toContain("默认");
    await unmountAll();
  });
});
