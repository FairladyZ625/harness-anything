// harness-test-tier: integration
// @vitest-environment happy-dom
// Settings → 仓库:取值面可枚举的字段一律是选择器,枚举来源是 daemon 目录快照
// (gui-catalog-snapshot/v1 的 verticals / presets[].profiles / scaffolds),不是手打字符串。
// 覆盖:①五个字段都是 <select> 且选项来自目录;②当前值不在目录时并入选项、不静默丢值;
// ③换 preset 时 profile 落到新 preset 的默认 profile;④目录读面失败时选择器停用(fail closed)。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsView } from "../src/renderer/views/SettingsView.tsx";
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { settingsQueryKeys } from "../src/renderer/settings-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const REPO_ID = "settings-selectors-probe";
const AT = "2026-08-27T00:00:00.000Z";
const SETTINGS = {
  schema: "settings/v1" as const,
  settingsId: "repository" as const,
  defaultVertical: "software/coding",
  defaultPreset: "standard-task",
  defaultProfile: "baseline",
  locale: "zh-CN" as const,
  scaffolds: { task: "governance/task-scaffold.json", repository: "governance/repository-scaffold.json" },
};
const SNAPSHOT = {
  schema: "gui-catalog-snapshot/v1" as const,
  ok: true as const,
  status: "ready" as const,
  repoId: REPO_ID,
  observedAt: AT,
  catalogDigest: "settings-selectors-digest--------------",
  defaults: { verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", locale: "zh-CN" },
  presets: [
    {
      id: "standard-task",
      title: "Standard Task",
      description: "标准任务",
      verticalId: "software/coding",
      sourceKind: "bundled" as const,
      validity: "valid" as const,
      version: "3.0.0",
      kind: null,
      defaultProfile: "baseline",
      profiles: [
        { id: "baseline", title: "Baseline" },
        { id: "strict", title: "Strict" },
      ],
      entrypoints: [],
      issues: [],
      shadows: null,
    },
    {
      id: "docs-task",
      title: "Documentation / Design Task",
      description: "文档任务",
      verticalId: "software/coding",
      sourceKind: "bundled" as const,
      validity: "valid" as const,
      version: "3.0.0",
      kind: null,
      defaultProfile: "prose",
      profiles: [{ id: "prose", title: "Prose" }],
      entrypoints: [],
      issues: [],
      shadows: null,
    },
    {
      id: "review-task",
      title: "Review Task",
      description: "评审任务",
      verticalId: "software/coding",
      sourceKind: "bundled" as const,
      validity: "valid" as const,
      version: "3.0.0",
      kind: null,
      defaultProfile: "review",
      profiles: [
        { id: "strict", title: "Strict" },
        { id: "review", title: "Review" },
      ],
      entrypoints: [],
      issues: [],
      shadows: null,
    },
    {
      id: "other-vertical-preset",
      title: "别的垂直",
      description: "不应出现在 software/coding 的选项里",
      verticalId: "other/vertical",
      sourceKind: "bundled" as const,
      validity: "valid" as const,
      version: "3.0.0",
      kind: null,
      defaultProfile: "other-default",
      profiles: [{ id: "other-default", title: "Other Default" }],
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
    {
      id: "other/vertical",
      title: "Other Vertical",
      version: "1",
      source: "builtin" as const,
      available: true,
      valid: true,
      issues: [],
    },
  ],
  templates: [],
  scaffolds: {
    task: ["governance/task-scaffold.json", "governance/task-scaffold-strict.json"],
    repository: ["governance/repository-scaffold.json"],
  },
  adapters: [],
};
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

async function mountView(
  options: { readonly snapshot?: unknown | null; readonly catalogBridge?: () => Promise<unknown> } = {},
): Promise<HTMLElement> {
  const updateSettings = vi.fn(async (payload: Record<string, unknown>) => ({
    schema: "command-receipt/v2",
    ok: true,
    command: "settings-update",
    outcome: "applied",
    opId: String(payload.idempotencyKey),
  }));
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: {
      updateSettings,
      getSettings: async () => ({ schema: "daemon.settings-read/v1", ok: true, settings: SETTINGS }),
      ...(options.catalogBridge ? { getCatalogSnapshot: options.catalogBridge } : {}),
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsQueryKeys.read(REPO_ID), {
    schema: "daemon.settings-read/v1",
    ok: true,
    settings: SETTINGS,
  });
  // 目录快照走缓存种子(与 preset-detail/system-group-widescreen 同一模式),桥只承担写面;
  // 显式传 null 表示「不种」,用于让目录读面真的失败。
  if (options.snapshot !== null) client.setQueryData(catalogQueryKeys.snapshot(REPO_ID), options.snapshot ?? SNAPSHOT);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(SettingsView, { repoId: REPO_ID })));
  });
  for (let index = 0; index < 4; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
  return container;
}

function select(container: HTMLElement, testId: string): HTMLSelectElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  expect(element, `${testId} 未渲染`).toBeTruthy();
  expect(element!.tagName, `${testId} 必须是选择器`).toBe("SELECT");
  return element as HTMLSelectElement;
}

function optionValues(element: HTMLSelectElement): string[] {
  return [...element.querySelectorAll("option")].map((option) => (option as HTMLOptionElement).value);
}

/** 选项文案:目录外的当前值在这里露出「目录中不存在」标记,value 仍是原值,可原样提交。 */
function optionLabels(element: HTMLSelectElement): string[] {
  return [...element.querySelectorAll("option")].map((option) => (option as HTMLOptionElement).textContent ?? "");
}

async function choose(element: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === "提交到仓库");
  expect(button, "提交按钮未渲染").toBeTruthy();
  return button!;
}

function lastUpdatePayload(): Record<string, unknown> {
  const bridge = window.harness as unknown as {
    readonly updateSettings: { readonly mock: { readonly calls: unknown[][] } };
  };
  const call = bridge.updateSettings.mock.calls.at(-1);
  expect(call, "settings update 未发出").toBeTruthy();
  return call![0] as Record<string, unknown>;
}

describe("Settings 仓库字段是目录喂的选择器", () => {
  it("五个字段全部是 select,选项来自目录快照,且没有自由文本输入", async () => {
    const container = await mountView();
    expect(container.querySelectorAll('input[aria-label^="默认"], input[aria-label*="脚手架"]').length).toBe(0);
    expect(optionValues(select(container, "settings-vertical-select"))).toEqual(["software/coding", "other/vertical"]);
    // other/vertical 的 preset 不进 software/coding 的选项面。
    expect(optionValues(select(container, "settings-preset-select"))).toEqual([
      "standard-task",
      "docs-task",
      "review-task",
    ]);
    expect(optionValues(select(container, "settings-profile-select"))).toEqual(["baseline", "strict"]);
    expect(optionValues(select(container, "settings-task-scaffold-select"))).toEqual([
      "governance/task-scaffold.json",
      "governance/task-scaffold-strict.json",
    ]);
    expect(optionValues(select(container, "settings-repository-scaffold-select"))).toEqual([
      "governance/repository-scaffold.json",
    ]);
  });

  it("当前值不在目录里时并入选项并保留可提交,不静默丢值", async () => {
    const container = await mountView({
      snapshot: {
        ...SNAPSHOT,
        scaffolds: { task: ["governance/task-scaffold-strict.json"], repository: [] },
        presets: SNAPSHOT.presets.filter((row) => row.id !== "standard-task"),
      },
    });
    const taskScaffold = select(container, "settings-task-scaffold-select"),
      repositoryScaffold = select(container, "settings-repository-scaffold-select"),
      preset = select(container, "settings-preset-select");
    expect(optionValues(taskScaffold)).toEqual([
      "governance/task-scaffold-strict.json",
      "governance/task-scaffold.json",
    ]);
    expect(optionLabels(taskScaffold).at(-1)).toBe("governance/task-scaffold.json · 目录中不存在");
    expect(optionValues(repositoryScaffold)).toEqual(["governance/repository-scaffold.json"]);
    expect(optionLabels(repositoryScaffold)).toEqual(["governance/repository-scaffold.json · 目录中不存在"]);
    expect(preset.value).toBe("standard-task");
    expect(optionValues(preset)).toEqual(["docs-task", "review-task", "standard-task"]);
    expect(optionLabels(preset).at(-1)).toBe("standard-task · 目录中不存在");
    await act(async () => {
      saveButton(container).click();
    });
    expect(lastUpdatePayload()).toMatchObject({
      defaultPreset: "standard-task",
      taskScaffold: "governance/task-scaffold.json",
      repositoryScaffold: "governance/repository-scaffold.json",
    });
  });

  it("换 preset 时当前 profile 不在新 preset 清单里,落到该 preset 的默认 profile", async () => {
    const container = await mountView();
    await choose(select(container, "settings-preset-select"), "docs-task");
    expect(select(container, "settings-profile-select").value).toBe("prose");
    await act(async () => {
      saveButton(container).click();
    });
    expect(lastUpdatePayload()).toMatchObject({ defaultPreset: "docs-task", defaultProfile: "prose" });
  });

  it("换 vertical 时不兼容的 preset 落到新垂直的默认项并复用 preset/profile 联动", async () => {
    const container = await mountView();
    await choose(select(container, "settings-vertical-select"), "other/vertical");
    expect(optionValues(select(container, "settings-preset-select"))).toEqual(["other-vertical-preset"]);
    expect(select(container, "settings-preset-select").value).toBe("other-vertical-preset");
    expect(select(container, "settings-profile-select").value).toBe("other-default");
    await act(async () => {
      saveButton(container).click();
    });
    expect(lastUpdatePayload()).toMatchObject({
      defaultVertical: "other/vertical",
      defaultPreset: "other-vertical-preset",
      defaultProfile: "other-default",
    });
  });

  it("新 preset 的清单包含当前 profile 时,profile 保持不动", async () => {
    const container = await mountView();
    await choose(select(container, "settings-profile-select"), "strict");
    await choose(select(container, "settings-preset-select"), "review-task");
    expect(select(container, "settings-profile-select").value).toBe("strict");
  });

  it("目录读面失败时五个选择器停用并显示错误,不回退成自由文本", async () => {
    const container = await mountView({
      snapshot: null,
      catalogBridge: async () => {
        throw new Error("catalog bridge down");
      },
    });
    await vi.waitFor(() => expect(container.textContent).toContain("取值目录不可用"));
    for (const testId of [
      "settings-vertical-select",
      "settings-preset-select",
      "settings-profile-select",
      "settings-task-scaffold-select",
      "settings-repository-scaffold-select",
    ])
      expect(select(container, testId).disabled, `${testId} 应停用`).toBe(true);
    expect(container.textContent).toContain("catalog bridge down");
    expect(container.querySelectorAll('input[aria-label^="默认"], input[aria-label*="脚手架"]').length).toBe(0);
  });
});
