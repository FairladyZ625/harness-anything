// harness-test-tier: integration
// @vitest-environment happy-dom
// G5 系统组四页宽屏不变量:presets/adapters/system/settings 内容容器铺满可用宽度
// (与 overview/board/任务详情同一容器规则),不保留 mx-auto + max-w-*xl 居中收口;
// 有意的列宽(repo 表截断列、侧栏固定轨道)保留,不受外层铺满影响。
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PresetsView } from "../src/renderer/views/PresetsView.tsx";
import { AdaptersView } from "../src/renderer/views/AdaptersView.tsx";
import { SystemView } from "../src/renderer/views/SystemView.tsx";
import { SettingsView } from "../src/renderer/views/SettingsView.tsx";
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const REPO_ID = "g5-probe";
const AT = "2026-08-26T00:00:00.000Z";
const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

function seedQueries(client: QueryClient): void {
  client.setQueryData(catalogQueryKeys.snapshot(REPO_ID), {
    schema: "gui-catalog-snapshot/v1",
    ok: true,
    status: "ready",
    repoId: REPO_ID,
    observedAt: AT,
    catalogDigest: "g5-digest-g5-digest-g5-digest-",
    defaults: { verticalId: "g5", presetId: "preset-g5", profileId: null, locale: "zh-CN" },
    presets: [
      {
        id: "preset-g5",
        title: "G5 Preset",
        description: "fixture 预设",
        verticalId: "g5",
        sourceKind: "bundled",
        validity: "valid",
        version: "1",
        kind: null,
        defaultProfile: null,
        entrypoints: [],
        issues: [],
        shadows: null,
      },
    ],
    verticals: [],
    templates: [],
    adapters: [1, 2, 3].map((n) => ({
      adapterId: `adapter-g5-${n}`,
      registered: true as const,
      capabilities: ["task"],
      writability: "read-only" as const,
      defaultProvider: n === 1,
      unavailableReason: null,
    })),
  });
  client.setQueryData(catalogQueryKeys.preset(REPO_ID, "preset-g5", "zh-CN"), {
    schema: "gui-catalog-preset/v1",
    ok: true,
    repoId: REPO_ID,
    preset: { id: "preset-g5", verticalId: "g5", extends: null, capabilityImports: [] },
    resolved: { digest: "g5-resolved", provenance: {} },
  });
  client.setQueryData(["system", "global", "status"], {
    schema: "gui-system-status/v1",
    ok: true,
    observedAt: AT,
    daemon: {
      daemonId: "daemon-g5",
      pid: 1,
      startedAt: AT,
      protocolVersion: { major: 1, minor: 0 },
      uptimeMs: 1000,
      endpoint: "sock",
      build: { version: "g5", commitSha: null },
      activeControl: null,
    },
    repos: [
      {
        repoId: REPO_ID,
        displayName: "G5 Probe",
        canonicalRoot: "/tmp/g5-probe",
        authoredBranch: "main",
        registrationState: "enabled",
        cellState: "attached",
        generation: 1,
        queueDepth: 0,
        lockState: "not_applicable",
        recoveryMs: null,
        lastError: null,
        unavailableReason: null,
      },
    ],
  });
}

async function mountView(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedQueries(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

const FILL_TESTIDS = ["presets-content", "adapters-content", "system-content", "settings-content"] as const;

async function mountedContainerClasses(testId: (typeof FILL_TESTIDS)[number]): Promise<string> {
  const container = await mountView(
    testId === "presets-content"
      ? createElement(PresetsView, { repoId: REPO_ID })
      : testId === "adapters-content"
        ? createElement(AdaptersView, { repoId: REPO_ID, tasks: [] })
        : testId === "system-content"
          ? createElement(SystemView, { activeRepoId: REPO_ID })
          : createElement(SettingsView, {}),
  );
  const el = container.querySelector(`[data-testid="${testId}"]`);
  expect(el, `${testId} 未渲染`).toBeTruthy();
  return (el as HTMLElement).className;
}

describe("G5 系统组四页宽屏:内容容器铺满,不保留固定宽度收口", () => {
  it.each(FILL_TESTIDS)("%s 铺满可用宽度:无 mx-auto、无视口 max-w 收口", async (testId) => {
    const className = await mountedContainerClasses(testId);
    expect(className, `${testId} 类名`).toContain("w-full");
    expect(className, `${testId} 不得再居中收口`).not.toContain("mx-auto");
    expect(className, `${testId} 不得挂固定最大宽度`).not.toMatch(/(^|\s)max-w-/u);
  });

  it("adapters 沿用已适配页面的注册卡网格规则(auto-fill minmax),卡片列随宽度增长", async () => {
    const className = await mountedContainerClasses("adapters-content");
    expect(className).toContain("grid-cols-[repeat(auto-fill,minmax(290px,1fr))]");
  });

  it("侧栏固定轨道保留(列宽有意,外层仍铺满)", async () => {
    expect(await mountedContainerClasses("presets-content")).toContain("lg:grid-cols-[minmax(0,1fr)_20rem]");
    expect(await mountedContainerClasses("system-content")).toContain("lg:grid-cols-[22rem_minmax(0,1fr)]");
    expect(await mountedContainerClasses("settings-content")).toContain("lg:grid-cols-[12rem_minmax(0,1fr)]");
  });

  it("system 仓库表截断列宽保留(有意列宽),表体仍随外层铺满", async () => {
    const container = await mountView(createElement(SystemView, { activeRepoId: REPO_ID }));
    const cappedCells = container.querySelectorAll("td.max-w-\\[16rem\\]");
    expect(cappedCells.length).toBeGreaterThan(0);
    const table = container.querySelector("table");
    expect(table?.className).toContain("w-full");
  });
});
