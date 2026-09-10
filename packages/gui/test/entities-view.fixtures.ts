// harness-test-tier: integration
import { expect, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHash } from "node:crypto";
import { EntitiesView } from "../src/renderer/views/EntitiesView.tsx";
import { VerticalKindForm } from "../src/renderer/components/entityDoc/VerticalKindForm.tsx";
import { sourceIdentityOf } from "../src/renderer/entity-import-preview.ts";
import type { ArtifactKindDeclaration } from "../src/renderer/vertical-kind-client.ts";
import type { ViewId } from "../src/renderer/navigation/viewHistory.ts";

/**
 * `entities-view.vitest.ts` 这一条测试自己的素材与挂载脚手架。
 *
 * 拆出来是因为那个文件已经长到测试文件的行数上限之上,而它里面是两件事:一件是「界面上
 * 做了什么、看到了什么」,另一件是「这一屏的读面回什么、写面收到什么」。后者在这里:
 * 声明行、实体行、桥接桩、挂载与一拍宏任务的等待,以及三张表单各自的输入小工具。
 * 判据留在测试文件里,这样读那边一眼就是行为,不是一半的桩。
 */

export const REPO_ID = "repo-entities";
export const noop = () => undefined;
export const mounted: { root: Root; container: HTMLElement }[] = [];

/** 声明 kind 的稳定身份:目录与行的 kind 名都是它,不带任何版本段。 */
export const ADR_KIND_ID = "KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94";
export const ADR_KIND = `entity-kind/${ADR_KIND_ID}`;

export function declaredAdrKindRow(overrides: Record<string, unknown> = {}) {
  return {
    kind: ADR_KIND,
    origin: "vertical",
    verticalId: "software/coding",
    refTemplate: `${ADR_KIND}/{id}`,
    relationEndpoint: true,
    importable: true,
    declaration: {
      id: "architecture-decision-record",
      kindId: ADR_KIND_ID,
      schemaVersions: [1],
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

/**
 * `repo.vertical.declaration.read` 里的已接受 kind 行:比目录 declaration 多存 fence
 * (row.revision,本 Kind 自己的接受版本)与 schemaVersions 的完整正文。
 */
export function acceptedAdrKindRow(overrides: Record<string, unknown> = {}) {
  const declaration = declaredAdrKindRow().declaration;
  return {
    id: declaration.id,
    entityType: "artifact",
    kindId: ADR_KIND_ID,
    revision: 4,
    schemaVersions: [{ version: 1, attributes: {} }],
    idPrefix: declaration.idPrefix,
    display: declaration.display,
    descriptorSchemaRef: declaration.descriptorSchemaRef,
    store: { pathTemplate: declaration.pathTemplate },
    locatorKinds: declaration.locatorKinds,
    maturityVocabulary: declaration.maturityVocabulary,
    ...overrides,
  };
}

export function governedRow(
  entityId: string,
  title: string | null = null,
  overrides: {
    readonly locator?: string;
    readonly revision?: number;
    readonly archived?: boolean;
    /** 这一条自己说出来的描述符事实:钉住的那一版,以及它按那一版填的值。 */
    readonly descriptor?: {
      readonly kindVersion: number;
      readonly attributes: Record<string, string | number | boolean>;
    } | null;
  } = {},
) {
  return {
    kind: ADR_KIND,
    entityId,
    ref: `${ADR_KIND}/${entityId}`,
    title,
    locator: { kind: "repository-path", value: overrides.locator ?? `docs/adr/${entityId}.md` },
    revision: overrides.revision ?? 0,
    descriptor: overrides.descriptor === undefined ? { kindVersion: 1, attributes: {} } : overrides.descriptor,
    ...(overrides.archived === undefined ? {} : { archived: overrides.archived }),
  };
}

export function stubBridge(
  domainTypes: ReadonlyArray<{ readonly domainType: string; readonly registeredByFactId: string }> = [],
  extras: {
    /** 已注册 kind 读面回包里的 kinds(声明实体详情布局用)。 */
    readonly kinds?: readonly unknown[];
    /** 声明实体行读面回包里的 rows。 */
    readonly rows?: readonly unknown[];
    /** `repo.vertical.declaration.read` 回包里的已接受 kind 行(默认 ADR 一条,revision 4)。 */
    readonly declarationKinds?: readonly unknown[];
  } = {},
) {
  const calls = { relationGraph: 0, upserts: [] as object[], publishes: [] as object[], retires: [] as object[] };
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
        declaration: { entityKinds: extras.declarationKinds ?? [acceptedAdrKindRow()] },
      })),
      upsertVerticalKind: vi.fn(async (payload: object) => {
        calls.upserts.push(payload);
        return { schema: "command-receipt/v2", ok: true, command: "vertical.kind.upsert", outcome: "applied" };
      }),
      publishVerticalKindSchema: vi.fn(async (payload: object) => {
        calls.publishes.push(payload);
        return { schema: "command-receipt/v2", ok: true, command: "vertical.kind.publishSchema", outcome: "applied" };
      }),
      retireVerticalKind: vi.fn(async (payload: object) => {
        calls.retires.push(payload);
        return { schema: "command-receipt/v2", ok: true, command: "vertical.kind.retire", outcome: "applied" };
      }),
      readEntityLocator: vi.fn(async ({ locatorValue }: { readonly locatorValue: string }) => ({
        schema: "entity-locator-read/v1",
        outcome: "file",
        path: locatorValue,
        content: `# ${locatorValue}\n\n这条正文来自 locator 读面。`,
        sizeBytes: 48,
        entries: [],
        truncated: false,
      })),
      // 收管内容读面:实体身份寻址,`repositoryPath` 已由读面按**配置的** authored root 算好。
      // 这里刻意用 `ledger/` 而不是默认的 `harness/`——渲染层要是自己拼前缀,断言立刻会红。
      readEntityContent: vi.fn(async ({ entityId, path }: { readonly entityId: string; readonly path?: string }) =>
        path === undefined
          ? {
              schema: "entity-content-read/v1",
              ok: true,
              outcome: "directory",
              entityRef: `${ADR_KIND}/${entityId}`,
              path: "",
              repositoryPath: `ledger/entities/adrs/${entityId}`,
              content: null,
              sizeBytes: null,
              mediaType: null,
              entries: [{ path: `${entityId}.md`, directory: false, sizeBytes: 42 }],
              truncated: false,
            }
          : {
              schema: "entity-content-read/v1",
              ok: true,
              outcome: "file",
              entityRef: `${ADR_KIND}/${entityId}`,
              path,
              repositoryPath: `ledger/entities/adrs/${entityId}/${path}`,
              content: `# ${entityId}\n\n这份正文归实体所有。`,
              sizeBytes: 42,
              mediaType: "text/markdown",
              entries: [],
              truncated: false,
            },
      ),
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

export async function renderSurface(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
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
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export function view(
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

export const FILE_CONTENT: Readonly<Record<string, string>> = {
  "docs/adr/ADR-0001.md": "# ADR-0001 · 探针\n\n这条正文来自 locator 读面。",
  "docs/adr/ADR-0002.md": "# ADR-0002 · 复核\n\n第二条正文。",
  "docs/adr/ADR-0003.md": "# 新导入的研究\n\n导入后的正文。",
  "docs/adr/research/README.md": "# 研究包说明\n\n目录正文。",
  "docs/adr/research/notes.md": "# 笔记\n\n目录里的文件。",
};

export const DIRECTORY_ENTRIES: Readonly<Record<string, ReadonlyArray<{ path: string; directory: boolean }>>> = {
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

/**
 * The center mints the instance identity when it accepts the import; nothing about the path predicts it.
 * The fixture therefore invents one the way the center would and hands it back in the receipt, which is
 * the only place the renderer can learn it.
 */
function mintedId(path: string): string {
  return `ADR-${createHash("sha256")
    .update(`minted:${sourceIdentityOf(REPO_ID, path)}`)
    .digest("hex")
    .slice(0, 32)}`;
}

export interface CrudBridgeState {
  rows: ReturnType<typeof governedRow>[];
  locatorCalls: string[];
  contentCalls: string[];
  imports: unknown[];
  updates: unknown[];
  archives: unknown[];
  deletes: unknown[];
}

/**
 * 一次被接受的导入把来源收进实体自己的内容里。fixture 因此按 locator 镜像出那份内容:
 * 文件来源 → 一个同名文件;目录来源 → 那一层(含子目录)。实体内相对路径,不带仓内前缀
 * ——前缀是读面的事。
 */
export function ownedContentOf(locator: string): Record<string, string | null> {
  const listing = DIRECTORY_ENTRIES[locator];
  if (listing !== undefined) {
    const owned: Record<string, string | null> = {};
    for (const { path, directory } of listing) {
      owned[path.slice(locator.length + 1)] = directory ? null : (FILE_CONTENT[path] ?? "");
      if (directory)
        for (const child of DIRECTORY_ENTRIES[path] ?? [])
          owned[child.path.slice(locator.length + 1)] = FILE_CONTENT[child.path] ?? "";
    }
    return owned;
  }
  const name = locator.split("/").at(-1) ?? locator;
  return { [name]: FILE_CONTENT[locator] ?? `# ${name}\n\n收进实体的正文。` };
}

export function crudRow(entityId: string, locator: string): ReturnType<typeof governedRow> {
  return governedRow(entityId, null, { locator, revision: 4 });
}

export function stubCrudBridge(
  initialRows: ReturnType<typeof governedRow>[] = [],
  declarationKinds: readonly unknown[] = [],
): CrudBridgeState {
  const state: CrudBridgeState = {
    rows: [...initialRows],
    locatorCalls: [],
    contentCalls: [],
    imports: [],
    updates: [],
    archives: [],
    deletes: [],
  };
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
        declaration: { entityKinds: declarationKinds },
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
      readEntityContent: vi.fn(async ({ entityId, path }: { readonly entityId: string; readonly path?: string }) => {
        state.contentCalls.push(`${entityId}:${path ?? ""}`);
        const row = state.rows.find((candidate) => candidate.entityId === entityId);
        const owned = row?.locator ? ownedContentOf(row.locator.value) : {};
        const at = path ?? "";
        // authored root 是可配置的,读面把位置算好交出来;这里刻意不是默认的 `harness/`。
        const root = `ledger/entities/adrs/${entityId}`;
        const envelope = (extra: Record<string, unknown>) => ({
          schema: "entity-content-read/v1",
          ok: true,
          entityRef: `${ADR_KIND}/${entityId}`,
          path: at,
          repositoryPath: at === "" ? root : `${root}/${at}`,
          content: null,
          sizeBytes: null,
          mediaType: null,
          entries: [],
          truncated: false,
          ...extra,
        });
        const body = owned[at];
        if (at !== "" && typeof body === "string")
          return at.endsWith(".pdf")
            ? envelope({ outcome: "binary", sizeBytes: body.length, mediaType: "application/pdf" })
            : envelope({ outcome: "file", content: body, sizeBytes: body.length, mediaType: "text/markdown" });
        if (at === "" || body === null) {
          const prefix = at === "" ? "" : `${at}/`;
          return envelope({
            outcome: "directory",
            entries: Object.entries(owned)
              .filter(([held]) => held.startsWith(prefix) && !held.slice(prefix.length).includes("/"))
              .map(([held, value]) => ({
                path: held,
                directory: value === null,
                sizeBytes: value === null ? null : value.length,
              })),
          });
        }
        return envelope({ outcome: "missing" });
      }),
      importEntity: vi.fn(async (payload: object) => {
        state.imports.push(payload);
        const locator = (payload as { locator: string }).locator;
        state.rows.push(crudRow(mintedId(locator), locator));
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "entity.import",
          outcome: "applied",
          opId: "op-import-1",
          // 与 daemon 的 import 回执同形:实例身份在回执顶层,evidence 是同一份 preview 的证据副本。
          entityId: mintedId(locator),
          evidence: JSON.stringify({ preview: { entityId: mintedId(locator) } }),
        };
      }),
      updateEntity: vi.fn(async (payload: object) => {
        state.updates.push(payload);
        // 被接受的那一次写落进行里:下一次读因此读到的是账本,不是表单的本地回声。
        const input = payload as {
          entityId: string;
          title?: string;
          locator?: string;
          attributes?: Record<string, string | number | boolean>;
        };
        state.rows = state.rows.map((row) =>
          row.entityId !== input.entityId
            ? row
            : {
                ...row,
                title: input.title ?? row.title,
                locator: input.locator ? { kind: "repository-path", value: input.locator } : row.locator,
                revision: row.revision + 1,
                descriptor:
                  row.descriptor === null || input.attributes === undefined
                    ? row.descriptor
                    : { ...row.descriptor, attributes: input.attributes },
              },
        );
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "entity.update",
          outcome: "applied",
          opId: "op-update-1",
          proof: { durable: true, canonicalVisible: true, worktreeVisible: true },
        };
      }),
      archiveEntity: vi.fn(async (payload: object) => {
        state.archives.push(payload);
        const { entityId } = payload as { entityId: string };
        // 归档留下这一行,只把它标成已归档——删除才把它取走。
        state.rows = state.rows.map((row) => (row.entityId === entityId ? { ...row, archived: true } : row));
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "entity.archive",
          outcome: "applied",
          opId: "op-archive-1",
          proof: { durable: true, canonicalVisible: true, worktreeVisible: false },
        };
      }),
      deleteEntity: vi.fn(async (payload: object) => {
        state.deletes.push(payload);
        const { entityId } = payload as { entityId: string };
        state.rows = state.rows.filter((row) => row.entityId !== entityId);
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "entity.delete",
          outcome: "applied",
          opId: "op-delete-1",
          proof: { durable: true, canonicalVisible: true, worktreeVisible: true },
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

export async function renderCrudView(focusedRef: string | null): Promise<HTMLElement> {
  const container = await renderSurface(view(focusedRef));
  await settle();
  return container;
}

export async function click(container: HTMLElement, testId: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button, testId).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  await settle();
}

/** 两版属性声明:v2 换了必填项,也换了取值形态。新建的实例钉的是 v2。 */
export const PINNED_SCHEMA_VERSIONS = [
  { version: 1, attributes: { legacyOwner: { type: "string", required: true } } },
  {
    version: 2,
    attributes: {
      region: { type: "string", enum: ["north", "south"], required: true },
      fiscalYear: { type: "integer", required: true },
      reviewed: { type: "boolean" },
    },
  },
];

export async function pickOption(container: HTMLElement, label: string, value: string): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(select, label).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select!, value);
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export async function toggle(container: HTMLElement, label: string): Promise<void> {
  const box = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(box, label).not.toBeNull();
  await act(async () => {
    box!.click();
  });
}

export const KIND_FORM_INITIAL: ArtifactKindDeclaration = {
  id: "architecture-decision-record",
  entityType: "artifact",
  kindId: ADR_KIND_ID,
  revision: 4,
  schemaVersions: [{ version: 1, attributes: {} }],
  idPrefix: "ADR",
  display: { singular: "Architecture Decision Record", plural: "Architecture Decision Records" },
  descriptorSchemaRef: "schema://artifact-descriptor",
  store: { pathTemplate: "entities/adrs/{id}.json" },
  locatorKinds: ["repository-path"],
  maturityVocabulary: ["draft", "accepted"],
};

export async function renderKindForm(initial?: ArtifactKindDeclaration): Promise<HTMLElement> {
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

export async function typeInto(container: HTMLElement, label: string, text: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input, label).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input!, text);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function typeTextarea(container: HTMLElement, label: string, text: string): Promise<void> {
  const area = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
  expect(area, label).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(area!, text);
    area!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
