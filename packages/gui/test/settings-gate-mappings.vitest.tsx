// harness-test-tier: integration
/* @vitest-environment happy-dom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsView } from "../src/renderer/views/SettingsView.tsx";
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { settingsQueryKeys } from "../src/renderer/settings-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { gateMappingRowIssues } from "../src/renderer/gate-mapping-form.ts";
import {
  CODE_DOC_GATE_ID,
  gateAppliesTo,
  gateGovernanceFields,
  gateMappingAdapterFields,
  governableWitnessAdapterIds,
  mappedWitnessAdapterIds,
  settingsUpdateInputFields,
} from "@harness-anything/kernel";

const REPO_ID = "settings-gates-probe";
const GATES = [
  {
    gateId: "ci",
    adapter: "github-actions",
    appliesTo: "code",
    branch: "main",
    event: "push",
    coverage: "descendant",
    selection: "newest",
  },
  { gateId: "code-doc-reconciliation", adapter: "none" },
];
const SETTINGS = {
  schema: "settings/v1",
  settingsId: "repository",
  locale: "zh-CN",
  defaultVertical: "software/coding",
  defaultPreset: "standard-task",
  defaultProfile: "baseline",
  closeout: { profile: "standard", overrides: {} },
  scaffolds: { task: "governance/task-scaffold.json", repository: "governance/repository-scaffold.json" },
  walFlush: { adaptive: true, events: 256, bytes: 8_388_608, milliseconds: 2_000 },
  ci: { workflows: ["ci"] },
  gates: GATES,
};
const SNAPSHOT = {
  schema: "gui-catalog-snapshot/v1" as const,
  ok: true as const,
  status: "ready" as const,
  repoId: REPO_ID,
  observedAt: "2026-08-27T00:00:00.000Z",
  catalogDigest: "settings-gates-digest--------------------",
  defaults: { verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", locale: "zh-CN" },
  settingsFields: settingsUpdateInputFields.map(({ field, type, required, enum: values }) => ({
    field,
    type,
    required,
    ...(values ? { enum: [...values] } : {}),
  })),
  presets: [],
  verticals: [],
  templates: [],
  scaffolds: { task: [], repository: [] },
  ciWorkflows: ["ci"],
  bundledAgents: [],
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

async function mountView(options: { readonly gates?: unknown } = {}): Promise<HTMLElement> {
  const settings = { ...SETTINGS, ...(options.gates === undefined ? {} : { gates: options.gates }) };
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: {
      updateSettings: vi.fn(async (payload: Record<string, unknown>) => ({
        schema: "command-receipt/v2",
        ok: true,
        command: "settings-update",
        outcome: "applied",
        opId: String(payload.idempotencyKey),
      })),
      getSettings: async () => ({
        schema: "daemon.settings-read/v1",
        ok: true,
        settings,
        values: {},
        lastChanged: "initial",
      }),
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const read = { schema: "daemon.settings-read/v1", ok: true, settings, values: {}, lastChanged: "initial" };
  client.setQueryData(settingsQueryKeys.read(REPO_ID), read);
  client.setQueryData(catalogQueryKeys.snapshot(REPO_ID), SNAPSHOT);
  client.setQueryData(["agents", REPO_ID], []);
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

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid^="gate-mapping-row-"]')];
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === "提交到仓库")!;
  expect(button, "提交按钮未渲染").toBeTruthy();
  return button;
}

function lastUpdatePayload(): Record<string, unknown> {
  const bridge = window.harness as unknown as {
    readonly updateSettings: { readonly mock: { readonly calls: unknown[][] } };
  };
  const call = bridge.updateSettings.mock.calls.at(-1);
  expect(call, "settings update 未发出").toBeTruthy();
  return call![0] as Record<string, unknown>;
}

async function choose(element: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function type(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Settings 门映射编辑面", () => {
  it("照实渲染既有 ci → github-actions 映射;gatesFromDocument 是导入动作不是设置行", async () => {
    const container = await mountView();
    const gateRows = rows(container);
    expect(gateRows.length).toBe(2);
    expect((gateRows[0].querySelector('[data-testid="gate-mapping-0-gateId"]') as HTMLInputElement).value).toBe("ci");
    expect((gateRows[0].querySelector('[data-testid="gate-mapping-0-adapter"]') as HTMLSelectElement).value).toBe(
      "github-actions",
    );
    expect((gateRows[0].querySelector('[data-testid="gate-mapping-0-appliesTo"]') as HTMLSelectElement).value).toBe(
      "code",
    );
    for (const [testId, expected] of [
      ["gate-mapping-0-branch", "main"],
      ["gate-mapping-0-event", "push"],
    ] as const)
      expect((gateRows[0].querySelector(`[data-testid="${testId}"]`) as HTMLInputElement).value).toBe(expected);
    for (const [testId, expected] of [
      ["gate-mapping-0-coverage", "descendant"],
      ["gate-mapping-0-selection", "newest"],
    ] as const)
      expect((gateRows[0].querySelector(`[data-testid="${testId}"]`) as HTMLSelectElement).value).toBe(expected);
    // 内部门只给 none。
    expect(
      [...gateRows[1].querySelectorAll('[data-testid="gate-mapping-1-adapter"] option')].map(
        (option) => (option as HTMLOptionElement).value,
      ),
    ).toEqual(["none"]);
    // 命令/开关错配已修复:不存在持久 gatesFromDocument 行,只有导入动作按钮。
    expect(container.querySelector('[data-testid="settings-gatesFromDocument-toggle"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings-gatesFromDocument"]')).toBeNull();
    const importButton = container.querySelector<HTMLButtonElement>('[data-testid="settings-gates-import"]');
    expect(importButton).toBeTruthy();
    expect(importButton!.textContent).toContain("harness.yaml");
  });

  it("未改动时不发 gatesDraft;改动后才带规范化草稿", async () => {
    const container = await mountView();
    await act(async () => {
      saveButton(container).click();
    });
    expect(lastUpdatePayload()).not.toHaveProperty("gatesDraft");
    await choose(
      rows(container)[0].querySelector('[data-testid="gate-mapping-0-coverage"]') as HTMLSelectElement,
      "exact",
    );
    await act(async () => {
      saveButton(container).click();
    });
    expect(lastUpdatePayload().gatesDraft).toEqual([{ ...GATES[0], coverage: "exact" }, GATES[1]]);
  });

  it("manual-attest 加不了治理修饰:控件不渲染,切换 adapter 时非法键被剥离", async () => {
    const container = await mountView({
      gates: [{ gateId: "review-gate", adapter: "manual-attest", appliesTo: "submission" }],
    });
    const row = rows(container)[0];
    expect(row.querySelector('[data-testid="gate-mapping-0-mandatorySignoff"]')).toBeNull();
    expect(row.querySelector('[data-testid="gate-mapping-0-allowOverride"]')).toBeNull();
    // 打开治理修饰再切回 manual-attest:草稿里的修饰被剥离,提交载荷不会携带非法键。
    await choose(row.querySelector('[data-testid="gate-mapping-0-adapter"]') as HTMLSelectElement, "local-command");
    await type(row.querySelector('[data-testid="gate-mapping-0-command"]') as HTMLInputElement, "make attest");
    await act(async () => {
      (row.querySelector('[data-testid="gate-mapping-0-mandatorySignoff"] button') as HTMLElement).click();
    });
    await choose(row.querySelector('[data-testid="gate-mapping-0-adapter"]') as HTMLSelectElement, "manual-attest");
    expect(row.querySelector('[data-testid="gate-mapping-0-mandatorySignoff"]')).toBeNull();
    expect(saveButton(container).disabled).toBe(false);
    await act(async () => {
      saveButton(container).click();
    });
    // 草稿回到与原映射一致的状态:gatesDraft 不携带,更不会把剥掉的修饰发出去。
    expect(lastUpdatePayload()).not.toHaveProperty("gatesDraft");
  });

  it("判定层与中心同一判据:手工构造的非法草稿报出对应问题", () => {
    const descriptor = SNAPSHOT.gateMappings;
    expect(
      gateMappingRowIssues(
        [{ gateId: "g", adapter: "manual-attest", appliesTo: "submission", mandatorySignoff: true }],
        descriptor,
      ),
    ).toEqual([{ row: 0, issue: "governanceNotAllowed" }]);
    expect(
      gateMappingRowIssues(
        [
          {
            gateId: "g",
            adapter: "github-actions",
            appliesTo: "code",
            branch: "b",
            event: "e",
            coverage: "exact",
            selection: "newest",
            allowOverride: false,
          },
        ],
        descriptor,
      ),
    ).toEqual([{ row: 0, issue: "governanceNotAllowed" }]);
    expect(gateMappingRowIssues([{ gateId: "g", adapter: "none", appliesTo: "code" }], descriptor)).toEqual([
      { row: 0, issue: "adapterFieldUnexpected", field: "appliesTo" },
    ]);
    expect(
      gateMappingRowIssues(
        [{ gateId: "code-doc-reconciliation", adapter: "manual-attest", appliesTo: "code" }],
        descriptor,
      ),
    ).toEqual([{ row: 0, issue: "internalGateAdapter" }]);
    expect(
      gateMappingRowIssues(
        [
          { gateId: "ci", adapter: "none" },
          { gateId: "ci", adapter: "none" },
        ],
        descriptor,
      ),
    ).toEqual([{ row: 1, issue: "gateIdDuplicate" }]);
  });

  it("重复 gateId、非法形态与内部门非 none 都在提交前报错禁用", async () => {
    const container = await mountView();
    const addButton = container.querySelector<HTMLButtonElement>('[data-testid="gate-mapping-add"]')!;
    await act(async () => {
      addButton.click();
    });
    const gateRows = rows(container);
    expect(gateRows.length).toBe(3);
    const idInput = gateRows[2].querySelector('[data-testid="gate-mapping-2-gateId"]') as HTMLInputElement;
    await type(idInput, "ci");
    expect(container.textContent).toContain("重复");
    expect(saveButton(container).disabled).toBe(true);
    await type(idInput, "bad id!");
    expect(container.textContent).toContain("只含字母数字与");
    await type(idInput, "code-doc-reconciliation");
    // 内部门 adapter 选项只剩 none,不存在可选的非 none 项。
    const adapter = rows(container)[2].querySelector('[data-testid="gate-mapping-2-adapter"]') as HTMLSelectElement;
    expect([...adapter.querySelectorAll("option")].map((option) => (option as HTMLOptionElement).value)).toEqual([
      "none",
    ]);
  });

  it("「导入 harness.yaml 的门声明」按钮单独发出 gatesFromDocument 动作", async () => {
    const container = await mountView();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="settings-gates-import"]')!.click();
    });
    const payload = lastUpdatePayload();
    expect(payload.gatesFromDocument).toBe(true);
    expect(payload).not.toHaveProperty("gatesDraft");
  });
});
