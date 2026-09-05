import { isJsonObject } from "./protocol/json-rpc-types.ts";
import type { EntityKindCatalogV1, TaskProjection } from "../../kernel/src/index.ts";
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

export interface EntityRowV1 {
  readonly kind: string;
  readonly entityId: string;
  /** canonical ref:`<kind>/<entityId>`,与关系图端点同形。 */
  readonly ref: string;
  readonly title: string | null;
  readonly locator: { readonly kind: string; readonly value: string } | null;
  readonly revision: number;
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
  for (const instance of input.runtimeInstances?.() ?? []) {
    rows.push({
      kind: "runtime-instance",
      entityId: instance.instanceId,
      ref: `runtime-instance/${instance.instanceId}`,
      title: instance.name,
      locator: { kind: "entity-ref", value: `provider/${instance.instanceId}` },
      revision: 0,
    });
  }
  return { schema: ENTITY_ROW_LIST_SCHEMA, ok: true, rows };
}

function entityRow(
  kind: string,
  row: { readonly id: string; readonly workspaceRevision: number; readonly value: unknown },
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
  };
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
  return errors;
}

export function serializeEntityRowList(value: unknown): string {
  const errors = validateEntityRowList(value);
  if (errors.length) throw new EntityRowListContractError(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}
