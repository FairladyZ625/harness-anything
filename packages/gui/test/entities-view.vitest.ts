// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EntitiesView } from "../src/renderer/views/EntitiesView.tsx";
import { CURATED_ENTITY_DOC_GROUPS, FACT_TYPE_VOCABULARY } from "../src/renderer/entity-docs.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { ViewId } from "../src/renderer/navigation/viewHistory.ts";

/**
 * 实体说明面行为判据:目录 → 详情、活行数来自既有读面、GUI 入口跳转、
 * Fact Type 受控词表区的诚实空态(阴性对照:登记面未合入时不得渲染任何
 * 示例 Type,同时事实切面照常显示真实统计——证明空的是登记面,不是读面)。
 */

const REPO_ID = "repo-entities";
const noop = () => undefined;
const mounted: { root: Root; container: HTMLElement }[] = [];

/** 与 e2e declared-entity-kinds 场景同一个声明 kind:名字里带斜杠,是排版压力最大的样本。 */
const ADR_KIND = "software/coding/architecture-decision-record@1";

function declaredAdrKindRow() {
  return {
    kind: ADR_KIND,
    origin: "vertical",
    verticalId: "software/coding",
    refTemplate: `${ADR_KIND}/{id}`,
    relationEndpoint: true,
    importable: true,
    declaration: {
      id: "architecture-decision-record",
      version: 1,
      idPrefix: "ADR",
      display: { singular: "Architecture Decision Record", plural: "Architecture Decision Records" },
      descriptorSchemaRef: "descriptor/v1",
      pathTemplate: "entities/adrs/{id}.json",
      locatorKinds: ["repository-path"],
      maturityVocabulary: [],
    },
    explanation: {
      kind: ADR_KIND,
      documentSchema: {
        id: "adr-descriptor/v1",
        fields: [{ name: "locator", type: "string", required: true, description: "正文指针。" }],
      },
      relations: { edges: [] },
      statusVocabulary: [],
      transitions: {
        available: ["import"],
        actions: [
          {
            id: "import",
            input: {
              schema: "import/v1",
              fields: [
                { field: "locator", type: "string", required: true },
                { field: "title", type: "string", required: false },
              ],
            },
          },
        ],
      },
    },
  };
}

function governedRow(entityId: string, title: string | null = null) {
  return {
    kind: ADR_KIND,
    entityId,
    ref: `${ADR_KIND}/${entityId}`,
    title,
    locator: { kind: "repository-path", value: `docs/adr/${entityId}.md` },
    revision: 0,
  };
}

beforeAll(() => {
  setActiveLocale("zh-CN");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const { root } of mounted.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubBridge(
  domainTypes: ReadonlyArray<{ readonly domainType: string; readonly registeredByFactId: string }> = [],
  extras: {
    /** 已注册 kind 读面回包里的 kinds(声明实体详情布局用)。 */
    readonly kinds?: readonly unknown[];
    /** 声明实体行读面回包里的 rows。 */
    readonly rows?: readonly unknown[];
  } = {},
) {
  const calls = { relationGraph: 0 };
  vi.stubGlobal("window", {
    harness: {
      getWorkspaceSummary: vi.fn(async () => ({
        schema: "daemon.workspace-summary/v1",
        ok: true,
        status: "ready",
        tasks: { total: 12, byStatus: {} },
        decisions: { total: 7, inboxCount: 0, byState: {}, groups: [] },
        watermark: 40,
        sourceRevision: 40,
      })),
      getCatalogSnapshot: vi.fn(async () => ({
        schema: "gui-catalog-snapshot/v1",
        ok: true,
        status: "ready",
        repoId: REPO_ID,
        observedAt: "2026-08-30T00:00:00.000Z",
        catalogDigest: "digest000000000000",
        defaults: { verticalId: "software/coding", presetId: "preset-a", profileId: null, locale: "zh-CN" },
        presets: [
          {
            id: "preset-a",
            title: "A",
            description: "",
            verticalId: "software/coding",
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
        ],
        verticals: [],
        templates: [],
        scaffolds: { task: [], repository: [] },
        adapters: [
          {
            adapterId: "claude",
            registered: true,
            capabilities: [],
            writability: "read-write",
            defaultProvider: false,
            unavailableReason: null,
          },
        ],
      })),
      listAgents: vi.fn(async () => ({
        schema: "agent-entity-catalog/v1",
        ok: true,
        agents: [{ id: "glm-5-3", name: "GLM" }],
      })),
      listSquads: vi.fn(async () => ({
        schema: "squad-entity-catalog/v1",
        ok: true,
        squads: [],
      })),
      listSchedules: vi.fn(async () => ({
        ok: true,
        status: "ready",
        schedules: [
          {
            scheduleId: "schedule_alpha",
            name: "alpha",
            state: "armed",
            mode: "detect",
            availability: "available",
          },
        ],
        watermark: 3,
        sourceRevision: 3,
      })),
      // 已注册 kind 读面:目录分组与详情落点都从这里派生。
      readEntityKinds: vi.fn(async () => ({ schema: "entity-kind-catalog/v1", kinds: extras.kinds ?? [] })),
      readEntityRows: vi.fn(async () => ({ schema: "entity-row-list/v1", ok: true, rows: extras.rows ?? [] })),
      readEntityLocator: vi.fn(async ({ locatorValue }: { readonly locatorValue: string }) => ({
        schema: "entity-locator-read/v1",
        outcome: "file",
        path: locatorValue,
        content: `# ${locatorValue}\n\n这条正文来自 locator 读面。`,
        sizeBytes: 48,
        entries: [],
        truncated: false,
      })),
      getRelationGraph: vi.fn(async () => {
        calls.relationGraph += 1;
        return {
          ok: true,
          facet: "facts",
          edges: [],
          coverageRows: [],
          factAnchors: [],
          facts: [
            { anchor: "fact/F-AAAAAAAA", text: "观察一", category: "lesson" },
            { anchor: "fact/F-BBBBBBBB", text: "观察二", category: "lesson" },
            { anchor: "fact/F-CCCCCCCC", text: "观察三", category: "finding" },
          ],
          domainTypes: domainTypes.map((entry, index) => ({ ...entry, workspaceRevision: index + 1 })),
          warnings: [],
        };
      }),
    },
  });
  return calls;
}

async function renderSurface(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  mounted.push({ root, container });
  return container;
}

/**
 * 一拍宏任务 = react-query 通知订阅者的一轮。判据是「一轮通知内内容就位」,不是
 * 「若干毫秒内碰运气」:读链每多一段渲染门控的串行读,就要多一拍,这里必然红。
 * 原来的 20ms 预算在快机器上能盖住多余的轮次,只在 CI 上间歇性地暴露出来。
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function view(focusedRef: string | null, onOpenView: (view: ViewId) => void = noop) {
  return createElement(EntitiesView, {
    repoId: REPO_ID,
    focusedRef,
    onOpenEntityDoc: noop,
    onExitDetail: noop,
    onOpenView,
    projectName: "Probe",
  });
}

describe("entities catalog", () => {
  it("renders every documented entity as a card grouped by plane", async () => {
    stubBridge();
    const container = await renderSurface(view(null));
    for (const group of CURATED_ENTITY_DOC_GROUPS)
      expect(container.querySelector(`[data-testid="entity-doc-group-${group.id}"]`)).not.toBeNull();
    for (const doc of CURATED_ENTITY_DOC_GROUPS.flatMap((group) => group.docs))
      expect(container.querySelector(`[data-testid="entity-doc-card-${doc.kind}"]`), doc.kind).not.toBeNull();
  });

  it("shows live counts from the existing read surfaces", async () => {
    stubBridge();
    const container = await renderSurface(view(null));
    await settle();
    const taskCard = container.querySelector<HTMLElement>('[data-testid="entity-doc-card-task"]');
    expect(taskCard?.textContent).toContain("12");
    const agentCard = container.querySelector<HTMLElement>('[data-testid="entity-doc-card-agent"]');
    expect(agentCard?.textContent).toContain("1");
  });
});

describe("entity doc detail", () => {
  it("renders definition, fields, statuses, relations, and actions for a triad entity", async () => {
    stubBridge();
    const container = await renderSurface(view("entitydoc/decision"));
    await settle();
    const text = container.textContent ?? "";
    expect(container.querySelector('[data-testid="entity-doc-detail-decision"]')).not.toBeNull();
    expect(text).toContain("承重选择");
    expect(text).toContain("decisionId");
    expect(text).toContain("in_effect");
    expect(text).toContain("supersedes");
    expect(text).toContain("declare-claim");
    // 嵌套载荷分组与 GUI 入口说明都在详情里。
    expect(text).toContain("payload(proposal)");
    expect(text).toContain("决策批准 / 决策池");
  });

  it("navigates to the entity's live view from the detail header", async () => {
    stubBridge();
    const opened: ViewId[] = [];
    const container = await renderSurface(view("entitydoc/schedule", (next) => opened.push(next)));
    await settle();
    const button = container.querySelector<HTMLButtonElement>('button[title*="定时计划"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    expect(opened).toEqual(["schedules"]);
  });

  it("renders an honest unknown-kind state instead of guessing", async () => {
    stubBridge();
    const container = await renderSurface(view("entitydoc/unicorn"));
    expect(container.querySelector('[data-testid="entity-doc-detail-unknown"]')).not.toBeNull();
    expect(container.textContent).toContain("未知实体 kind:unicorn");
  });
});

describe("fact type vocabulary area (negative control)", () => {
  it("shows a real empty state with no fabricated types while the fact facet still renders live stats", async () => {
    const calls = stubBridge();
    const container = await renderSurface(view("entitydoc/fact"));
    await settle();
    const area = container.querySelector('[data-testid="fact-type-vocabulary"]');
    expect(area).not.toBeNull();
    // 裁决引用与真实投影标注都在场。
    expect(area?.textContent).toContain("投影实况");
    expect(area?.textContent).toContain(FACT_TYPE_VOCABULARY.decisionId);
    // 阴性对照:空投影不得出现任何示例 Type。
    const registered = container.querySelector('[data-testid="fact-type-registered-list"]');
    expect(registered?.textContent).toContain("空——");
    // 同一详情里,事实切面是真实数据:既有读面工作正常,空的是登记面本身。
    expect(calls.relationGraph).toBeGreaterThan(0);
    const live = container.querySelector('[data-testid="fact-facet-live"]');
    expect(live?.textContent).toContain("3 条 fact");
    expect(live?.textContent).toContain("lesson · 2");
    expect(live?.textContent).toContain("finding · 1");
  });

  it("renders registered types and their exact registration fact ids", async () => {
    stubBridge([
      { domainType: "architecture", registeredByFactId: "F-AAAABBBB" },
      { domainType: "bug", registeredByFactId: "F-CCCCDDDD" },
    ]);
    const container = await renderSurface(view("entitydoc/fact"));
    await settle();
    const registered = container.querySelector('[data-testid="fact-type-registered-list"]');
    expect(registered?.textContent).toContain("architecture");
    expect(registered?.textContent).toContain("fact/F-AAAABBBB");
    expect(registered?.textContent).toContain("bug");
    expect(registered?.textContent).toContain("fact/F-CCCCDDDD");
    expect(registered?.textContent).not.toContain("空——");
  });

  it("does not read the fact facet for other entities", async () => {
    const calls = stubBridge();
    await renderSurface(view("entitydoc/task"));
    await settle();
    expect(calls.relationGraph).toBe(0);
  });
});

describe("declared entity card overflow", () => {
  it("keeps the kind name and ref template on separate lines with full names in title attributes", async () => {
    stubBridge([], { kinds: [declaredAdrKindRow()] });
    const container = await renderSurface(view(null));
    // 已注册 kind 读面是异步的:声明实体那一组要等 query 回来才长出来。
    await settle();
    const card = container.querySelector<HTMLElement>(`[data-testid="entity-doc-card-${ADR_KIND}"]`);
    expect(card).not.toBeNull();
    // 长机器名不再被路径模板顶出去:标题独占一行(b),模板独占一行(code),全名进 title。
    const kindTitle = card!.querySelector("b");
    expect(kindTitle?.getAttribute("title")).toBe(ADR_KIND);
    expect(kindTitle?.textContent).toBe(ADR_KIND);
    const template = card!.querySelector("code");
    expect(template?.getAttribute("title")).toBe(`${ADR_KIND}/{id}`);
    expect(template?.textContent).toBe(`${ADR_KIND}/{id}`);
  });
});

describe("declared entity detail two-column layout", () => {
  it("renders an honest right-pane empty state before an entity is selected", async () => {
    stubBridge([], { kinds: [declaredAdrKindRow()], rows: [] });
    const container = await renderSurface(view(`entitydoc/${ADR_KIND}`));
    await settle();
    // 同一骨架:左列(说明 + 本仓实体清单)与右栏(渲染器)并存。
    expect(container.querySelector('[data-testid="entity-doc-detail-left"]')).not.toBeNull();
    const right = container.querySelector('[data-testid="entity-doc-detail-right"]');
    expect(right).not.toBeNull();
    // 空清单是真实空态:左列如实说明没有实体,右栏空态不冒充内容。
    expect(container.querySelector('[data-testid="governed-entity-empty"]')).not.toBeNull();
    const empty = right!.querySelector('[data-testid="entity-doc-renderer-empty"]');
    expect(empty?.textContent).toContain("本仓还没有这个 kind 的实体");
    expect(container.querySelector('[data-testid="entity-doc-renderer"]')).toBeNull();
  });

  it("renders the selected entity's document in the right pane via its locator", async () => {
    stubBridge([], {
      kinds: [declaredAdrKindRow()],
      rows: [governedRow("ADR-0001", "ADR-0001 · 探针"), governedRow("ADR-0002", "ADR-0002 · 复核")],
    });
    const container = await renderSurface(view(`entitydoc/${ADR_KIND}`));
    await settle();
    // 未选中时右栏是选择空态,不是第一条的预览。
    expect(container.querySelector('[data-testid="entity-doc-renderer-empty"]')?.textContent).toContain(
      "从左侧选择一个实体",
    );
    const row = container.querySelector<HTMLButtonElement>('[data-testid="governed-entity-row-ADR-0001"]');
    expect(row).not.toBeNull();
    await act(async () => {
      row!.click();
    });
    await settle();
    // 右栏按 locator 类型选渲染器:repository-path 的 Markdown 走既有 Markdown 渲染器。
    const renderer = container.querySelector('[data-testid="entity-doc-renderer"]');
    expect(renderer).not.toBeNull();
    const markdown = renderer!.querySelector('[data-testid="entity-locator-markdown"]');
    expect(markdown?.textContent).toContain("docs/adr/ADR-0001.md");
    expect(markdown?.textContent).toContain("这条正文来自 locator 读面");
    // 左列清单还在:选择不清空目录。
    expect(container.querySelector('[data-testid="governed-entity-list"]')).not.toBeNull();
  });

  it("preselects the deep-linked entity and renders its content", async () => {
    stubBridge([], {
      kinds: [declaredAdrKindRow()],
      rows: [governedRow("ADR-0001", "ADR-0001 · 探针"), governedRow("ADR-0002", "ADR-0002 · 复核")],
    });
    const container = await renderSurface(view(`${ADR_KIND}/ADR-0002`));
    await settle();
    const markdown = container.querySelector('[data-testid="entity-locator-markdown"]');
    expect(markdown?.textContent).toContain("docs/adr/ADR-0002.md");
  });

  it("narrows the entity list by search with an honest no-match state", async () => {
    stubBridge([], {
      kinds: [declaredAdrKindRow()],
      rows: [governedRow("ADR-0001", "ADR-0001 · 探针"), governedRow("ADR-0002", "ADR-0002 · 复核")],
    });
    const container = await renderSurface(view(`entitydoc/${ADR_KIND}`));
    await settle();
    const search = container.querySelector<HTMLInputElement>('[data-testid="governed-entity-search"]');
    expect(search).not.toBeNull();
    const type = async (text: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(search!, text);
        search!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type("0002");
    const rows = container.querySelectorAll('[data-testid^="governed-entity-row-"]');
    expect(rows.length).toBe(1);
    expect(rows[0]?.getAttribute("data-testid")).toBe("governed-entity-row-ADR-0002");
    await type("不存在的词");
    expect(container.querySelector('[data-testid="governed-entity-search-empty"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^="governed-entity-row-"]').length).toBe(0);
  });
});

describe("kernel entity detail keeps the same skeleton", () => {
  it("shows the doc columns on the left and an honest empty right pane", async () => {
    stubBridge();
    const container = await renderSurface(view("entitydoc/task"));
    await settle();
    expect(container.querySelector('[data-testid="entity-doc-detail-left"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="entity-doc-fields"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="entity-doc-actions"]')).not.toBeNull();
    // 内核实体没有仓内 locator:右栏保持空态并指向实况入口,不做第二套布局。
    const empty = container.querySelector('[data-testid="entity-doc-renderer-empty"]');
    expect(empty?.textContent).toContain("看实况");
    expect(container.querySelector('[data-testid="governed-entity-panel"]')).toBeNull();
  });
});
