// harness-test-tier: integration
// @vitest-environment happy-dom
// Settings → 仓库:字段面由 settings 动作契约派生(catalog snapshot 的 settingsFields,与 kernel
// 单源同源 import),取值面可枚举的字段是选择器,枚举来源是 daemon 目录快照
// (verticals / presets[].profiles / scaffolds / ciWorkflows / bundledAgents)与 agent 目录
// 共享缓存(已安装层),不是手打字符串。
// 覆盖:①字段集合 == 契约仓库字段(含 defaultReviewer/reviewIndependence/reviewReturnBudget/
// ciWorkflows 四个历史缺失项);②目录字段都是点选控件且选项来自目录(验收人单选 = bundled ∪
// 已安装,CI 工作流多选 checkbox,空集合合法);③当前值不在目录时并入选项/照实勾选、不静默
// 丢值;④换 preset 时 profile 落到新 preset 的默认 profile;⑤目录读面失败时选择器停用
// (fail closed),不回退成自由文本;⑥「终端」假面板已删除。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsView } from "../src/renderer/views/SettingsView.tsx";
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { settingsQueryKeys } from "../src/renderer/settings-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { settingsUpdateInputFields } from "../../kernel/src/index.ts";

const REPO_ID = "settings-selectors-probe";
const AT = "2026-08-27T00:00:00.000Z";
const SETTINGS = {
  schema: "settings/v1" as const,
  settingsId: "repository" as const,
  defaultVertical: "software/coding",
  defaultPreset: "standard-task",
  defaultProfile: "baseline",
  reviewIndependence: "execution" as const,
  closeout: { profile: "standard" as const },
  locale: "zh-CN" as const,
  scaffolds: { task: "governance/task-scaffold.json", repository: "governance/repository-scaffold.json" },
  walFlush: { adaptive: true, events: 256, bytes: 8_388_608, milliseconds: 3_600_000 },
};
/** daemon settings read 的 values 面:kernel repositorySettingsActionValues 的扁平映射。 */
const SETTINGS_VALUES = {
  defaultVertical: "software/coding",
  defaultPreset: "standard-task",
  defaultProfile: "baseline",
  reviewIndependence: "execution",
  reviewReturnBudget: 3,
  taskScaffold: "governance/task-scaffold.json",
  repositoryScaffold: "governance/repository-scaffold.json",
  walFlushAdaptive: true,
  walFlushEvents: 256,
  walFlushBytes: 8_388_608,
  walFlushMilliseconds: 3_600_000,
  ciWorkflows: [],
  closeoutProfile: "standard",
  closeoutReview: false,
  closeoutConsent: false,
  closeoutFactDisposition: false,
  closeoutCodeDoc: false,
  restoreDrillRetention: 3,
};
const SNAPSHOT = {
  schema: "gui-catalog-snapshot/v1" as const,
  ok: true as const,
  status: "ready" as const,
  repoId: REPO_ID,
  observedAt: AT,
  catalogDigest: "settings-selectors-digest--------------",
  defaults: { verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", locale: "zh-CN" },
  // settingsFields 与 daemon gui-catalog 同一映射,源直接 import kernel 单源——
  // 断言的派生面因此是真实契约,不是测试里再抄一份。
  settingsFields: settingsUpdateInputFields.map(({ field, type, required, enum: values }) => ({
    field,
    type,
    required,
    ...(values ? { enum: [...values] } : {}),
  })),
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
  // CI 工作流取值面:.github/workflows 的 *.yml 基名(不带后缀——kernel 拒绝带 .yml 的值)。
  ciWorkflows: ["gui-release", "issue-intake", "pr-body"],
  // 验收人取值面的 bundled 层;已安装层走 agent 目录共享缓存。
  bundledAgents: ["closeout-reviewer"],
  adapters: [],
};
/** agent 目录(listAgents)的已安装层行:available 行进取值面,degraded 行不进。 */
const AGENT_ROWS = [
  {
    id: "arch-reviewer",
    name: "Arch Reviewer",
    runtimeType: "codex",
    instance: null,
    permissionMode: null,
    role: "worker",
    layer: "installed",
  },
  { id: "broken-reviewer", layer: "user", state: "invalid", error: { code: "invalid_declaration", hint: "broken" } },
];
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
  options: {
    readonly snapshot?: unknown | null;
    readonly catalogBridge?: () => Promise<unknown>;
    /** 覆盖 settings values(默认 SETTINGS_VALUES);用于并集分支的既有值注入。 */
    readonly values?: Record<string, unknown>;
    /** agent 目录种子;null = 不种(桥缺失 → agents 读面失败,验 fail closed)。 */
    readonly agents?: readonly unknown[] | null;
  } = {},
): Promise<HTMLElement> {
  const values = { ...SETTINGS_VALUES, ...options.values };
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
      getSettings: async () => ({
        schema: "daemon.settings-read/v1",
        ok: true,
        settings: SETTINGS,
        values,
        lastChanged: "initial",
      }),
      ...(options.catalogBridge ? { getCatalogSnapshot: options.catalogBridge } : {}),
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsQueryKeys.read(REPO_ID), {
    schema: "daemon.settings-read/v1",
    ok: true,
    settings: SETTINGS,
    values,
    lastChanged: "initial",
  });
  // 目录快照与 agent 目录都走缓存种子(与 preset-detail/system-group-widescreen 同一模式),
  // 桥只承担写面;显式传 null 表示「不种」,用于让对应读面真的失败。
  if (options.snapshot !== null) client.setQueryData(catalogQueryKeys.snapshot(REPO_ID), options.snapshot ?? SNAPSHOT);
  if (options.agents !== null) client.setQueryData(["agents", REPO_ID], options.agents ?? AGENT_ROWS);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SettingsView, {
          repoId: REPO_ID,
          repos: [],
          onOpenProject: () => {},
        }),
      ),
    );
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

/** CI 工作流多选的面:每个 checkbox 的值(去 option- 前缀)与勾选态。 */
function checkboxValues(container: HTMLElement): { value: string; checked: boolean; label: string }[] {
  return [...container.querySelectorAll<HTMLInputElement>('[data-testid^="settings-ciWorkflows-option-"]')].map(
    (box) => ({
      value: (box.getAttribute("data-testid") ?? "").slice("settings-ciWorkflows-option-".length),
      checked: box.checked,
      label: box.closest("label")?.textContent ?? "",
    }),
  );
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
  it("目录字段全部是点选控件,选项来自目录快照与 agent 目录,且没有自由文本输入", async () => {
    const container = await mountView();
    // 目录选择器字段不得回退成自由文本。
    expect(
      container.querySelector(
        'input[aria-label="默认垂直"], input[aria-label="默认预设"], input[aria-label="默认配置"], input[aria-label*="脚手架"]',
      ),
    ).toBeNull();
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
    // 验收人 = 已安装层 ∪ bundled 层;degraded 安装行不进取值面(由当前值并集兜底)。
    expect(optionValues(select(container, "settings-defaultReviewer-select"))).toEqual([
      "",
      "arch-reviewer",
      "closeout-reviewer",
    ]);
    // CI 工作流 = 快照的 *.yml 基名,checkbox 多选,值一律不带 .yml/.yaml 后缀。
    const ciBoxes = checkboxValues(container);
    expect(ciBoxes.map(({ value }) => value)).toEqual(["gui-release", "issue-intake", "pr-body"]);
    expect(ciBoxes.every(({ value }) => !/\.ya?ml$/u.test(value))).toBe(true);
    expect(ciBoxes.every(({ checked }) => checked === false)).toBe(true);
    expect(container.querySelector('[data-testid="settings-ciWorkflows-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings-defaultReviewer-input"]')).toBeNull();
    expect((container.querySelector('[data-testid="settings-wal-flush-events"]') as HTMLInputElement).value).toBe(
      "256",
    );
  });

  it("字段面从契约派生:历史缺失的四个字段全部出现且类型正确,提交时进 payload", async () => {
    const container = await mountView();
    const reviewer = select(container, "settings-defaultReviewer-select");
    expect(reviewer.value).toBe("");
    expect(optionValues(select(container, "settings-reviewIndependence-select"))).toEqual(["execution", "principal"]);
    expect(select(container, "settings-reviewIndependence-select").value).toBe("execution");
    expect(
      (container.querySelector('[data-testid="settings-reviewReturnBudget-input"]') as HTMLInputElement).value,
    ).toBe("3");
    expect(checkboxValues(container).every(({ checked }) => !checked)).toBe(true);
    // closeout 档位与四个门也来自契约(此前由 CloseoutRows 硬编码渲染)。
    expect(optionValues(select(container, "settings-closeoutProfile-select"))).toEqual(["standard", "strict"]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(reviewer, "arch-reviewer");
      reviewer.dispatchEvent(new Event("change", { bubbles: true }));
      saveButton(container).click();
    });
    expect(lastUpdatePayload()).toMatchObject({
      defaultReviewer: "arch-reviewer",
      reviewIndependence: "execution",
      reviewReturnBudget: 3,
      ciWorkflows: [],
      closeoutProfile: "standard",
      closeoutReview: false,
      restoreDrillRetention: 3,
    });
  });

  it("「终端」假面板已删除:tab 列表里没有终端项", async () => {
    const container = await mountView();
    expect([...container.querySelectorAll("nav button")].some((tab) => tab.textContent === "终端")).toBe(false);
    expect(container.textContent).not.toContain("Geist Mono");
  });

  it("当前值不在目录里时并入选项并保留可提交,不静默丢值", async () => {
    const container = await mountView({
      snapshot: {
        ...SNAPSHOT,
        scaffolds: { task: ["governance/task-scaffold-strict.json"], repository: [] },
        presets: SNAPSHOT.presets.filter((row) => row.id !== "standard-task"),
      },
      values: { defaultReviewer: "ghost-reviewer", ciWorkflows: ["gui-release", "gone-flow"] },
    });
    const taskScaffold = select(container, "settings-task-scaffold-select"),
      repositoryScaffold = select(container, "settings-repository-scaffold-select"),
      preset = select(container, "settings-preset-select"),
      reviewer = select(container, "settings-defaultReviewer-select");
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
    // 验收人当前值不在面里:并入选项、照实选中、可提交。
    expect(reviewer.value).toBe("ghost-reviewer");
    expect(optionValues(reviewer)).toEqual(["", "arch-reviewer", "closeout-reviewer", "ghost-reviewer"]);
    expect(optionLabels(reviewer).at(-1)).toBe("ghost-reviewer · 目录中不存在");
    // ciWorkflows 当前值含已消失的工作流:照实列出并保持勾选。
    const ciBoxes = checkboxValues(container);
    expect(ciBoxes.map(({ value, checked }) => [value, checked])).toEqual([
      ["gui-release", true],
      ["issue-intake", false],
      ["pr-body", false],
      ["gone-flow", true],
    ]);
    expect(ciBoxes.at(-1)!.label).toBe("gone-flow · 目录中不存在");
    await act(async () => {
      saveButton(container).click();
    });
    expect(lastUpdatePayload()).toMatchObject({
      defaultPreset: "standard-task",
      defaultReviewer: "ghost-reviewer",
      ciWorkflows: ["gui-release", "gone-flow"],
      taskScaffold: "governance/task-scaffold.json",
      repositoryScaffold: "governance/repository-scaffold.json",
      walFlushAdaptive: true,
      walFlushEvents: 256,
      walFlushBytes: 8_388_608,
      walFlushMilliseconds: 3_600_000,
    });
  });

  it("CI 工作流勾选/取消可任意组合,空集合是合法可提交值(退出 CI 见证)", async () => {
    const container = await mountView();
    const box = (value: string) =>
      container.querySelector<HTMLInputElement>(`[data-testid="settings-ciWorkflows-option-${value}"]`)!;
    await act(async () => {
      box("issue-intake").click();
      box("pr-body").click();
    });
    await act(async () => {
      saveButton(container).click();
    });
    expect(lastUpdatePayload().ciWorkflows).toEqual(["issue-intake", "pr-body"]);
    await act(async () => {
      box("issue-intake").click();
      box("pr-body").click();
    });
    await act(async () => {
      saveButton(container).click();
    });
    expect(lastUpdatePayload().ciWorkflows).toEqual([]);
  });

  it("并集里的目录外工作流也能被取消勾选,不会永久钉在表单里", async () => {
    const container = await mountView({ values: { ciWorkflows: ["gui-release", "gone-flow"] } });
    const box = (value: string) =>
      container.querySelector<HTMLInputElement>(`[data-testid="settings-ciWorkflows-option-${value}"]`)!;
    expect(box("gone-flow").checked).toBe(true);
    await act(async () => {
      box("gone-flow").click();
    });
    // 取消勾选后,目录外的并集项从表单消失(不再钉在选项里)。
    expect(container.querySelector('[data-testid="settings-ciWorkflows-option-gone-flow"]')).toBeNull();
    await act(async () => {
      saveButton(container).click();
    });
    expect(lastUpdatePayload().ciWorkflows).toEqual(["gui-release"]);
  });

  it("agent 目录读面失败时验收人选择器停用并显示错误,不回退成自由文本(fail closed)", async () => {
    const container = await mountView({ agents: null });
    const reviewer = select(container, "settings-defaultReviewer-select");
    expect(reviewer.disabled).toBe(true);
    expect(container.querySelector('[data-testid="settings-defaultReviewer-input"]')).toBeNull();
    await vi.waitFor(() => expect(container.textContent).toContain("取值目录不可用"));
    // 其它目录选择器不因 agent 目录失败而停用。
    expect(select(container, "settings-vertical-select").disabled).toBe(false);
    expect(select(container, "settings-task-scaffold-select").disabled).toBe(false);
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

  it("目录读面失败时表单不渲染并显示错误,不回退成自由文本(fail closed)", async () => {
    const container = await mountView({
      snapshot: null,
      catalogBridge: async () => {
        throw new Error("catalog bridge down");
      },
    });
    await vi.waitFor(() => expect(container.textContent).toContain("取值目录不可用"));
    // 字段面来自目录快照:目录读不到就没有可派生的字段,选择器一律不存在,
    // 也不出现任何冒充这些字段的自由文本输入。
    for (const testId of [
      "settings-vertical-select",
      "settings-preset-select",
      "settings-profile-select",
      "settings-task-scaffold-select",
      "settings-repository-scaffold-select",
      "settings-defaultReviewer-select",
      "settings-ciWorkflows",
    ])
      expect(container.querySelector(`[data-testid="${testId}"]`), `${testId} 不应渲染`).toBeNull();
    expect(container.textContent).toContain("catalog bridge down");
    expect(
      container.querySelector(
        'input[aria-label="默认垂直"], input[aria-label="默认预设"], input[aria-label="默认配置"], input[aria-label*="脚手架"]',
      ),
    ).toBeNull();
  });
});
