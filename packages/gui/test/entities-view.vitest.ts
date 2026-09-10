// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { CURATED_ENTITY_DOC_GROUPS, FACT_TYPE_VOCABULARY } from "../src/renderer/entity-docs.ts";
import { describeRelationsIssue, locateJsonError } from "../src/renderer/components/entityDoc/VerticalKindForm.tsx";
import { describeAttributesIssue } from "../src/renderer/components/entityDoc/VerticalKindSchemaForm.tsx";
import {
  attributeDraftFrom,
  divergedFields,
  emptyAttributeDraft,
  entityAttributeFields,
  readAttributeDraft,
} from "../src/renderer/entity-attribute-form.ts";
import { soleContentFile } from "../src/renderer/entity-content-client.ts";
import { entityWriteSettlement } from "../src/renderer/entity-locator-client.ts";
import { findKindRow, verticalKindFence } from "../src/renderer/vertical-kind-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import {
  ADR_KIND,
  ADR_KIND_ID,
  KIND_FORM_INITIAL,
  PINNED_SCHEMA_VERSIONS,
  REPO_ID,
  acceptedAdrKindRow,
  click,
  crudRow,
  declaredAdrKindRow,
  governedRow,
  mounted,
  pickOption,
  renderCrudView,
  renderKindForm,
  renderSurface,
  settle,
  stubBridge,
  stubCrudBridge,
  toggle,
  typeInto,
  typeTextarea,
  view,
} from "./entities-view.fixtures.ts";

/**
 * 实体说明面行为判据:目录 → 详情、活行数来自既有读面、GUI 入口跳转、
 * Fact Type 受控词表区的诚实空态(阴性对照:登记面未合入时不得渲染任何
 * 示例 Type,同时事实切面照常显示真实统计——证明空的是登记面,不是读面)。
 *
 * 素材、桥接桩与挂载脚手架在 `entities-view.fixtures.ts`;这里只留判据。
 */

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
    const renderer = container.querySelector('[data-testid="entity-doc-renderer"]');
    expect(renderer).not.toBeNull();
    // 默认开在实体自己收管的内容上:那才是这个实体的东西,来源被移走也读得到。
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-managed-content-text"]')?.textContent).toContain(
        "这份正文归实体所有",
      ),
    );
    // 位置逐字来自读面。渲染层要是自己拼 `harness/`,这一行就会是错的。
    expect(container.querySelector('[data-testid="entity-managed-content-path"]')?.textContent).toBe(
      "ledger/entities/adrs/ADR-0001",
    );
    // 「来源」是另一屏:它读的是那个仓内路径此刻的样子。
    await click(container, "entity-body-tab-source");
    const markdown = container.querySelector('[data-testid="entity-locator-markdown"]');
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
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-managed-content-text"]')?.textContent).toContain("ADR-0002"),
    );
    await click(container, "entity-body-tab-source");
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

  it("keeps the seed input on screen until the whole directory has been typed", async () => {
    // 起点输入以前和浏览器共用一个状态:第一个字符一进去,输入框就被浏览器顶掉,
    // 没有既有实体的 kind 因此根本走不到新建。草稿态与已确认态必须分开。
    const state = stubCrudBridge();
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    expect(container.querySelector('[aria-label="浏览起点目录"]')).not.toBeNull();
    for (const partial of ["d", "do", "docs", "docs/", "docs/adr"]) {
      await typeInto(container, "浏览起点目录", partial);
      await settle();
      expect(container.querySelector('[aria-label="浏览起点目录"]'), partial).not.toBeNull();
      expect(container.querySelector('[data-testid="repo-path-browser"]'), partial).toBeNull();
    }
    // 半截路径没有被当成目录发过读。
    expect(state.locatorCalls).not.toContain("do");
    await click(container, "new-entity-wizard-seed-browse");
    expect(container.querySelector('[data-testid="repo-path-browser-location"]')?.textContent).toBe("docs/adr");
  });

  it("offers a url source only for the kinds whose declaration accepts one", async () => {
    // 声明只给 repository-path 时不摆 URL 输入;给了 url 才有,来源形态由声明决定。
    stubCrudBridge();
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    expect(container.querySelector('[data-testid="new-entity-wizard-source-kind"]')).toBeNull();
    expect(container.querySelector('[aria-label="外部 URL"]')).toBeNull();
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
    // 选定文件:预览给出推导 title(文件首标题)。id 不在预览里——它是中心铸的。
    await click(container, "repo-path-entry-docs/adr/research/notes.md");
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="new-entity-wizard-preview-area"]')?.textContent).toContain("笔记"),
    );
    const preview = container.querySelector('[data-testid="new-entity-wizard-preview-area"]');
    expect(preview?.textContent).not.toMatch(/ADR-[0-9a-f]{16}/u);
    // 导入:expectedVersion 恒 0,title 留空就不发,人不填任何身份字段。
    await click(container, "new-entity-wizard-submit");
    expect(state.imports).toEqual([
      { repoId: REPO_ID, entityKind: ADR_KIND, locator: "docs/adr/research/notes.md", expectedVersion: 0 },
    ]);
    // 回执 applied 后:向导退出,行缓存刷新,新实体被选中,正文就是它自己收下的那一份。
    expect(container.querySelector('[data-testid="new-entity-wizard"]')).toBeNull();
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-managed-content-text"]')?.textContent).toContain(
        "目录里的文件",
      ),
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
    await click(container, "entity-body-tab-source");
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
    await click(container, "entity-body-tab-source");
    expect(container.querySelector('[data-testid="entity-locator-pdf"]')).toBeNull();
    expect(container.querySelector('[data-testid="entity-locator-markdown"]')).not.toBeNull();
  });
});

describe("declared attributes on the new-entity wizard (E5)", () => {
  it("grows one control per attribute of the version the new instance pins", async () => {
    stubCrudBridge(
      [crudRow("ADR-0001", "docs/adr/ADR-0001.md")],
      [acceptedAdrKindRow({ schemaVersions: PINNED_SCHEMA_VERSIONS })],
    );
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="new-entity-wizard-attributes"]')).not.toBeNull(),
    );
    const attributes = container.querySelector('[data-testid="new-entity-wizard-attributes"]');
    // 钉的是最新已发布的那一版,页面直说是哪一版。
    expect(attributes?.textContent).toContain("v2");
    // 控件形态只由声明决定:有取值清单就是下拉,布尔是复选框,整数是数字框。
    expect(container.querySelector('select[aria-label="region"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="fiscalYear"]')?.getAttribute("type")).toBe("number");
    expect(container.querySelector('input[aria-label="reviewed"]')?.getAttribute("type")).toBe("checkbox");
    expect(attributes?.textContent).toContain("必填");
    expect(attributes?.textContent).toContain("可选");
    // v1 独有的属性不再出现:新实例钉不到那一版。
    expect(container.querySelector('[aria-label="legacyOwner"]')).toBeNull();
  });

  it("will not submit while a declared required attribute is empty", async () => {
    const state = stubCrudBridge(
      [crudRow("ADR-0001", "docs/adr/ADR-0001.md")],
      [acceptedAdrKindRow({ schemaVersions: PINNED_SCHEMA_VERSIONS })],
    );
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    await click(container, "repo-path-entry-docs/adr/ADR-0002.md");
    await vi.waitFor(() => expect(container.querySelector('[data-testid="new-entity-wizard-submit"]')).not.toBeNull());
    expect(container.querySelector<HTMLButtonElement>('[data-testid="new-entity-wizard-submit"]')?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="new-entity-wizard-attributes-incomplete"]')?.textContent).toContain(
      "2 项",
    );
    await click(container, "new-entity-wizard-submit");
    expect(state.imports).toEqual([]);
  });

  it("submits the declared values with the types the declaration states", async () => {
    const state = stubCrudBridge(
      [crudRow("ADR-0001", "docs/adr/ADR-0001.md")],
      [acceptedAdrKindRow({ schemaVersions: PINNED_SCHEMA_VERSIONS })],
    );
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    await click(container, "repo-path-entry-docs/adr/ADR-0002.md");
    await vi.waitFor(() => expect(container.querySelector('select[aria-label="region"]')).not.toBeNull());
    await pickOption(container, "region", "north");
    await typeInto(container, "fiscalYear", "2026");
    await toggle(container, "reviewed");
    await settle();
    await click(container, "new-entity-wizard-submit");
    // 整数到达中心时还是数字,不是 "2026";布尔是布尔。
    expect(state.imports).toEqual([
      {
        repoId: REPO_ID,
        entityKind: ADR_KIND,
        locator: "docs/adr/ADR-0002.md",
        expectedVersion: 0,
        attributes: { region: "north", fiscalYear: 2026, reviewed: true },
      },
    ]);
  });
});

describe("the entity's own content (E5)", () => {
  it("keeps a single-file entity readable after its source path is gone", async () => {
    // ADR-0009 的来源不在 fixture 的工作副本里:来源读回 missing,而被接受时收进来的那份
    // 字节照常读得出来。这就是「导入之后正文归实体所有」这句话的可核对形态。
    const state = stubCrudBridge([crudRow("ADR-0009", "docs/adr/ADR-0009.md")]);
    const container = await renderCrudView(`${ADR_KIND}/ADR-0009`);
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-managed-content-text"]')?.textContent).toContain(
        "收进实体的正文",
      ),
    );
    // 位置逐字来自读面。渲染层拼一个 `harness/` 前缀,自定义 authored root 的仓就会被谎报。
    expect(container.querySelector('[data-testid="entity-managed-content-path"]')?.textContent).toBe(
      "ledger/entities/adrs/ADR-0009",
    );
    // 寻址只用实体身份:内容读没有拿 locator 路径当过参数。
    expect(state.contentCalls).toContain("ADR-0009:");
    expect(state.contentCalls.some((call) => call.includes("docs/adr"))).toBe(false);
    // 来源那一屏如实说这个路径已经不在了。
    await click(container, "entity-body-tab-source");
    expect(container.querySelector('[data-testid="entity-locator-opaque"]')?.textContent).toContain("不存在");
  });

  it("browses a directory entity's own content one level at a time", async () => {
    const state = stubCrudBridge([crudRow("ADR-0001", "docs/adr")]);
    const container = await renderCrudView(`${ADR_KIND}/ADR-0001`);
    await vi.waitFor(() => expect(container.querySelector('[data-testid="entity-managed-content"]')).not.toBeNull());
    const tree = container.querySelector('[data-testid="entity-managed-content"]');
    expect(tree?.textContent).toContain("research/");
    expect(tree?.textContent).toContain("ADR-0002.md");
    // 多条目不替人挑:先是选择态,不是随便打开一份。
    expect(container.querySelector('[data-testid="entity-managed-content-text"]')).toBeNull();
    // 未展开前不对子目录发读。
    expect(state.contentCalls).not.toContain("ADR-0001:research");
    await click(container, "entity-content-node-research");
    expect(state.contentCalls).toContain("ADR-0001:research");
    await click(container, "entity-content-node-research/notes.md");
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-managed-content-text"]')?.textContent).toContain(
        "目录里的文件",
      ),
    );
  });

  it("states the pdf gap on the entity's own bytes instead of faking a preview", async () => {
    // 收管内容读面对二进制同样只给 `binary`,不载字节:这里给事实卡,不摆一个空的「预览」。
    stubCrudBridge([crudRow("ADR-0001", "docs/adr/research/paper.pdf")]);
    const container = await renderCrudView(`${ADR_KIND}/ADR-0001`);
    await vi.waitFor(() => expect(container.querySelector('[data-testid="entity-locator-pdf"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="entity-locator-pdf"]')?.textContent).toContain(
      "ledger/entities/adrs/ADR-0001/paper.pdf",
    );
    expect(container.querySelector('[data-testid="entity-managed-content-text"]')).toBeNull();
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
    // 归档:带原因走 repo.entity.archive。fence 是**刚才那次写之后**重读到的 revision——
    // 界面拿的是账本此刻的那一行,不是页面打开时记住的那一个。
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
      expectedVersion: 5,
      reason: "过期",
    });
  });

  /**
   * 已存在实例的属性编辑:读面给出这一条钉住的那一版与它现在的值 → 表单按那一版长出并
   * 预填 → 写走 `repo.entity.update` 的同一条 fence → 再读回来的是账本里的值。
   *
   * v1 与 v2 两条同 kind 实例同屏存在,证明表单认的是**这一条钉的那一版**,不是 kind 最新那一版。
   */
  const ADR_SCHEMA_VERSIONS = [
    { version: 1, attributes: {} },
    {
      version: 2,
      attributes: {
        region: { type: "string", enum: ["north", "south"], required: true },
        fiscalYear: { type: "integer", required: true },
        reviewed: { type: "boolean" },
      },
    },
  ];

  function pinnedRows() {
    return [
      governedRow("ADR-0001", "v1 期的那一条", {
        locator: "docs/adr/ADR-0001.md",
        revision: 4,
        descriptor: { kindVersion: 1, attributes: {} },
      }),
      governedRow("ADR-0002", "v2 期的那一条", {
        locator: "docs/adr/ADR-0002.md",
        revision: 7,
        descriptor: { kindVersion: 2, attributes: { region: "north", fiscalYear: 2026, reviewed: true } },
      }),
    ];
  }

  const pinnedBridge = () =>
    stubCrudBridge(pinnedRows(), [acceptedAdrKindRow({ schemaVersions: ADR_SCHEMA_VERSIONS })]);

  it("edits an existing instance's attributes against the version it pinned", async () => {
    const state = pinnedBridge();
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-row-ADR-0002");
    await click(container, "entity-detail-edit");
    // 表单按这一条钉的 v2 长出,并且从它**现在填的值**起——不是空表。
    const attributes = container.querySelector('[data-testid="entity-detail-attributes"]');
    expect(attributes?.textContent).toContain("v2");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="region"]')?.value).toBe("north");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="fiscalYear"]')?.value).toBe("2026");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="reviewed"]')?.checked).toBe(true);
    await typeInto(container, "fiscalYear", "2027");
    await click(container, "entity-detail-edit-save");
    // 递出去的是按声明还原了类型的值,fence 是这一行现在的 revision。
    expect(state.updates[0]).toMatchObject({
      repoId: REPO_ID,
      entityKind: ADR_KIND,
      entityId: "ADR-0002",
      expectedVersion: 7,
      attributes: { region: "north", fiscalYear: 2027, reviewed: true },
    });
    expect((state.updates[0] as { attributes: { fiscalYear: unknown } }).attributes.fiscalYear).toBe(2027);
    // 再打开一次:值来自失效后重读的那一行,而不是留在组件里的草稿。
    await click(container, "entity-detail-edit");
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLInputElement>('input[aria-label="fiscalYear"]')?.value).toBe("2027"),
    );
  });

  it("keeps a v1 instance on v1 after v2 is published", async () => {
    pinnedBridge();
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-row-ADR-0001");
    await click(container, "entity-detail-edit");
    // 这一条钉在 v1 上,那一版一个属性也没声明:页面因此不摆 v2 的必填项。
    expect(container.querySelector('[data-testid="entity-detail-attributes"]')).toBeNull();
    expect(container.querySelector('input[aria-label="fiscalYear"]')).toBeNull();
    expect(container.querySelector('[data-testid="entity-detail-edit-form"]')).not.toBeNull();
  });

  it("refuses to submit an emptied required attribute instead of erasing it", async () => {
    const state = pinnedBridge();
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-row-ADR-0002");
    await click(container, "entity-detail-edit");
    await typeInto(container, "fiscalYear", "");
    await click(container, "entity-detail-edit-save");
    expect(container.querySelector('[data-testid="entity-detail-attributes-incomplete"]')).not.toBeNull();
    expect(state.updates.length).toBe(0);
  });

  it("deletes through the entity-delete action and takes the row with it", async () => {
    const state = pinnedBridge();
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-row-ADR-0002");
    await click(container, "entity-detail-delete");
    await typeInto(container, "删除原因", "探针结束");
    await click(container, "entity-detail-delete-confirm");
    expect(state.deletes[0]).toMatchObject({
      repoId: REPO_ID,
      entityKind: ADR_KIND,
      entityId: "ADR-0002",
      expectedVersion: 7,
      reason: "探针结束",
    });
    // 删除取走这一行;同 kind 的另一条不受影响——删一个实体不动别人的东西。
    await vi.waitFor(() => expect(container.querySelector('[data-testid="governed-entity-row-ADR-0002"]')).toBeNull());
    expect(container.querySelector('[data-testid="governed-entity-row-ADR-0001"]')).not.toBeNull();
    expect(state.archives.length).toBe(0);
  });

  it("keeps an archived entity listed and says delete is the other thing", async () => {
    const state = pinnedBridge();
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-row-ADR-0002");
    await click(container, "entity-detail-archive");
    await typeInto(container, "归档原因", "过期");
    await click(container, "entity-detail-archive-confirm");
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-detail-actions-archived"]')).not.toBeNull(),
    );
    // 归档与删除的区别写在人看得到的地方:归档留下描述符与文件。
    expect(container.querySelector('[data-testid="entity-detail-actions-archived"]')?.textContent).toContain("都还在");
    expect(state.deletes.length).toBe(0);
  });

  it("says a write was accepted but not yet canonically visible instead of calling it done", async () => {
    const state = pinnedBridge();
    const bridge = (window as unknown as { harness: Record<string, unknown> }).harness;
    bridge.updateEntity = vi.fn(async (payload: object) => {
      state.updates.push(payload);
      return {
        schema: "command-receipt/v2",
        ok: true,
        command: "entity.update",
        outcome: "applied",
        opId: "entity-update-ADR-0002-7",
        proof: { durable: true, canonicalVisible: false, worktreeVisible: true },
      };
    });
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-row-ADR-0002");
    await click(container, "entity-detail-edit");
    await typeInto(container, "title", "尚未可见");
    await click(container, "entity-detail-edit-save");
    const pending = container.querySelector('[data-testid="entity-detail-action-pending"]');
    expect(pending).not.toBeNull();
    expect(pending?.textContent).toContain("entity-update-ADR-0002-7");
    expect(container.querySelector('[data-testid="entity-detail-action-applied"]')).toBeNull();
  });

  /**
   * fence 不成立:别人在你读到这一行之后改过它。界面要做三件事——说清撞的是什么、
   * 把重读回来的那一行摆出来、**不动**人还没提交的草稿。第三件是最容易被顺手做掉的:
   * 关掉表单或按新行重新起草,人刚输入的东西就没了,而他根本没被告知。
   */
  const conflictingBridge = () => {
    const state = pinnedBridge();
    const bridge = (window as unknown as { harness: Record<string, unknown> }).harness;
    bridge.updateEntity = vi.fn(async (payload: object) => {
      state.updates.push(payload);
      // 另一条 ingress 已经把 region 改成 south 并被接受,所以这一行现在是第 8 版。
      state.rows = state.rows.map((row) =>
        row.entityId !== "ADR-0002"
          ? row
          : {
              ...row,
              revision: 8,
              descriptor: { kindVersion: 2, attributes: { region: "south", fiscalYear: 2026, reviewed: true } },
            },
      );
      return {
        schema: "command-receipt/v2",
        ok: false,
        command: "entity.update",
        outcome: "op_rejected",
        opId: "entity-update-ADR-0002-7",
        code: "revision_conflict",
        rejectionExplanation: "Entity ADR-0002 expected revision 7, current revision is 8.",
      };
    });
    return state;
  };

  it("keeps an unsubmitted draft and names what the center now holds when the fence fails", async () => {
    const state = conflictingBridge();
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-row-ADR-0002");
    await click(container, "entity-detail-edit");
    await typeInto(container, "fiscalYear", "2099");
    await click(container, "entity-detail-edit-save");
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-detail-action-conflict"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-testid="entity-detail-action-conflict"]')?.textContent).toContain(
      "current revision is 8",
    );
    // 表单还开着,草稿一格没动。
    expect(container.querySelector('[data-testid="entity-detail-edit-form"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="fiscalYear"]')?.value).toBe("2099");
    // 重读回来的那一行说得出别人改了哪一格。
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-detail-conflict-field-region"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-testid="entity-detail-conflict-field-region"]')?.textContent).toContain(
      "south",
    );
    // 同一件事只说一遍:回执落定态已经说了,error 那一行不再抄一份。
    expect(container.querySelector('[data-testid="entity-detail-action-error"]')).toBeNull();
    expect(state.updates.length).toBe(1);
  });

  it("overwrites the draft with the center's values only when the person asks for it", async () => {
    conflictingBridge();
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-row-ADR-0002");
    await click(container, "entity-detail-edit");
    await typeInto(container, "fiscalYear", "2099");
    await click(container, "entity-detail-edit-save");
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-detail-conflict-adopt"]')).not.toBeNull(),
    );
    await click(container, "entity-detail-conflict-adopt");
    // 按下之后才用中心的值重填,并且冲突那一段随之收起——不是界面替他做的。
    expect(container.querySelector<HTMLInputElement>('input[aria-label="fiscalYear"]')?.value).toBe("2026");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="region"]')?.value).toBe("south");
    expect(container.querySelector('[data-testid="entity-detail-conflict-incoming"]')).toBeNull();
  });

  it("retries the same draft against the revision the center now holds", async () => {
    const state = conflictingBridge();
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-row-ADR-0002");
    await click(container, "entity-detail-edit");
    await typeInto(container, "fiscalYear", "2099");
    await click(container, "entity-detail-edit-save");
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-detail-conflict-incoming"]')).not.toBeNull(),
    );
    await click(container, "entity-detail-edit-save");
    // 第二次用的是重读回来的那一版 fence,递出去的仍是人自己的草稿。
    await vi.waitFor(() => expect(state.updates.length).toBe(2));
    expect(state.updates[1]).toMatchObject({
      entityId: "ADR-0002",
      expectedVersion: 8,
      attributes: { region: "north", fiscalYear: 2099, reviewed: true },
    });
  });

  it("keeps the drawer and the draft when the center never answered the write", async () => {
    const state = pinnedBridge();
    const bridge = (window as unknown as { harness: Record<string, unknown> }).harness;
    bridge.updateEntity = vi.fn(async (payload: object) => {
      state.updates.push(payload);
      return {
        schema: "command-receipt/v2",
        ok: false,
        command: "entity.update",
        outcome: "op_rejected",
        opId: "N/A",
        code: "daemon_closed",
        rejectionExplanation: "Local daemon request failed. Cause: daemon closed before JSON-RPC response 12",
      };
    });
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-row-ADR-0002");
    await click(container, "entity-detail-edit");
    await typeInto(container, "fiscalYear", "2099");
    await click(container, "entity-detail-edit-save");
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-detail-action-pending"]')).not.toBeNull(),
    );
    // 没被确认落定的一次写不收表:人手上的稿子还没有着落,关掉它就是替他丢了。
    expect(container.querySelector('[data-testid="entity-detail-edit-form"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="fiscalYear"]')?.value).toBe("2099");
    expect(container.querySelector('[data-testid="entity-detail-action-applied"]')).toBeNull();
  });

  it("drops the previous action's settlement when another action is opened", async () => {
    conflictingBridge();
    const container = await renderCrudView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-row-ADR-0002");
    await click(container, "entity-detail-edit");
    await click(container, "entity-detail-edit-save");
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="entity-detail-action-conflict"]')).not.toBeNull(),
    );
    await click(container, "entity-detail-archive");
    expect(container.querySelector('[data-testid="entity-detail-action-conflict"]')).toBeNull();
  });
});

/**
 * kind 声明表单的收敛判据(task_a494eac2 Goal 3):编辑时身份/存储字段只读展示
 * (没有任何输入框),可编辑的只有 display / maturityVocabulary / relations;新建时
 * 按模板预填并逐字段说明;relations 的 JSON 错误能定位到行列或下标。
 */

describe("vertical kind form edit mode: identity fields are read-only display", () => {
  it("renders identity/storage as a definition list with no inputs for them", async () => {
    const container = await renderKindForm(KIND_FORM_INITIAL);
    const identity = container.querySelector('[data-testid="vertical-kind-identity"]');
    expect(identity?.textContent).toContain("architecture-decision-record");
    expect(identity?.textContent).toContain("entities/adrs/{id}.json");
    for (const label of ["id", "kindId", "idPrefix", "descriptorSchemaRef", "store.pathTemplate"]) {
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
      targetKind: "entity-kind/KND-2a6d1b8f0c4e5d7b9f3a1c2e4d6b8f05",
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

/**
 * Kind 生命周期写路判据(Kind fence 合同):fence 是该 Kind 自己的接受版本(row.revision),
 * 不是整份声明的 revision——别的 Kind 被写不会让自己过期;创建用 0 表态;寻址用稳定
 * kindId,改名只换 qualified id;发布新属性版本是独立动作,不重写已发布正文。
 */
describe("kind lifecycle fence and addressing", () => {
  const SIBLING_KIND_ID = "KND-2a6d1b8f0c4e5d7b9f3a1c2e4d6b8f05";

  it("computes the fence from the addressed Kind's own row, not the declaration revision", async () => {
    const read = {
      schema: "repository-vertical-declaration-read/v1" as const,
      declarationRevision: 7,
      declaration: {
        entityKinds: [
          acceptedAdrKindRow(),
          acceptedAdrKindRow({ kindId: SIBLING_KIND_ID, id: "research", idPrefix: "RSRCH", revision: 9 }),
        ],
      },
    };
    expect(verticalKindFence(read, ADR_KIND_ID)).toBe(4);
    expect(verticalKindFence(read, ADR_KIND)).toBe(4);
    // 姊妹 Kind 的 revision(9)与整份声明的 revision(7)都不串味;未知 Kind 是创建态 0。
    expect(verticalKindFence(read, SIBLING_KIND_ID)).toBe(9);
    expect(verticalKindFence(read, "KND-00000000000000000000000000000000")).toBe(0);
    expect(findKindRow(read, SIBLING_KIND_ID)?.id).toBe("research");
  });

  it("creates a kind with fence 0 and no minted identity of its own", async () => {
    const calls = stubBridge();
    const container = await renderSurface(view(null));
    await click(container, "new-vertical-kind");
    const form = container.querySelector('[data-testid="vertical-kind-form"]');
    expect(form).not.toBeNull();
    await typeInto(container, "id", "field-note");
    await typeInto(container, "idPrefix", "FN");
    await typeInto(container, "display.singular", "Field Note");
    await typeInto(container, "display.plural", "Field Notes");
    await act(async () => {
      form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });
    await settle();
    expect(calls.upserts.length).toBe(1);
    const payload = calls.upserts[0] as Record<string, unknown>;
    // 创建:寻址用自选的 qualified id,fence 0;身份(kindId/schemaVersions/revision)由中心铸造,
    // 声明里不出现,也没有已被删除的 version 字段。
    expect(payload).toMatchObject({
      repoId: REPO_ID,
      kindId: "field-note",
      expectedVersion: 0,
      declaration: { id: "field-note", entityType: "artifact", idPrefix: "FN" },
    });
    expect(Object.keys(payload.declaration as object)).not.toContain("kindId");
    expect(Object.keys(payload.declaration as object)).not.toContain("schemaVersions");
    expect(Object.keys(payload.declaration as object)).not.toContain("version");
  });

  it("renames through the stable kindId fenced on the row's own revision", async () => {
    const calls = stubBridge([], { kinds: [declaredAdrKindRow()] });
    const container = await renderSurface(view(`entitydoc/${ADR_KIND}`));
    await settle();
    const edit = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "编辑种类",
    );
    expect(edit).toBeDefined();
    await act(async () => {
      edit!.click();
    });
    await settle();
    await typeInto(container, "display.singular", "Decision Record");
    const form = container.querySelector('[data-testid="vertical-kind-form"]');
    await act(async () => {
      form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });
    await settle();
    expect(calls.upserts.length).toBe(1);
    // 改名换的是 qualified id/display;寻址与 fence 都落在 action 的 kindId(稳定身份)上
    // ——row.revision 4,不是整份声明的 declarationRevision 7。restatement 本身不再
    // 手填身份:声明里只有 facets,身份由中心持有。
    expect(calls.upserts[0]).toMatchObject({
      repoId: REPO_ID,
      kindId: ADR_KIND_ID,
      expectedVersion: 4,
      declaration: { id: "architecture-decision-record", display: { singular: "Decision Record" } },
    });
    expect(Object.keys((calls.upserts[0] as Record<string, unknown>).declaration as object)).not.toContain("kindId");
  });

  it("publishes the next attribute version without touching published bodies", async () => {
    const calls = stubBridge([], { kinds: [declaredAdrKindRow()] });
    const container = await renderSurface(view(`entitydoc/${ADR_KIND}`));
    await settle();
    const publish = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "发布属性版本",
    );
    expect(publish).toBeDefined();
    await act(async () => {
      publish!.click();
    });
    await settle();
    const form = container.querySelector('[data-testid="vertical-kind-schema-form"]');
    expect(form).not.toBeNull();
    // 已发布正文只读在场;发布的是 v2。
    expect(form?.textContent).toContain("已发布版本");
    expect(form?.textContent).toContain("发布 v2");
    const attributes = '{"severity":{"type":"string","enum":["low","high"],"required":true}}';
    await typeTextarea(container, "attributes JSON", attributes);
    await act(async () => {
      form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });
    await settle();
    expect(calls.publishes.length).toBe(1);
    expect(calls.publishes[0]).toEqual({
      repoId: REPO_ID,
      kindId: ADR_KIND_ID,
      attributes: { severity: { type: "string", enum: ["low", "high"], required: true } },
      expectedVersion: 4,
    });
  });

  it("retires through the stable kindId fenced on the row's own revision", async () => {
    const calls = stubBridge([], { kinds: [declaredAdrKindRow()] });
    const container = await renderSurface(view(`entitydoc/${ADR_KIND}`));
    await settle();
    const retire = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "停用种类",
    );
    expect(retire).toBeDefined();
    await act(async () => {
      retire!.click();
    });
    await settle();
    await typeInto(container, "停用原因", "生命周期结束");
    const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "确认停用",
    );
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm!.click();
    });
    await settle();
    expect(calls.retires.length).toBe(1);
    expect(calls.retires[0]).toMatchObject({
      repoId: REPO_ID,
      kindId: ADR_KIND_ID,
      reason: "生命周期结束",
      expectedVersion: 4,
    });
  });
});

describe("attribute declaration editor localizes issues", () => {
  it("mirrors the kernel attribute contract before submission", () => {
    expect(describeAttributesIssue('{"confidence":{"type":"integer"}}')).toBeNull();
    expect(describeAttributesIssue('{"severity":{"type":"string","enum":["low","high"],"required":true}}')).toBeNull();
    expect(describeAttributesIssue("{}")).toBeNull();
    expect(describeAttributesIssue("not json")).toContain("JSON 解析失败");
    expect(describeAttributesIssue("[]")).toContain("attributes 必须是 JSON 对象");
    expect(describeAttributesIssue('{"BadName":{"type":"string"}}')).toContain("名称须以小写字母开头");
    expect(describeAttributesIssue('{"confidence":{"type":"float"}}')).toContain("type 只能是");
    expect(describeAttributesIssue('{"severity":{"type":"string","enum":[]}}')).toContain("enum 必须是非空字符串数组");
    expect(describeAttributesIssue('{"confidence":{"type":"integer","unit":"kg"}}')).toContain("未声明字段 unit");
  });
});

/**
 * 属性表单的判定面(E5)。这一层决定「填什么、怎么算填对了、递出去的是什么类型」,
 * 与渲染分开——判定分开才测得动,也才保证 GUI 里没有按 kind 名字写死的分支。
 */
describe("declared attributes become form fields", () => {
  it("takes every supported declaration in the order the author wrote it", () => {
    expect(
      entityAttributeFields({
        region: { type: "string", enum: ["north", "south"], required: true },
        fiscalYear: { type: "integer" },
        reviewed: { type: "boolean", required: true },
        weight: { type: "number" },
      }),
    ).toEqual([
      { name: "region", type: "string", options: ["north", "south"], required: true },
      { name: "fiscalYear", type: "integer", options: null, required: false },
      { name: "reviewed", type: "boolean", options: null, required: true },
      { name: "weight", type: "number", options: null, required: false },
    ]);
  });

  it("leaves out declarations no control can honestly generate", () => {
    // 猜一个控件出来,人填进去的值会在中心被拒——那比不摆更糟。
    expect(entityAttributeFields({ nested: { type: "object" }, loose: "string", empty: null })).toEqual([]);
    expect(entityAttributeFields(null)).toEqual([]);
    expect(entityAttributeFields([{ type: "string" }])).toEqual([]);
    expect(entityAttributeFields(undefined)).toEqual([]);
  });

  it("starts booleans at false and everything else unfilled", () => {
    const fields = entityAttributeFields({ reviewed: { type: "boolean" }, region: { type: "string" } });
    expect(emptyAttributeDraft(fields)).toEqual({ reviewed: "false", region: "" });
  });

  it("starts an existing instance from the values it already holds", () => {
    // 改一条既有实例时从空表起,就是在请人把已有的值重打一遍——漏打的那一个会被抹掉。
    const fields = entityAttributeFields({
      region: { type: "string", enum: ["north", "south"] },
      fiscalYear: { type: "integer" },
      reviewed: { type: "boolean" },
      note: { type: "string" },
    });
    expect(attributeDraftFrom(fields, { region: "south", fiscalYear: 2026, reviewed: true, retired: "yes" })).toEqual({
      region: "south",
      fiscalYear: "2026",
      reviewed: "true",
      // 这一版声明里有、这一条没填的属性留空;别的版本才有的 `retired` 不进这一版的草稿。
      note: "",
    });
  });
});

describe("a draft becomes the values the center is given", () => {
  const fields = entityAttributeFields({
    region: { type: "string", enum: ["north", "south"], required: true },
    fiscalYear: { type: "integer", required: true },
    weight: { type: "number" },
    note: { type: "string" },
    reviewed: { type: "boolean" },
  });

  it("restores the declared types instead of shipping every value as a string", () => {
    const reading = readAttributeDraft(fields, {
      region: "north",
      fiscalYear: "2026",
      weight: "1.5",
      note: "  之后再说  ",
      reviewed: "true",
    });
    expect(reading.issues).toEqual({});
    expect(reading.values).toEqual({
      region: "north",
      fiscalYear: 2026,
      weight: 1.5,
      note: "之后再说",
      reviewed: true,
    });
    expect(typeof reading.values.fiscalYear).toBe("number");
  });

  it("omits an untouched optional attribute rather than inventing an empty value", () => {
    // 声明没给它默认值:替调用者写一个空串,就是在描述符里写下一个人没说过的事实。
    const reading = readAttributeDraft(fields, { region: "south", fiscalYear: "1", weight: "", note: "" });
    expect(Object.keys(reading.values).sort()).toEqual(["fiscalYear", "region", "reviewed"]);
    expect(reading.values.reviewed).toBe(false);
  });

  it("names the cell that is wrong and refuses to guess past it", () => {
    const reading = readAttributeDraft(fields, {
      region: "east",
      fiscalYear: "2026.5",
      weight: "很重",
      reviewed: "false",
    });
    expect(reading.issues).toEqual({
      region: "只能是:north、south。",
      fiscalYear: "必须是整数。",
      weight: "必须是数字。",
    });
    // 判定不通过的格子不进提交值。
    expect(Object.keys(reading.values)).toEqual(["reviewed"]);
  });

  it("calls an empty required attribute out by name", () => {
    expect(readAttributeDraft(fields, { region: "", fiscalYear: "" }).issues).toEqual({
      region: "必填。",
      fiscalYear: "必填。",
    });
  });
});

describe("opening an entity's own content", () => {
  it("opens a lone file and leaves a real choice to the reader", () => {
    expect(soleContentFile([{ path: "ADR-0001.md", directory: false, sizeBytes: 12 }])).toBe("ADR-0001.md");
    expect(
      soleContentFile([
        { path: "README.md", directory: false, sizeBytes: 12 },
        { path: "notes.md", directory: false, sizeBytes: 12 },
      ]),
    ).toBeNull();
    expect(
      soleContentFile([
        { path: "README.md", directory: false, sizeBytes: 12 },
        { path: "research", directory: true, sizeBytes: null },
      ]),
    ).toBeNull();
    expect(soleContentFile([])).toBeNull();
  });
});

/**
 * 写回执落到哪一态。`ok` 不是判据:中心接受了一次写,和这次写已经在 canonical 可见,
 * 是两件事;界面把它们合成一句「成功」,人就分不清「已生效」与「已接受、还没到」。
 * 这里的回执形状逐字取自 daemon 的三条产出:`artifact-entity-action.ts` 的 proof、
 * `repo-cell-settlement.ts` 的 `rejected(opId, code)`、以及授权面补上的 rejectionExplanation。
 */
describe("an entity write receipt states which state it settled in", () => {
  it("separates canonical visibility from acceptance", () => {
    expect(
      entityWriteSettlement({
        outcome: "applied",
        opId: "entity-update-ADR-0001-4",
        proof: { durable: true, canonicalVisible: true, worktreeVisible: true },
      }),
    ).toMatchObject({ state: "applied" });
    const pending = entityWriteSettlement({
      outcome: "applied",
      opId: "entity-update-ADR-0001-4",
      proof: { durable: true, canonicalVisible: false, worktreeVisible: true },
    });
    expect(pending.state).toBe("pending");
    expect(pending.text).toContain("entity-update-ADR-0001-4");
    expect(entityWriteSettlement({ outcome: "no_changes", opId: "N/A" })).toMatchObject({ state: "applied" });
    expect(entityWriteSettlement({ outcome: "pending", opId: "op-1" }).state).toBe("pending");
  });

  it("tells a stale fence apart from a refusal, in the center's own words", () => {
    const conflict = entityWriteSettlement({
      outcome: "op_rejected",
      opId: "entity-update-ADR-0001-4",
      code: "revision_conflict",
      rejectionExplanation: "Entity ADR-0001 expected revision 4, current revision is 5.",
    });
    expect(conflict.state).toBe("conflict");
    expect(conflict.text).toContain("current revision is 5");
    expect(conflict.text).toContain("重新读取");
    const rejected = entityWriteSettlement({
      outcome: "op_rejected",
      opId: "entity-update-ADR-0001-4",
      code: "invalid_command",
      rejectionExplanation: 'artifact descriptor field "attributes" is missing required field "region"',
    });
    expect(rejected.state).toBe("rejected");
    expect(rejected.text).toContain("region");
  });

  it("treats an unanswered write as indeterminate rather than as a refusal", () => {
    // 连接断在回答之前:中心做没做,这一侧说不出来。说成「被拒」,人会照着「没写进去」重发。
    const unanswered = entityWriteSettlement({
      outcome: "op_rejected",
      opId: "N/A",
      code: "daemon_closed",
      rejectionExplanation: "Local daemon request failed. Cause: daemon closed before JSON-RPC response 12",
    });
    expect(unanswered.state).toBe("pending");
    expect(unanswered.text).toContain("daemon_closed");
    expect(unanswered.text).toContain("不要直接重发");
    expect(entityWriteSettlement({ outcome: "op_rejected", code: "daemon_response_timeout" }).state).toBe("pending");
    // 中心真的答了「拒」的那一类不受影响。
    expect(entityWriteSettlement({ outcome: "op_rejected", code: "invalid_command" }).state).toBe("rejected");
  });

  it("names only the fields the center actually moved under the draft", () => {
    const diverged = divergedFields(
      { title: "我的标题", region: "north", fiscalYear: "2099", reviewed: "true" },
      { title: "我的标题", region: "south", fiscalYear: "2026", reviewed: "true" },
    );
    expect(diverged.map(({ name }) => name)).toEqual(["region", "fiscalYear"]);
    expect(diverged[0]).toMatchObject({ name: "region", held: "south", draft: "north" });
    // 草稿里有、而这一版声明里没有的名字不进对照表:它属于别的版本,拿不出「中心现在的值」。
    expect(divergedFields({ retired: "x" }, {})).toEqual([]);
  });
});
