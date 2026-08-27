// harness-test-tier: integration
// @vitest-environment happy-dom
// G5 系统组四页宽屏不变量:presets/adapters/system/settings 内容容器铺满可用宽度
// (与 overview/board/任务详情同一容器规则),不保留 mx-auto + max-w-*xl 居中收口;
// 有意的列宽(repo 表截断列、侧栏固定轨道)保留,不受外层铺满影响。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PresetsView } from "../src/renderer/views/PresetsView.tsx";
import { AdaptersView } from "../src/renderer/views/AdaptersView.tsx";
import { SystemView } from "../src/renderer/views/SystemView.tsx";
import { SettingsView } from "../src/renderer/views/SettingsView.tsx";
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { settingsQueryKeys } from "../src/renderer/settings-data.ts";

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
  Reflect.deleteProperty(window, "harness");
});

function seedQueries(client: QueryClient): void {
  client.setQueryData(settingsQueryKeys.read(REPO_ID), {
    schema: "daemon.settings-read/v1",
    ok: true,
    settings: {
      schema: "settings/v1",
      settingsId: "repository",
      defaultVertical: "software/coding",
      defaultPreset: "standard-task",
      defaultProfile: "baseline",
      locale: "zh-CN",
      scaffolds: { task: "governance/task-scaffold.json", repository: "governance/repository-scaffold.json" },
    },
  });
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
        profiles: [],
        entrypoints: [],
        issues: [],
        shadows: null,
      },
      {
        id: "standard-task",
        title: "Standard Task",
        description: "fixture 标准任务",
        verticalId: "software/coding",
        sourceKind: "bundled",
        validity: "valid",
        version: "3.0.0",
        kind: null,
        defaultProfile: "baseline",
        profiles: [{ id: "baseline", title: "Baseline" }],
        entrypoints: [],
        issues: [],
        shadows: null,
      },
      {
        id: "docs-task",
        title: "Documentation / Design Task",
        description: "fixture 文档任务",
        verticalId: "software/coding",
        sourceKind: "bundled",
        validity: "valid",
        version: "3.0.0",
        kind: null,
        defaultProfile: "prose",
        profiles: [{ id: "prose", title: "Prose" }],
        entrypoints: [],
        issues: [],
        shadows: null,
      },
    ],
    verticals: [
      {
        id: "software/coding",
        title: "Software / Coding",
        version: "1",
        source: "builtin" as const,
        available: true,
        valid: true,
        issues: [],
      },
    ],
    templates: [],
    scaffolds: {
      task: ["governance/task-scaffold.json"],
      repository: ["governance/repository-scaffold.json"],
    },
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
      ? createElement(PresetsView, {
          repoId: REPO_ID,
          focusedPresetId: null,
          onOpenPreset: () => undefined,
          onExitDetail: () => undefined,
          projectName: "G5 Probe",
        })
      : testId === "adapters-content"
        ? createElement(AdaptersView, { repoId: REPO_ID, tasks: [] })
        : testId === "system-content"
          ? createElement(SystemView, { activeRepoId: REPO_ID, onOpenObserve: () => undefined })
          : createElement(SettingsView, { repoId: REPO_ID }),
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
    // G7 起预设列表页改为紧凑信息行(已解析内容移入详情页),不再有 20rem 侧栏轨道。
    expect(await mountedContainerClasses("system-content")).toContain("lg:grid-cols-[22rem_minmax(0,1fr)]");
    expect(await mountedContainerClasses("settings-content")).toContain("lg:grid-cols-[12rem_minmax(0,1fr)]");
  });

  it("system 仓库表截断列宽保留(有意列宽),表体仍随外层铺满", async () => {
    const container = await mountView(
      createElement(SystemView, { activeRepoId: REPO_ID, onOpenObserve: () => undefined }),
    );
    const cappedCells = container.querySelectorAll("td.max-w-\\[16rem\\]");
    expect(cappedCells.length).toBeGreaterThan(0);
    const table = container.querySelector("table");
    expect(table?.className).toContain("w-full");
  });

  it("attached 仓库行最右侧显示明确的观察按钮", async () => {
    const opened: string[] = [],
      container = await mountView(
        createElement(SystemView, { activeRepoId: REPO_ID, onOpenObserve: (repoId) => opened.push(repoId) }),
      ),
      button = container.querySelector('[data-testid="system-repo-observe"]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.textContent).toBe("观察");
    expect(button.closest("td")).toBe(button.closest("tr")?.lastElementChild);
    expect(container.querySelector("tbody tr td:first-child")?.textContent).not.toContain("↗");
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toEqual([REPO_ID]);
  });
});

describe("Settings kind renderer consumes and updates the daemon-owned facet", () => {
  it("renders every read field and sends defaultPreset plus locale changes through the bridge", async () => {
    const settings = {
        schema: "settings/v1" as const,
        settingsId: "repository" as const,
        defaultVertical: "software/coding",
        defaultPreset: "standard-task",
        defaultProfile: "baseline",
        locale: "zh-CN" as const,
        scaffolds: { task: "governance/task-scaffold.json", repository: "governance/repository-scaffold.json" },
      },
      updateSettings = vi.fn(async (payload: Record<string, unknown>) => ({
        schema: "command-receipt/v2",
        ok: true,
        command: "settings-update",
        outcome: "applied",
        opId: String(payload.idempotencyKey),
      })),
      getSettings = vi.fn(async () => ({ schema: "daemon.settings-read/v1", ok: true, settings }));
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: { updateSettings, getSettings },
    });
    const container = await mountView(createElement(SettingsView, { repoId: REPO_ID }));
    for (const [testId, value] of [
      ["settings-vertical-select", "software/coding"],
      ["settings-preset-select", "standard-task"],
      ["settings-profile-select", "baseline"],
      ["settings-task-scaffold-select", "governance/task-scaffold.json"],
      ["settings-repository-scaffold-select", "governance/repository-scaffold.json"],
    ] as const)
      expect((container.querySelector(`[data-testid="${testId}"]`) as HTMLSelectElement | null)?.value).toBe(value);
    expect(container.querySelector('[data-testid="settings-preset-select"]')?.tagName).toBe("SELECT");
    expect(container.textContent).toContain("settings/repository · settings/v1");

    const preset = container.querySelector('[data-testid="settings-preset-select"]') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(preset, "docs-task");
      preset.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "提交到仓库")!;
    await act(async () => save.click());
    expect(updateSettings.mock.calls[0]?.[0]).toMatchObject({
      repoId: REPO_ID,
      defaultPreset: "docs-task",
      defaultProfile: "prose",
    });
    expect(updateSettings.mock.calls[0]?.[0]).not.toHaveProperty("locale");

    const languageTab = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("语言"),
    )!;
    await act(async () => languageTab.click());
    const language = container.querySelector('select[aria-label="语言"]') as HTMLSelectElement;
    await act(async () => {
      language.value = "en-US";
      language.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(updateSettings.mock.calls.at(-1)?.[0]).toMatchObject({ repoId: REPO_ID, locale: "en-US" });
  });
});
