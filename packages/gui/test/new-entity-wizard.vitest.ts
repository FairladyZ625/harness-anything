// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHash } from "node:crypto";
import { EntitiesView } from "../src/renderer/views/EntitiesView.tsx";
import { sourceIdentityOf } from "../src/renderer/entity-import-preview.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 新建向导 + 目录树 + 详情操作区的行为判据(task_a494eac2 Goal 1/2/4):
 *   - 向导从既有实体的公共父目录起步,浏览/选定/预览(推导 id 与 kernel 公式一致)后
 *     走 repo.entity.import(expectedVersion 恒 0,title 留空时不发);
 *   - 目录 locator 的树懒展开(展开才对子路径发读),点文件在内嵌查看器渲染;
 *   - 编辑/归档在详情操作区,列表行不再挂写动作。
 */

const REPO_ID = "repo-entities";
const ADR_KIND = "software/coding/architecture-decision-record@1";
const mounted: { root: Root; container: HTMLElement }[] = [];

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

function governedRow(entityId: string, locator: string, archived = false) {
  return {
    kind: ADR_KIND,
    entityId,
    ref: `${ADR_KIND}/${entityId}`,
    title: null,
    locator: { kind: "repository-path", value: locator },
    revision: 4,
    archived,
  };
}

function derivedId(path: string): string {
  return `ADR-${createHash("sha256").update(sourceIdentityOf(REPO_ID, path)).digest("hex").slice(0, 16)}`;
}

interface BridgeState {
  rows: ReturnType<typeof governedRow>[];
  locatorCalls: string[];
  imports: unknown[];
  updates: unknown[];
  archives: unknown[];
}

function stubBridge(initialRows: ReturnType<typeof governedRow>[] = []): BridgeState {
  const state: BridgeState = { rows: [...initialRows], locatorCalls: [], imports: [], updates: [], archives: [] };
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
        state.rows.push(governedRow(derivedId(locator), locator));
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

async function renderView(focusedRef: string | null): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(EntitiesView, {
          repoId: REPO_ID,
          focusedRef,
          onOpenEntityDoc: () => undefined,
          onOpenEntityRef: () => undefined,
          onExitDetail: () => undefined,
          onOpenView: () => undefined,
          projectName: "Probe",
        }),
      ),
    );
  });
  mounted.push({ root, container });
  await settle();
  return container;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
    stubBridge([governedRow("ADR-0001", "docs/adr/ADR-0001.md"), governedRow("ADR-0002", "docs/adr/ADR-0002.md")]);
    const container = await renderView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    expect(container.querySelector('[data-testid="new-entity-wizard"]')).not.toBeNull();
    // seed = 既有 locator 的最深公共父目录,不是手输,也不是仓根。
    expect(container.querySelector('[data-testid="repo-path-browser-location"]')?.textContent).toBe("docs/adr");
    expect(container.querySelector('[data-testid="new-entity-wizard-seed"]')).toBeNull();
  });

  it("asks for a seed only when no existing entity can suggest one", async () => {
    stubBridge();
    const container = await renderView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    expect(container.querySelector('[data-testid="new-entity-wizard-seed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="repo-path-browser"]')).toBeNull();
  });

  it("navigates directories, previews the derived title and id, then imports without a hand-written id", async () => {
    const state = stubBridge([governedRow("ADR-0001", "docs/adr/ADR-0001.md")]);
    const container = await renderView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    // 进入子目录:对子路径再发同一条目录读。
    await click(container, "repo-path-entry-docs/adr/research");
    expect(state.locatorCalls).toContain("docs/adr/research");
    expect(container.querySelector('[data-testid="repo-path-browser-location"]')?.textContent).toBe(
      "docs/adr/research",
    );
    // 选定文件:预览给出推导 title(文件首标题)与推导 id(kernel 公式)。
    await click(container, "repo-path-entry-docs/adr/research/notes.md");
    const preview = container.querySelector('[data-testid="new-entity-wizard-preview-area"]');
    expect(preview?.textContent).toContain("笔记");
    expect(preview?.textContent).toContain(derivedId("docs/adr/research/notes.md"));
    // 导入:expectedVersion 恒 0,title 留空就不发,人不填任何身份字段。
    await click(container, "new-entity-wizard-submit");
    expect(state.imports).toEqual([
      { repoId: REPO_ID, entityKind: ADR_KIND, locator: "docs/adr/research/notes.md", expectedVersion: 0 },
    ]);
    // 回执 applied 后:向导退出,行缓存刷新,新实体被选中并渲染正文。
    expect(container.querySelector('[data-testid="new-entity-wizard"]')).toBeNull();
    expect(container.querySelector('[data-testid="entity-locator-markdown"]')?.textContent).toContain("目录里的文件");
  });

  it("imports a directory target with the README heading as the derived title", async () => {
    const state = stubBridge([governedRow("ADR-0001", "docs/adr/ADR-0001.md")]);
    const container = await renderView(`entitydoc/${ADR_KIND}`);
    await click(container, "governed-entity-new");
    await click(container, "repo-path-entry-docs/adr/research");
    await click(container, "repo-path-browser-pick-directory");
    expect(container.querySelector('[data-testid="new-entity-wizard-preview-area"]')?.textContent).toContain(
      "研究包说明",
    );
    await click(container, "new-entity-wizard-submit");
    expect(state.imports).toEqual([
      { repoId: REPO_ID, entityKind: ADR_KIND, locator: "docs/adr/research", expectedVersion: 0 },
    ]);
  });
});

describe("directory locator browser (goal 2)", () => {
  it("lazily expands subdirectories and opens files in the inline viewer", async () => {
    const state = stubBridge([governedRow("ADR-0001", "docs/adr")]);
    const container = await renderView(`${ADR_KIND}/ADR-0001`);
    // 树根钉在实体目录:直接看到它的条目,不再是全路径分段的两级壳。
    const tree = container.querySelector('[data-testid="entity-locator-directory"]');
    expect(tree).not.toBeNull();
    expect(tree?.textContent).toContain("research/");
    expect(tree?.textContent).toContain("ADR-0002.md");
    // 未展开前不对子目录发读。
    expect(state.locatorCalls).not.toContain("docs/adr/research");
    await click(container, "entity-directory-node-docs/adr/research");
    expect(state.locatorCalls).toContain("docs/adr/research");
    // 点文件:内嵌查看器按渲染器选择表渲染 markdown。
    await click(container, "entity-directory-node-docs/adr/research/notes.md");
    expect(container.querySelector('[data-testid="entity-directory-file-markdown"]')?.textContent).toContain(
      "目录里的文件",
    );
  });

  it("shows the dedicated pdf card instead of pretending to render bytes", async () => {
    stubBridge([governedRow("ADR-0001", "docs/adr/ADR-0001.md")]);
    const container = await renderView(`${ADR_KIND}/ADR-0001`);
    expect(container.querySelector('[data-testid="entity-locator-pdf"]')).toBeNull();
    expect(container.querySelector('[data-testid="entity-locator-markdown"]')).not.toBeNull();
  });
});

describe("detail action area (goal 4)", () => {
  it("keeps edit and archive out of the list rows and acts on the selected entity", async () => {
    const state = stubBridge([governedRow("ADR-0001", "docs/adr/ADR-0001.md")]);
    const container = await renderView(`entitydoc/${ADR_KIND}`);
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
