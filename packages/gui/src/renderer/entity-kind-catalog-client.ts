import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import type { GovernedEntityRow } from "./graph/governedEntities.ts";

/**
 * GUI 里**唯一**的实体 kind 来源(task_0df76ed3fb 设计页 §1)。
 *
 * 内核内建 kind 与当前仓库 vertical 声明的 kind 是两套编译产物,但对 GUI 只有一个读面:
 * `repo.entity.kinds.read`。renderer 不能 import kernel,所以这里重述读面的**行形状**
 * (不是重述清单)——清单永远来自 daemon,声明一个新 kind 不需要改这里。
 */
export interface EntityKindDeclaration {
  readonly id: string;
  readonly version: number;
  readonly idPrefix: string;
  readonly display: { readonly singular: string; readonly plural: string };
  readonly descriptorSchemaRef: string;
  readonly pathTemplate: string;
  readonly locatorKinds: readonly string[];
  readonly maturityVocabulary: readonly string[];
}

export interface EntityKindActionInputField {
  readonly field: string;
  readonly type: string;
  readonly required: boolean;
}

export interface EntityKindAction {
  readonly id: string;
  readonly explain?: string;
  /** 动作的入参合同(kernel `EntityActionContract.input`),与 CLI 的 flag 表同一个值。 */
  readonly input?: { readonly schema: string; readonly fields: readonly EntityKindActionInputField[] };
}

export interface EntityKindSchemaField {
  readonly name: string;
  readonly type: string | readonly string[];
  readonly required: boolean;
  readonly description: string | null;
}

export interface EntityKindExplanation {
  readonly kind: string;
  readonly documentSchema: { readonly id: string; readonly fields: readonly EntityKindSchemaField[] };
  readonly relations: {
    readonly edges: readonly { readonly type: string; readonly sourceKind: string; readonly targetKind: string }[];
  };
  readonly statusVocabulary: readonly { readonly field: string; readonly words: readonly string[] }[];
  readonly transitions: { readonly available: readonly string[]; readonly actions: readonly EntityKindAction[] };
}

export interface EntityKindRow {
  readonly kind: string;
  readonly origin: "builtin" | "vertical";
  readonly verticalId: string | null;
  readonly refTemplate: string;
  readonly relationEndpoint: boolean;
  readonly importable: boolean;
  readonly declaration: EntityKindDeclaration | null;
  readonly explanation: EntityKindExplanation;
}

export interface EntityKindCatalog {
  readonly schema: "entity-kind-catalog/v1";
  readonly kinds: readonly EntityKindRow[];
}

type EntityKindBridge = {
  readonly readEntityKinds: (payload: { readonly repoId: string }) => Promise<unknown>;
};

const bridge = (): EntityKindBridge => {
  const value = window.harness as unknown as Partial<EntityKindBridge> | undefined;
  if (!value?.readEntityKinds) throw new Error("Entity kind catalog bridge is unavailable.");
  return value as EntityKindBridge;
};

export async function readEntityKindCatalog(repoId: string): Promise<EntityKindCatalog> {
  const value = await bridge().readEntityKinds({ repoId });
  if (!isRendererRecord(value) || value.schema !== "entity-kind-catalog/v1" || !Array.isArray(value.kinds))
    throw new Error(rendererErrorHint(value, "Entity kind catalog bridge returned an invalid result."));
  return value as unknown as EntityKindCatalog;
}

/** 空目录:读面尚未回来时的诚实占位,不预填任何 kind 名。 */
export const emptyEntityKindCatalog: EntityKindCatalog = Object.freeze({
  schema: "entity-kind-catalog/v1",
  kinds: Object.freeze([]),
});

/** 能作为图节点出现的 kind——领地/聚光灯/筛选面板的类型全集都取这一处。 */
export function graphNodeKinds(catalog: EntityKindCatalog): readonly string[] {
  return catalog.kinds.filter(({ relationEndpoint }) => relationEndpoint).map(({ kind }) => kind);
}

/** ref 前缀 → kind。vertical ref 是多段(`software/coding/x@1/ID`),所以按最长前缀先匹配。 */
export function kindRefPrefixes(catalog: EntityKindCatalog): readonly { kind: string; prefix: string }[] {
  return catalog.kinds
    .map(({ kind, refTemplate }) => ({ kind, prefix: refTemplate.slice(0, refTemplate.length - "{id}".length) }))
    .sort((left, right) => right.prefix.length - left.prefix.length);
}

/** locator 指针形的实体才有「新建」入口:唯一判据是读面上的可执行 import 动作。 */
export function importableKinds(catalog: EntityKindCatalog): readonly EntityKindRow[] {
  return catalog.kinds.filter(({ importable }) => importable);
}

export function entityKindLabel(row: EntityKindRow): string {
  return row.declaration?.display.singular ?? row.kind;
}

export function findEntityKind(catalog: EntityKindCatalog, kind: string): EntityKindRow | null {
  return catalog.kinds.find((row) => row.kind === kind) ?? null;
}

export interface EntityRowListResult {
  readonly schema: "entity-row-list/v1";
  readonly ok: true;
  readonly rows: readonly GovernedEntityRow[];
}

type EntityRowBridge = {
  readonly readEntityRows: (payload: { readonly repoId: string }) => Promise<unknown>;
};

/** 声明实体的行读面。内建 kind 各有自己的读,这条只服务 vertical 声明出来的 kind。 */
export async function readGovernedEntityRows(repoId: string): Promise<readonly GovernedEntityRow[]> {
  const value = window.harness as unknown as Partial<EntityRowBridge> | undefined;
  if (!value?.readEntityRows) throw new Error("Entity row bridge is unavailable.");
  const result = await value.readEntityRows({ repoId });
  if (!isRendererRecord(result) || result.schema !== "entity-row-list/v1" || !Array.isArray(result.rows))
    throw new Error(rendererErrorHint(result, "Entity row bridge returned an invalid result."));
  return result.rows as readonly GovernedEntityRow[];
}
