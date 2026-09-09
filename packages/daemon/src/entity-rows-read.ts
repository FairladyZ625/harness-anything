import { isJsonObject } from "./protocol/json-rpc-types.ts";
import { consumeKnownError, type EntityKindCatalogV1, type TaskProjection } from "../../kernel/src/index.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";

/**
 * 已声明实体的行读面(task_0df76ed3fb 设计页 §3)。
 *
 * 内建 kind 各有自己的读面(task/decision/fact/agent/schedule);vertical 声明出来的
 * Artifact kind 没有——GUI 要把它们当普通节点渲染,就需要一条能按已注册 kind 取行的读。
 * 本读面遍历 catalog 里 `origin: "vertical"` 的 kind,取投影行,不新造第二份 kind 清单。
 */
export const ENTITY_ROW_LIST_SCHEMA = "entity-row-list/v1" as const;

export class EntityRowListContractError extends Error {
  readonly code = "invalid_result";
  constructor(message: string) {
    super(message);
    this.name = "EntityRowListContractError";
  }
}

/**
 * 一条 Artifact 实例自己说出来的描述符事实。
 *
 * `kindVersion` 是这个实例被接受时**钉住**的那一版 kind 属性声明——kind 之后发布了多少
 * 新版本都不改它;`attributes` 是它按那一版填出来的值。两者一起,调用方才说得出「这一条
 * 该按哪一版读、它现在填的是什么」,不必替它猜一版。
 */
export interface EntityRowDescriptorV1 {
  readonly kindVersion: number;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface EntityRowV1 {
  readonly kind: string;
  readonly entityId: string;
  /** canonical ref:`<kind>/<entityId>`,与关系图端点同形。 */
  readonly ref: string;
  readonly title: string | null;
  readonly locator: { readonly kind: string; readonly value: string } | null;
  readonly revision: number;
  readonly archived: boolean;
  /**
   * 这一行的描述符事实;**不是 Artifact 描述符的行为 `null`**。runtime instance 就是这样一条:
   * 它是 provider 的节点配置,从来没有 kind 属性声明可钉,给它编一版号与一张空属性表,
   * 调用方会当真去按那一版填。
   */
  readonly descriptor: EntityRowDescriptorV1 | null;
}

export interface EntityRowListV1 {
  readonly schema: typeof ENTITY_ROW_LIST_SCHEMA;
  readonly ok: true;
  readonly rows: readonly EntityRowV1[];
}

export function readDeclaredEntityRows(input: {
  readonly catalog: EntityKindCatalogV1;
  readonly projection: Pick<TaskProjection, "listEntities">;
  readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
}): EntityRowListV1 {
  const rows: EntityRowV1[] = [];
  for (const { kind, origin } of input.catalog.kinds) {
    if (origin !== "vertical") continue;
    for (const row of input.projection.listEntities(kind)) rows.push(entityRow(kind, row));
  }
  let runtimeInstances: readonly RuntimeInstanceSummary[] = [];
  try {
    runtimeInstances = input.runtimeInstances?.() ?? [];
  } catch (error) {
    consumeKnownError(error);
  }
  for (const instance of runtimeInstances) {
    rows.push({
      kind: "runtime-instance",
      entityId: instance.instanceId,
      ref: `runtime-instance/${instance.instanceId}`,
      title: instance.name,
      locator: { kind: "entity-ref", value: `provider/${instance.instanceId}` },
      revision: 0,
      archived: false,
      descriptor: null,
    });
  }
  return { schema: ENTITY_ROW_LIST_SCHEMA, ok: true, rows };
}

function entityRow(
  kind: string,
  row: {
    readonly id: string;
    readonly workspaceRevision: number;
    readonly freshness: string;
    readonly value: unknown;
  },
): EntityRowV1 {
  const descriptor = isJsonObject(row.value) ? row.value : {};
  const locator = descriptor.locator;
  return {
    kind,
    entityId: row.id,
    ref: `${kind}/${row.id}`,
    title: typeof descriptor.title === "string" ? descriptor.title : null,
    locator:
      isJsonObject(locator) && typeof locator.kind === "string" && typeof locator.value === "string"
        ? { kind: locator.kind, value: locator.value }
        : null,
    revision: row.workspaceRevision,
    archived: row.freshness === "orphaned",
    descriptor: descriptorFacts(descriptor),
  };
}

/**
 * 投影里的值 → 描述符事实,读不出来就是 `null`。
 *
 * 判定是**总的**:一行读不出这两个事实不该让整张清单读失败,所以这里不走 kernel 那个
 * 会抛的描述符解码器。要求 `kindVersion` 是一个真的版本号,`attributes` 的每个值都是描述符
 * 契约允许的纯量——认不出的形状一律不进事实,而不是被塞成一个看得懂的默认值。
 */
function descriptorFacts(descriptor: Readonly<Record<string, unknown>>): EntityRowDescriptorV1 | null {
  const attributes = descriptor.attributes;
  if (!Number.isSafeInteger(descriptor.kindVersion) || Number(descriptor.kindVersion) < 1) return null;
  if (!isJsonObject(attributes) || !Object.values(attributes).every(isAttributeValue)) return null;
  return { kindVersion: Number(descriptor.kindVersion), attributes: attributes as EntityRowDescriptorV1["attributes"] };
}

function isAttributeValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function validateEntityRowList(value: unknown): readonly string[] {
  if (
    !isJsonObject(value) ||
    value.schema !== ENTITY_ROW_LIST_SCHEMA ||
    value.ok !== true ||
    !Array.isArray(value.rows)
  )
    return ["Entity row list envelope is invalid"];
  const errors: string[] = [];
  for (const [index, row] of value.rows.entries())
    errors.push(...validateRow(row).map((issue) => `rows[${index}]: ${issue}`));
  return errors;
}

function validateRow(value: unknown): readonly string[] {
  if (!isJsonObject(value)) return ["row must be an object"];
  const errors: string[] = [];
  for (const field of ["kind", "entityId", "ref"])
    if (typeof value[field] !== "string" || !value[field]) errors.push(`${field} must be a non-empty string`);
  if (value.ref !== `${String(value.kind)}/${String(value.entityId)}`) errors.push("ref must be <kind>/<entityId>");
  if (value.title !== null && typeof value.title !== "string") errors.push("title must be a string or null");
  if (value.locator !== null && !isJsonObject(value.locator)) errors.push("locator must be an object or null");
  else if (
    isJsonObject(value.locator) &&
    (typeof value.locator.kind !== "string" || typeof value.locator.value !== "string")
  )
    errors.push("locator must carry kind and value");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0)
    errors.push("revision must be a non-negative integer");
  if (typeof value.archived !== "boolean") errors.push("archived must be a boolean");
  errors.push(...validateDescriptor(value.descriptor));
  return errors;
}

function validateDescriptor(value: unknown): readonly string[] {
  // `null` 是一个明确的事实(这一行不是 Artifact 描述符),而字段整个缺席不是。
  if (value === null) return [];
  if (!isJsonObject(value)) return ["descriptor must be an object or null"];
  const errors: string[] = [];
  if (!Number.isSafeInteger(value.kindVersion) || Number(value.kindVersion) < 1)
    errors.push("descriptor.kindVersion must be a positive integer");
  if (!isJsonObject(value.attributes)) errors.push("descriptor.attributes must be an object");
  else if (!Object.values(value.attributes).every(isAttributeValue))
    errors.push("descriptor.attributes values must be string, number or boolean");
  return errors;
}

export function serializeEntityRowList(value: unknown): string {
  const errors = validateEntityRowList(value);
  if (errors.length) throw new EntityRowListContractError(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}
