// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHash } from "node:crypto";
import { EntitiesView } from "../src/renderer/views/EntitiesView.tsx";
import { CURATED_ENTITY_DOC_GROUPS, FACT_TYPE_VOCABULARY } from "../src/renderer/entity-docs.ts";
import { sourceIdentityOf } from "../src/renderer/entity-import-preview.ts";
import {
  VerticalKindForm,
  describeRelationsIssue,
  locateJsonError,
} from "../src/renderer/components/entityDoc/VerticalKindForm.tsx";
import type { ArtifactKindDeclaration } from "../src/renderer/vertical-kind-client.ts";
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

function declaredAdrKindRow(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function governedRow(
  entityId: string,
  title: string | null = null,
  overrides: {
    readonly locator?: string;
    readonly revision?: number;
    readonly archived?: boolean;
  } = {},
) {
  return {
    kind: ADR_KIND,
    entityId,
    ref: `${ADR_KIND}/${entityId}`,
    title,
    locator: { kind: "repository-path", value: overrides.locator ?? `docs/adr/${entityId}.md` },
    revision: overrides.revision ?? 0,
    ...(overrides.archived === undefined ? {} : { archived: overrides.archived }),
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
      readVerticalDeclaration: vi.fn(async () => ({
        schema: "repository-vertical-declaration-read/v1",
        declarationRevision: 7,
        declaration: {
          entityKinds: [
            {
              ...declaredAdrKindRow().declaration,
              entityType: "artifact",
              store: { pathTemplate: declaredAdrKindRow().declaration.pathTemplate },
            },
          ],
        },
      })),
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

function view(
  focusedRef: string | null,
  handlers: {
    readonly onOpenView?: (view: ViewId) => void;
    readonly onOpenEntityRef?: (ref: string) => void;
  } = {},
) {
  return createElement(EntitiesView, {
    repoId: REPO_ID,
    focusedRef,
    onOpenEntityDoc: noop,
    onOpenEntityRef: handlers.onOpenEntityRef ?? noop,
    onExitDetail: noop,
    onOpenView: handlers.onOpenView ?? noop,
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

  it("labels fixed and declared cards and routes runtime instance management to Providers", async () => {
    stubBridge([], { kinds: [declaredAdrKindRow()] });
    const opened: ViewId[] = [];
    const container = await renderSurface(view(null, { onOpenView: (next) => opened.push(next) }));
    await settle();
    expect(container.querySelector('[data-testid="entities-header"] h1')?.textContent).toBe("实体");
    expect(container.querySelector('[data-testid="entity-doc-card-runtime-instance"]')?.textContent).toContain(
      "固定实体 · 只展示",
    );
    expect(container.querySelector(`[data-testid="entity-doc-card-${ADR_KIND}"]`)?.textContent).toContain(
      "声明实体 · 可新建",
    );
    const manage = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="entity-doc-card-runtime-instance"] button'),
    ).find((button) => button.textContent === "管理");
    expect(manage).toBeDefined();
    await act(async () => manage!.click());
    expect(opened).toEqual(["providers"]);
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
    const container = await renderSurface(view("entitydoc/schedule", { onOpenView: (next) => opened.push(next) }));
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

describe("retired declared kind", () => {
  it("grays the card and removes the instance creation entry", async () => {
    stubBridge([], { kinds: [declaredAdrKindRow({ retired: true, importable: false })], rows: [] });
    const catalog = await renderSurface(view(null));
    await settle();
    const card = catalog.querySelector<HTMLElement>(`[data-testid="entity-doc-card-${ADR_KIND}"]`);
    expect(card?.className).toContain("grayscale");
    expect(card?.textContent).toContain("已停用");
    const detail = await renderSurface(view(`entitydoc/${ADR_KIND}`));
    await settle();
    expect(detail.querySelector('[data-testid="governed-entity-new"]')).toBeNull();
    expect(detail.textContent).toContain("已停用");
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

describe("catalog-page entity list (goal 4)", () => {
  it("groups the repo's declared entities by kind with freshness and deep-links on click", async () => {
    stubBridge([], {
      kinds: [declaredAdrKindRow()],
      rows: [
        { ...governedRow("ADR-0001", "ADR-0001 · 探针"), archived: false },
        { ...governedRow("ADR-0002", "ADR-0002 · 复核"), archived: true },
      ],
    });
    const openedRefs: string[] = [];
    const container = await renderSurface(view(null, { onOpenEntityRef: (ref) => openedRefs.push(ref) }));
    await settle();
    const list = container.querySelector('[data-testid="governed-entity-catalog-list"]');
    expect(list).not.toBeNull();
    // 按 kind 分组:组头带声明的复数显示名与 kind 机器名。
    const group = container.querySelector(`[data-testid="governed-entity-catalog-group-${ADR_KIND}"]`);
    expect(group?.textContent).toContain("Architecture Decision Records");
    // 默认只显示未归档;行上有 freshness 徽标;点击走整条 ref 深链。
    expect(group?.querySelectorAll('[data-testid^="governed-entity-catalog-row-"]').length).toBe(1);
    const row = group?.querySelector<HTMLButtonElement>('[data-testid="governed-entity-catalog-row-ADR-0001"]');
    expect(row?.textContent).toContain("现行");
    await act(async () => {
      row!.click();
    });
    expect(openedRefs).toEqual([`${ADR_KIND}/ADR-0001`]);
  });

  it("narrows the catalog list by title/id/locator search and hides when there is nothing to list", async () => {
    stubBridge([], { kinds: [declaredAdrKindRow()], rows: [governedRow("ADR-0001", "ADR-0001 · 探针")] });
    const container = await renderSurface(view(null));
    await settle();
    const search = container.querySelector<HTMLInputElement>('[data-testid="governed-entity-catalog-search"]');
    expect(search).not.toBeNull();
    const type = async (text: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(search!, text);
        search!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type("不存在的词");
    expect(container.querySelector('[data-testid="governed-entity-catalog-empty"]')).not.toBeNull();
    await type("0001");
    expect(container.querySelectorAll('[data-testid^="governed-entity-catalog-row-"]').length).toBe(1);
    // 没有声明实体时清单整个不渲染,不冒充空区块。
    const bare = stubBridge([], { kinds: [declaredAdrKindRow()], rows: [] });
    void bare;
    const emptyCatalog = await renderSurface(view(null));
    await settle();
    expect(emptyCatalog.querySelector('[data-testid="governed-entity-catalog-list"]')).toBeNull();
  });
});

/**
 * 实体 CRUD 判据(task_a494eac2 Goal 1/2/4):新建向导从既有实体的公共父目录起步,
 * 浏览/选定/预览(推导 id 与 kernel 公式一致)后走 repo.entity.import
 * (expectedVersion 恒 0,title 留空时不发);目录 locator 的树懒展开(展开才对子
 * 路径发读),点文件在内嵌查看器渲染;编辑/归档在详情操作区,列表行不挂写动作。
 * locator 读面按文件内容/目录条目两张固定表回包,写路径回执全部落在 state 里。
 */

const FILE_CONTENT: Readonly<Record<string, string>> = {
  "docs/adr/ADR-0001.md": "# ADR-0001 · 探针\n\n这条正文来自 locator 读面。",
  "docs/adr/ADR-0002.md": "# ADR-0002 · 复核\n\n第二条正文。",
  "docs/adr/ADR-0003.md": "# 新导入的研究\n\n导入后的正文。",
  "docs/adr/research/README.md": "# 研究包说明\n\n目录正文。",
  "docs/adr/research/notes.md": "# 笔记\n\n目录里的文件。",
};

const DIRECTORY_ENTRIES: Readonly<Record<string, ReadonlyArray<{ path: string; directory: boolean }>>> = {
  "docs/adr": [
    { path: "docs/adr/ADR-0001.md", directory: false },
    { path: "docs/adr/ADR-0002.md", directory: false },
    { path: "docs/adr/research", directory: true },
  ],
  "docs/adr/research": [
    { path: "docs/adr/research/README.md", directory: false },
    { path: "docs/adr/research/notes.md", directory: false },
  ],
};

function derivedId(path: string): string {
  return `ADR-${createHash("sha256").update(sourceIdentityOf(REPO_ID, path)).digest("hex").slice(0, 16)}`;
}

interface CrudBridgeState {
  rows: ReturnType<typeof governedRow>[];
  locatorCalls: string[];
  imports: unknown[];
  updates: unknown[];
  archives: unknown[];
}

function crudRow(entityId: string, locator: string): ReturnType<typeof governedRow> {
  return governedRow(entityId, null, { locator, revision: 4 });
}

function stubCrudBridge(initialRows: ReturnType<typeof governedRow>[] = []): CrudBridgeState {
  const state: CrudBridgeState = { rows: [...initialRows], locatorCalls: [], imports: [], updates: [], archives: [] };
  vi.stubGlobal("window", {
    harness: {
      getWorkspaceSummary: vi.fn(async () => ({
        schema: "daemon.workspace-summary/v1",
        ok: true,
        status: "ready",
        tasks: { total: 0, byStatus: {} },
        decisions: { total: 0, inboxCount: 0, byState: {}, groups: [] },
        watermark: 0,
        sourceRevision: 0,
      })),
      getCatalogSnapshot: vi.fn(async () => ({
        schema: "gui-catalog-snapshot/v1",
        ok: true,
        status: "ready",
        repoId: REPO_ID,
        observedAt: "2026-09-06T00:00:00.000Z",
        catalogDigest: "digest000000000000",
        defaults: {},
        presets: [],
        verticals: [],
        templates: [],
        scaffolds: { task: [], repository: [] },
        adapters: [],
      })),
      listAgents: vi.fn(async () => ({ schema: "agent-entity-catalog/v1", ok: true, agents: [] })),
      listSquads: vi.fn(async () => ({ schema: "squad-entity-catalog/v1", ok: true, squads: [] })),
      listSchedules: vi.fn(async () => ({ ok: true, status: "ready", schedules: [], watermark: 0, sourceRevision: 0 })),
      getRelationGraph: vi.fn(async () => ({
        ok: true,
        facet: "facts",
        edges: [],
        coverageRows: [],
        factAnchors: [],
        facts: [],
        domainTypes: [],
        warnings: [],
      })),
      readEntityKinds: vi.fn(async () => ({ schema: "entity-kind-catalog/v1", kinds: [declaredAdrKindRow()] })),
      readEntityRows: vi.fn(async () => ({ schema: "entity-row-list/v1", ok: true, rows: state.rows })),
      readVerticalDeclaration: vi.fn(async () => ({
        schema: "repository-vertical-declaration-read/v1",
        declarationRevision: 7,
        declaration: { entityKinds: [] },
      })),
      readEntityLocator: vi.fn(async ({ locatorValue }: { readonly locatorValue: string }) => {
        state.locatorCalls.push(locatorValue);
        const files = FILE_ENTRIES_PASSTHROUGH(locatorValue);
        if (files !== null) return files;
        const entries = DIRECTORY_ENTRIES[locatorValue];
        if (entries)
          return {
            schema: "entity-locator-read/v1",
            outcome: "directory",
            path: locatorValue,
            content: null,
            sizeBytes: null,
            entries,
            truncated: false,
          };
        return {
          schema: "entity-locator-read/v1",
          outcome: "missing",
          path: locatorValue,
          content: null,
          sizeBytes: null,
          entries: [],
          truncated: false,
        };
      }),
      importEntity: vi.fn(async (payload: object) => {
        state.imports.push(payload);
        const locator = (payload as { locator: string }).locator;
        state.rows.push(crudRow(derivedId(locator), locator));
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "entity.import",
          outcome: "applied",
          opId: "op-import-1",
        };
      }),
      updateEntity: vi.fn(async (payload: object) => {
        state.updates.push(payload);
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "entity.update",
          outcome: "applied",
          opId: "op-update-1",
        };
      }),
      archiveEntity: vi.fn(async (payload: object) => {
        state.archives.push(payload);
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "entity.archive",
          outcome: "applied",
          opId: "op-archive-1",
        };
      }),
    },
  });
  return state;
}

function FILE_ENTRIES_PASSTHROUGH(locatorValue: string) {
  const content = FILE_CONTENT[locatorValue];
  if (content === undefined) return null;
  return {
    schema: "entity-locator-read/v1",
    outcome: "file",
    path: locatorValue,
    content,
    sizeBytes: content.length,
    entries: [],
    truncated: false,
  };
}

async function renderCrudView(focusedRef: string | null): Promise<HTMLElement> {
  const container = await renderSurface(view(focusedRef));
  await settle();
  return container;
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button, testId).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  await settle();
}

describe("new entity wizard (goal 1)", () => {
  it("starts the browser at the common parent of existing locators", async () => {
    stubCrudBridge([crudRow("ADR-0001", "docs/adr/ADR-0001.md"), crudRow("ADR-0002", "docs/adr/ADR-0002.md")]);
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    expect(container.querySelector('[data-testid="new-entity-wizard"]')).not.toBeNull();
    // seed = 既有 locator 的最深公共父目录,不是手输,也不是仓根。
    expect(container.querySelector('[data-testid="repo-path-browser-location"]')?.textContent).toBe("docs/adr");
    expect(container.querySelector('[data-testid="new-entity-wizard-seed"]')).toBeNull();
  });

  it("asks for a seed only when no existing entity can suggest one", async () => {
    stubCrudBridge();
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    expect(container.querySelector('[data-testid="new-entity-wizard-seed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="repo-path-browser"]')).toBeNull();
  });

  it("navigates directories, previews the derived title and id, then imports without a hand-written id", async () => {
    const state = stubCrudBridge([crudRow("ADR-0001", "docs/adr/ADR-0001.md")]);
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    // 进入子目录:对子路径再发同一条目录读。
    await click(container, "repo-path-entry-docs/adr/research");
    expect(state.locatorCalls).toContain("docs/adr/research");
    expect(container.querySelector('[data-testid="repo-path-browser-location"]')?.textContent).toBe(
      "docs/adr/research",
    );
    // 选定文件:预览给出推导 title(文件首标题)与推导 id(kernel 公式)。
    await click(container, "repo-path-entry-docs/adr/research/notes.md");
    // 预览要等两条 query(内容读 + WebCrypto id 推导)都落定,轮询到内容就位。
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="new-entity-wizard-preview-area"]')?.textContent).toContain("笔记"),
    );
    const preview = container.querySelector('[data-testid="new-entity-wizard-preview-area"]');
    expect(preview?.textContent).toContain(derivedId("docs/adr/research/notes.md"));
    // 导入:expectedVersion 恒 0,title 留空就不发,人不填任何身份字段。
    await click(container, "new-entity-wizard-submit");
    expect(state.imports).toEqual([
      { repoId: REPO_ID, entityKind: ADR_KIND, locator: "docs/adr/research/notes.md", expectedVersion: 0 },
    ]);
    // 回执 applied 后:向导退出,行缓存刷新,新实体被选中并渲染正文。
    expect(container.querySelector('[data-testid="new-entity-wizard"]')).toBeNull();
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-locator-markdown"]')?.textContent).toContain("目录里的文件"),
    );
  });

  it("imports a directory target with the README heading as the derived title", async () => {
    const state = stubCrudBridge([crudRow("ADR-0001", "docs/adr/ADR-0001.md")]);
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    await click(container, "repo-path-entry-docs/adr/research");
    await click(container, "repo-path-browser-pick-directory");
    // 目录目标要等 listing → README 读的串行链加 id 推导,轮询到内容就位。
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="new-entity-wizard-preview-area"]')?.textContent).toContain(
        "研究包说明",
      ),
    );
    await click(container, "new-entity-wizard-submit");
    expect(state.imports).toEqual([
      { repoId: REPO_ID, entityKind: ADR_KIND, locator: "docs/adr/research", expectedVersion: 0 },
    ]);
  });
});

describe("directory locator browser (goal 2)", () => {
  it("lazily expands subdirectories and opens files in the inline viewer", async () => {
    const state = stubCrudBridge([crudRow("ADR-0001", "docs/adr")]);
    const container = await renderCrudView(`${ADR_KIND}/ADR-0001`);
    // 树根钉在实体目录:直接看到它的条目,不再是全路径分段的两级壳。
    const tree = container.querySelector('[data-testid="entity-locator-directory"]');
    expect(tree).not.toBeNull();
    expect(tree?.textContent).toContain("research/");
    expect(tree?.textContent).toContain("ADR-0002.md");
    // 未展开前不对子目录发读。
    expect(state.locatorCalls).not.toContain("docs/adr/research");
    await click(container, "entity-directory-node-docs/adr/research");
    expect(state.locatorCalls).toContain("docs/adr/research");
    // 点文件:内嵌查看器按渲染器选择表渲染 markdown(内容读是异步链,轮询到就位)。
    await click(container, "entity-directory-node-docs/adr/research/notes.md");
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-directory-file-markdown"]')?.textContent).toContain(
        "目录里的文件",
      ),
    );
  });

  it("shows the dedicated pdf card instead of pretending to render bytes", async () => {
    stubCrudBridge([crudRow("ADR-0001", "docs/adr/ADR-0001.md")]);
    const container = await renderCrudView(`${ADR_KIND}/ADR-0001`);
    expect(container.querySelector('[data-testid="entity-locator-pdf"]')).toBeNull();
    expect(container.querySelector('[data-testid="entity-locator-markdown"]')).not.toBeNull();
  });
});

describe("detail action area (goal 4)", () => {
  it("keeps edit and archive out of the list rows and acts on the selected entity", async () => {
    const state = stubCrudBridge([crudRow("ADR-0001", "docs/adr/ADR-0001.md")]);
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-row-ADR-0001");
    // 编辑/归档在详情操作区;列表行内不再出现这两个词。
    const row = container.querySelector('[data-testid="governed-entity-row-ADR-0001"]');
    expect(row?.textContent).not.toContain("编辑");
    expect(container.querySelector('[data-testid="entity-detail-actions"]')).not.toBeNull();
    // 编辑:保存走 repo.entity.update,expectedVersion 用行上的 revision。
    await click(container, "entity-detail-edit");
    const title = container.querySelector<HTMLInputElement>('input[aria-label="title"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(title!, "新标题");
      title!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container, "entity-detail-edit-save");
    expect(state.updates[0]).toMatchObject({
      repoId: REPO_ID,
      entityKind: ADR_KIND,
      entityId: "ADR-0001",
      expectedVersion: 4,
      title: "新标题",
      locator: "docs/adr/ADR-0001.md",
    });
    // 归档:带原因走 repo.entity.archive。
    await click(container, "entity-detail-archive");
    const reason = container.querySelector<HTMLInputElement>('input[aria-label="归档原因"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(reason!, "过期");
      reason!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container, "entity-detail-archive-confirm");
    expect(state.archives[0]).toMatchObject({
      repoId: REPO_ID,
      entityId: "ADR-0001",
      expectedVersion: 4,
      reason: "过期",
    });
  });
});

/**
 * kind 声明表单的收敛判据(task_a494eac2 Goal 3):编辑时身份/存储字段只读展示
 * (没有任何输入框),可编辑的只有 display / maturityVocabulary / relations;新建时
 * 按模板预填并逐字段说明;relations 的 JSON 错误能定位到行列或下标。
 */

const KIND_FORM_INITIAL: ArtifactKindDeclaration = {
  id: "architecture-decision-record",
  entityType: "artifact",
  version: 2,
  idPrefix: "ADR",
  display: { singular: "Architecture Decision Record", plural: "Architecture Decision Records" },
  descriptorSchemaRef: "schema://artifact-descriptor",
  store: { pathTemplate: "entities/adrs/{id}.json" },
  locatorKinds: ["repository-path"],
  maturityVocabulary: ["draft", "accepted"],
};

async function renderKindForm(initial?: ArtifactKindDeclaration): Promise<HTMLElement> {
  return renderSurface(
    createElement(VerticalKindForm, {
      ...(initial === undefined ? {} : { initial }),
      busy: false,
      error: null,
      onCancel: noop,
      onSubmit: noop,
    }),
  );
}

async function typeInto(container: HTMLElement, label: string, text: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input, label).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input!, text);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function typeTextarea(container: HTMLElement, label: string, text: string): Promise<void> {
  const area = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
  expect(area, label).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(area!, text);
    area!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("vertical kind form edit mode: identity fields are read-only display", () => {
  it("renders identity/storage as a definition list with no inputs for them", async () => {
    const container = await renderKindForm(KIND_FORM_INITIAL);
    const identity = container.querySelector('[data-testid="vertical-kind-identity"]');
    expect(identity?.textContent).toContain("architecture-decision-record");
    expect(identity?.textContent).toContain("entities/adrs/{id}.json");
    for (const label of ["id", "version", "idPrefix", "descriptorSchemaRef", "store.pathTemplate"]) {
      expect(container.querySelector(`input[aria-label="${label}"]`), label).toBeNull();
      expect(container.querySelector(`input[aria-label="${label}"][disabled]`), label).toBeNull();
    }
    // 可编辑的仍在:display 与词表。
    expect(container.querySelector('input[aria-label="display.singular"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="maturityVocabulary(逗号分隔)"]')).not.toBeNull();
  });
});

describe("vertical kind form new mode: template, not a blank form", () => {
  it("prefills template defaults and keeps identity editable with hints", async () => {
    const container = await renderKindForm();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="descriptorSchemaRef"]')?.value).toBe(
      "schema://artifact-descriptor",
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="store.pathTemplate"]')?.value).toBe(
      "entities/{id}.json",
    );
    const locatorCheckbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(locatorCheckbox?.checked).toBe(true);
    // 字段说明在场:不是空白表单让人盲填。
    expect(container.textContent).toContain("创建后不可改");
    expect(container.textContent).toContain("描述符落盘路径模板");
  });
});

describe("vertical kind form relations JSON editor localizes errors", () => {
  it("locates a parse error to line and column", () => {
    const message = locateJsonError("Unexpected token '}', ...\"}\" is not valid JSON (line 2 column 5)", "[\n}]");
    expect(message).toContain("第 2 行第 5 列");
  });

  it("converts a byte position into line and column", () => {
    const message = locateJsonError("Unexpected end of JSON input at position 7", "[\n  {}");
    expect(message).toContain("第 2 行");
  });

  it("reports the item index for structural violations", () => {
    const relation = {
      type: "relates",
      sourceKind: "task",
      targetKind: "software/coding/x@1",
      reads: "读取理由",
      strength: "weak",
      decisionClaimRef: "decision/dec_X/C1",
      decisionContentPin: `sha256:${"0".repeat(64)}`,
    };
    expect(describeRelationsIssue(JSON.stringify([relation]))).toBeNull();
    expect(describeRelationsIssue("not json")).toContain("JSON 解析失败");
    expect(describeRelationsIssue('{"a":1}')).toBe("relations 必须是 JSON 数组。");
    expect(describeRelationsIssue(JSON.stringify([{ ...relation, strength: "medium" }]))).toContain(
      "relations[0]:strength 只能是 weak 或 strong",
    );
    const { decisionClaimRef: _omitted, ...missingClaim } = relation;
    expect(describeRelationsIssue(JSON.stringify([relation, missingClaim]))).toContain(
      "relations[1]:缺少字段 decisionClaimRef",
    );
    expect(describeRelationsIssue(JSON.stringify([{ ...relation, extra: 1 }]))).toContain(
      "relations[0]:未声明字段 extra",
    );
  });

  it("shows the issue inline while typing", async () => {
    const container = await renderKindForm();
    // 展开可折叠编辑器。
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="vertical-kind-relations"] > button');
    await act(async () => {
      toggle!.click();
    });
    await typeTextarea(container, "relations JSON", "[\n}");
    expect(container.querySelector('[data-testid="vertical-kind-relations-issue"]')?.textContent).toContain(
      "JSON 解析失败",
    );
  });
});

describe("vertical kind form submission", () => {
  it("keeps the submit disabled until required editable fields are valid", async () => {
    const container = await renderKindForm();
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit?.disabled).toBe(true);
    await typeInto(container, "display.singular", "Research Note");
    await typeInto(container, "display.plural", "Research Notes");
    await typeInto(container, "idPrefix", "RSRCH");
    await typeInto(container, "id", "research-note");
    expect(submit?.disabled).toBe(false);
    await typeInto(container, "idPrefix", "1BAD");
    expect(submit?.disabled).toBe(true);
    await typeInto(container, "idPrefix", "RSRCH");
    expect(submit?.disabled).toBe(false);
  });
});
