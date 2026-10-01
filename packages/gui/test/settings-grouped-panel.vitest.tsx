// harness-test-tier: integration
// @vitest-environment happy-dom
// 设置页仓库面板的分组呈现:分组与逐项解释从 daemon catalog snapshot 的呈现元数据
// (settingsGroups + settingsFields 的 group/effect/defaultValue)派生;覆盖:
// ①分组按声明序渲染且每组有一句说明;②每个字段都有「改了会怎样」行;
// ③高级组默认折叠、可展开,搜索时自动展开;④当前值 ≠ 默认值时出现「已修改」标记,
// 恢复默认把草稿拨回默认值并随提交带出;⑤roles 按角色键粒度标记与恢复;
// ⑥页内搜索按名称/说明/后果过滤;⑦「只有业主本人能保存」的提示常驻;
// ⑧枚举取值旁有人话解释;⑨门映射编辑面归 CI 与门组。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsView } from "../src/renderer/views/SettingsView.tsx";
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { settingsQueryKeys } from "../src/renderer/settings-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import {
  CODE_DOC_GATE_ID,
  gateAppliesTo,
  gateGovernanceFields,
  gateMappingAdapterFields,
  governableWitnessAdapterIds,
  mappedWitnessAdapterIds,
} from "@harness-anything/kernel";
import { settingsFieldsFace, settingsGroupsFace } from "./settings-catalog-snapshot.ts";

const REPO_ID = "settings-grouped-probe";
const AT = "2026-10-01T00:00:00.000Z";
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
/** daemon settings read 的 values 面:默认值态(没有「已修改」标记)。 */
const SETTINGS_VALUES = {
  defaultVertical: "software/coding",
  defaultPreset: "standard-task",
  defaultProfile: "baseline",
  roles: {},
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
  agendaPinLimit: 30,
  wipLimit: 5,
  rootThreshold: 8,
  worktreeSetup: [],
  restoreDrillRetention: 3,
};
const SNAPSHOT = {
  schema: "gui-catalog-snapshot/v1" as const,
  ok: true as const,
  status: "ready" as const,
  repoId: REPO_ID,
  observedAt: AT,
  catalogDigest: "settings-grouped-digest-------------------",
  defaults: { verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", locale: "zh-CN" },
  // settingsFields/settingsGroups 与 daemon gui-catalog 同一映射(契约字段 + 呈现元数据)。
  settingsFields: settingsFieldsFace(),
  settingsGroups: settingsGroupsFace(),
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
      profiles: [{ id: "baseline", title: "Baseline" }],
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
  scaffolds: { task: ["governance/task-scaffold.json"], repository: ["governance/repository-scaffold.json"] },
  ciWorkflows: ["gui-release"],
  bundledAgents: ["closeout-reviewer"],
  adapters: [],
  gateMappings: {
    adapters: [...mappedWitnessAdapterIds, "none"],
    appliesTo: [...gateAppliesTo],
    adapterFields: gateMappingAdapterFields,
    governanceFields: [...gateGovernanceFields],
    governableAdapters: [...governableWitnessAdapterIds],
    internalGateId: CODE_DOC_GATE_ID,
  },
};
const AGENT_ROWS = [
  {
    id: "arch-reviewer",
    name: "Arch Reviewer",
    runtimes: [{ type: "codex" }],
    instance: null,
    permissionMode: null,
    role: "worker",
    layer: "installed",
  },
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

async function mountView(values: Record<string, unknown> = {}): Promise<HTMLElement> {
  const merged = { ...SETTINGS_VALUES, ...values },
    updateSettings = vi.fn(async (payload: Record<string, unknown>) => ({
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
        values: merged,
        lastChanged: "initial",
      }),
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsQueryKeys.read(REPO_ID), {
    schema: "daemon.settings-read/v1",
    ok: true,
    settings: SETTINGS,
    values: merged,
    lastChanged: "initial",
  });
  client.setQueryData(catalogQueryKeys.snapshot(REPO_ID), SNAPSHOT);
  client.setQueryData(["agents", REPO_ID], AGENT_ROWS);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SettingsView, { repoId: REPO_ID, repos: [], onOpenProject: () => {} }),
      ),
    );
  });
  for (let index = 0; index < 4; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
  return container;
}

function input(container: HTMLElement, testId: string): HTMLInputElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  expect(element, `${testId} 未渲染`).toBeTruthy();
  return element as HTMLInputElement;
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

/** 面板里的区块标题(Section header 文本)按出现顺序。 */
function sectionTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll("section > div > span")].map((node) => node.textContent ?? "");
}

describe("设置页按用途分组并逐项解释", () => {
  it("分组按声明序渲染,每组有一句说明,每个字段带「改了会怎样」行", async () => {
    const container = await mountView();
    expect(sectionTitles(container)).toEqual([
      "仓库设置",
      "新任务默认值",
      "默认派工角色",
      "评审与收口",
      "CI 与完成门",
      "容量与议程",
      "任务工作区",
      "存储与备份",
      "归属",
    ]);
    // 组说明:每组标题下有一句弱色说明。
    expect(container.textContent).toContain("新任务从哪里开始");
    // 每个可见字段都有后果行:抽两个代表(普通组 + 展开后的高级组)。
    expect(container.textContent).toContain("改了会怎样: 新任务会套用这个预设的计划与收口模板。");
    expect(container.textContent).toContain("改了会怎样: 派工会优先选用指定的 agent 声明");
  });

  it("高级组(存储与备份)默认折叠,展开后字段与后果行可见", async () => {
    const container = await mountView();
    expect(container.querySelector('[data-testid="settings-wal-flush-events"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings-wal-flush-events-modified"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="settings-advanced-toggle"]')!.click();
    });
    expect(input(container, "settings-wal-flush-events").value).toBe("256");
    expect(container.textContent).toContain("改了会怎样: 待写入事件积压到这个条数时");
  });

  it("当前值 ≠ 默认值时出现「已修改」标记,恢复默认拨回默认值并随提交带出", async () => {
    const container = await mountView({ walFlushEvents: 512, reviewReturnBudget: 3 });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="settings-advanced-toggle"]')!.click();
    });
    expect(container.querySelector('[data-testid="settings-walFlushEvents-modified"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="settings-reviewReturnBudget-modified"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="settings-walFlushEvents-restore"]')!.click();
    });
    expect(input(container, "settings-wal-flush-events").value).toBe("256");
    await act(async () => {
      saveButton(container).click();
    });
    expect(lastUpdatePayload()).toMatchObject({ walFlushEvents: 256 });
  });

  it("closeout 覆写的默认值随 profile 走:standard 下显式 true 标记已修改,恢复回落 false", async () => {
    const container = await mountView({ closeoutReview: true });
    expect(container.querySelector('[data-testid="settings-closeoutReview-modified"]')).toBeTruthy();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="settings-closeoutReview-restore"]')!.click();
    });
    await act(async () => {
      saveButton(container).click();
    });
    expect(lastUpdatePayload()).toMatchObject({ closeoutReview: false });
  });

  it("roles 按角色键粒度标记与恢复:恢复仅提交该键的 null 增量", async () => {
    const container = await mountView({ roles: { defaultReviewer: "closeout-reviewer" } });
    expect(container.querySelector('[data-testid="settings-roles-defaultReviewer-modified"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="settings-roles-defaultWorker-modified"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="settings-roles-defaultReviewer-restore"]')!.click();
    });
    await act(async () => {
      saveButton(container).click();
    });
    expect(lastUpdatePayload().roles).toEqual({ defaultReviewer: null });
  });

  it("页内搜索按名称/说明/后果过滤:命中组显示、其余组隐藏,高级组搜索时自动展开", async () => {
    const container = await mountView();
    const search = input(container, "settings-search");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "评审");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // 命中「评审与收口」组;新任务默认值组整组隐藏;高级组虽展开但无命中行,整组隐藏。
    expect(container.querySelector('[data-testid="settings-reviewIndependence-select"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="settings-vertical-select"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings-wal-flush-events"]')).toBeNull();
    expect(sectionTitles(container)).not.toContain("新任务默认值");
    // 命中后果文案也能搜到该字段(「恢复演练」在高级组)。
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "恢复演练");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input(container, "settings-restoreDrillRetention-input").value).toBe("3");
  });

  it("「只有业主本人能保存」提示常驻,枚举取值带旁注人话,门映射编辑面在 CI 组", async () => {
    const container = await mountView();
    expect(container.textContent).toContain("只有业主本人能保存修改");
    const options = [
      ...container.querySelectorAll<HTMLSelectElement>('[data-testid="settings-reviewIndependence-select"] option'),
    ];
    expect(options.map((option) => option.textContent)).toEqual([
      "execution · 换个执行会话即可,同一个人的另一个会话也能评",
      "principal · 必须换人,只有另一个人名下的 agent 才能评",
    ]);
    expect(options.map((option) => option.value)).toEqual(["execution", "principal"]);
    expect(container.querySelector('[data-testid="settings-gates-import"]')).toBeTruthy();
  });
});
