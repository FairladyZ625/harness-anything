// harness-test-tier: integration
// @vitest-environment happy-dom
// G7 Preset 详情页:①列表紧凑行(名称/id/bundled-valid/vertical/版本/一句描述)点击进详情;
// ②详情页元数据(manifest/profile/completion gates/capability imports/provenance)+ 包内文档正文
// (gui-catalog-preset/v1 读面的 resolved.documents,DocReader 渲染 markdown);
// ③详情页宽屏铺满(复用 G1/G5 容器规则);④时间一律 formatTime。
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PresetsView } from "../src/renderer/views/PresetsView.tsx";
import { PresetDetailView } from "../src/renderer/views/PresetDetailView.tsx";
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { formatTime } from "../src/renderer/model/time.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const REPO_ID = "g7-probe";
const AT = "2026-08-26T08:09:10.000Z";
const PRESET_ID = "preset-g7";
const DOC_MD = {
  slot: "task.plan",
  path: "task_plan.md",
  body: "# 计划骨架\n\n## Brief 一句话说明任务目标与范围。\n",
  mediaType: "text/markdown",
  owner: "doc-sync",
  templateRef: "template://planning/task-plan@1",
};
const DOC_TXT = {
  slot: "task.facts",
  path: "facts.md",
  body: "F-001 keep-file plain text body\n",
  mediaType: "text/plain",
  owner: "doc-sync",
  templateRef: "template://planning/task-facts@1",
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
});

function seedQueries(client: QueryClient): void {
  client.setQueryData(catalogQueryKeys.snapshot(REPO_ID), {
    schema: "gui-catalog-snapshot/v1",
    ok: true,
    status: "ready",
    repoId: REPO_ID,
    observedAt: AT,
    catalogDigest: "g7-digest-g7-digest-g7-digest-",
    defaults: { verticalId: "g7", presetId: PRESET_ID, profileId: null, locale: "zh-CN" },
    presets: [
      {
        id: PRESET_ID,
        title: "G7 Preset",
        description: "fixture 预设描述",
        verticalId: "g7",
        sourceKind: "bundled",
        validity: "valid",
        version: "3.0.0",
        kind: "template-content",
        defaultProfile: "baseline",
        entrypoints: [],
        issues: [],
        shadows: null,
      },
    ],
    verticals: [],
    templates: [],
    adapters: [],
  });
  client.setQueryData(catalogQueryKeys.preset(REPO_ID, PRESET_ID, "zh-CN"), {
    schema: "gui-catalog-preset/v1",
    ok: true,
    repoId: REPO_ID,
    preset: {
      id: PRESET_ID,
      verticalId: "g7",
      version: "3.0.0",
      extends: null,
      capabilityImports: [{ id: "standard-task-check", kind: "checker", version: "1", required: false }],
    },
    resolved: {
      profile: { id: "baseline", completionGateIds: ["ci", "code-doc-reconciliation"] },
      templates: [
        { slot: "task.plan", path: "task_plan.md", locale: "zh-CN", owner: "doc-sync", requiredAnchors: ["## Brief"] },
      ],
      documents: [DOC_MD, DOC_TXT],
      entrypoints: [],
      provenance: {
        manifestSha256: `sha256:${"a".repeat(64)}`,
        packageSha256: `sha256:${"b".repeat(64)}`,
        verticalSha256: `sha256:${"c".repeat(64)}`,
        templateCatalogSha256: `sha256:${"d".repeat(64)}`,
        resolverVersion: "1",
        ancestry: ["software-coding-base", PRESET_ID],
      },
      digest: `sha256:${"e".repeat(64)}`,
    },
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

function listProps(overrides: Partial<Parameters<typeof PresetsView>[0]> = {}) {
  return {
    repoId: REPO_ID,
    focusedPresetId: null,
    onOpenPreset: () => undefined,
    onExitDetail: () => undefined,
    projectName: "G7 Probe",
    ...overrides,
  };
}

describe("G7 Preset 列表 → 详情", () => {
  it("列表是紧凑信息行:名称/id/bundled-valid/vertical/版本/一句描述,点击进详情", async () => {
    const opened: string[] = [];
    const container = await mountView(createElement(PresetsView, listProps({ onOpenPreset: (id) => opened.push(id) })));
    const row = container.querySelector<HTMLButtonElement>('[data-testid="preset-row"]');
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain("G7 Preset");
    expect(row!.textContent).toContain(PRESET_ID);
    expect(row!.textContent).toContain("bundled");
    expect(row!.textContent).toContain("valid");
    expect(row!.textContent).toContain("g7");
    expect(row!.textContent).toContain("3.0.0");
    expect(row!.textContent).toContain("fixture 预设描述");
    await act(async () => {
      row!.click();
    });
    expect(opened).toEqual([PRESET_ID]);
  });

  it("列表页时间走 formatTime(快照时间与重读回执不出现裸 ISO)", async () => {
    const container = await mountView(createElement(PresetsView, listProps()));
    const expected = formatTime(AT, { style: "date-time-seconds" });
    expect(expected).toBeTruthy();
    expect(container.textContent).toContain(expected!);
    expect(container.textContent).not.toContain(AT);
  });

  it("focusedPresetId 有值时渲染详情页(列表不再渲染)", async () => {
    const container = await mountView(createElement(PresetsView, listProps({ focusedPresetId: PRESET_ID })));
    expect(container.querySelector('[data-testid="preset-detail-view"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="preset-row"]')).toBeNull();
  });

  it("详情页概况:manifest 字段、completion gates、capability imports、provenance 五 sha", async () => {
    const container = await mountView(
      createElement(PresetDetailView, {
        repoId: REPO_ID,
        presetId: PRESET_ID,
        locale: "zh-CN",
        row: null,
        isDefault: true,
        projectName: "G7 Probe",
        fromViewLabel: "目录 / Preset",
        onBack: () => undefined,
      }),
    );
    const overview = container.querySelector('[data-testid="preset-overview-tab"]');
    expect(overview).toBeTruthy();
    const gates = container.querySelector('[data-testid="preset-completion-gates"]');
    expect(gates?.textContent).toContain("ci");
    expect(gates?.textContent).toContain("code-doc-reconciliation");
    expect(container.querySelector('[data-testid="preset-capability-imports"]')?.textContent).toContain(
      "standard-task-check · checker@1",
    );
    const shaFields = container.querySelectorAll('[data-testid="preset-sha-field"]');
    expect(shaFields.length).toBe(6); // 概况:digest + 4 个 provenance sha;身份条:digest
    expect(container.querySelector('[data-testid="preset-ancestry"]')?.textContent).toContain(PRESET_ID);
  });

  it("详情页 digest 不把 dt/dd 嵌进 dd", async () => {
    const container = await mountView(
      createElement(PresetDetailView, {
        repoId: REPO_ID,
        presetId: PRESET_ID,
        locale: "zh-CN",
        row: null,
        projectName: "G7 Probe",
        fromViewLabel: "目录 / Preset",
        onBack: () => undefined,
      }),
    );
    expect(container.querySelector("dd dt")).toBeNull();
    expect(container.querySelector("dd dd")).toBeNull();
  });

  it("详情页包内容:侧栏列包内文档,DocReader 渲染 markdown 正文,纯文本按原样", async () => {
    const container = await mountView(
      createElement(PresetDetailView, {
        repoId: REPO_ID,
        presetId: PRESET_ID,
        locale: "zh-CN",
        row: null,
        projectName: "G7 Probe",
        fromViewLabel: "目录 / Preset",
        onBack: () => undefined,
      }),
    );
    const sidebar = container.querySelector('[data-testid="preset-document-sidebar"]');
    expect(sidebar?.textContent).toContain("task.plan");
    expect(sidebar?.textContent).toContain("task.facts");

    // 切到「包内容」页签,默认渲染第一份文档的正文。
    const filesTab = container.querySelector<HTMLButtonElement>("#preset-tab-files");
    await act(async () => {
      filesTab!.click();
    });
    const reader = container.querySelector('[data-testid="doc-reader"]');
    expect(reader).toBeTruthy();
    expect(reader?.textContent).toContain("计划骨架");
    // markdown 标题经 DocReader 渲染为标题元素,正文断言按渲染后文本。
    expect(reader?.textContent).toContain("Brief 一句话说明任务目标与范围。");

    // 侧栏切到纯文本文档:不走 DocReader,按原样呈现。
    const plainButton = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-testid="preset-document-sidebar"] button'),
    ].find((button) => button.textContent?.includes("task.facts"));
    await act(async () => {
      plainButton!.click();
    });
    expect(container.querySelector('[data-testid="doc-reader"]')).toBeNull();
    expect(container.querySelector('[data-testid="preset-document-panel"]')?.textContent).toContain(
      "F-001 keep-file plain text body",
    );
  });

  it("详情页宽屏铺满(复用 G1/G5 容器规则):w-full、无 mx-auto、无视口 max-w 收口", async () => {
    const container = await mountView(
      createElement(PresetDetailView, {
        repoId: REPO_ID,
        presetId: PRESET_ID,
        locale: "zh-CN",
        row: null,
        projectName: "G7 Probe",
        fromViewLabel: "目录 / Preset",
        onBack: () => undefined,
      }),
    );
    const main = container.querySelector<HTMLElement>('[data-testid="preset-detail-content"]');
    expect(main).toBeTruthy();
    expect(main!.className).toContain("@container");
    const card = main!.firstElementChild as HTMLElement;
    expect(card.className).toContain("w-full");
    expect(card.className).not.toContain("mx-auto");
    expect(card.className).not.toMatch(/(^|\s)max-w-/u);
  });

  it("详情页返回按钮走 onBack(深链接回撤原路返回的页内出口)", async () => {
    let backCount = 0;
    const container = await mountView(
      createElement(PresetDetailView, {
        repoId: REPO_ID,
        presetId: PRESET_ID,
        locale: "zh-CN",
        row: null,
        projectName: "G7 Probe",
        fromViewLabel: "目录 / Preset",
        onBack: () => {
          backCount += 1;
        },
      }),
    );
    const backButton = container.querySelector<HTMLButtonElement>('[data-testid="preset-detail-header"] button');
    await act(async () => {
      backButton!.click();
    });
    expect(backCount).toBe(1);
  });
});
