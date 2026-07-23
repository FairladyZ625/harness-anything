import type {
  ActorAxesBindingOperationConsumeInputV2,
  ActorAxesBindingOperationConsumeResultV2,
  ActorAxesBindingRecordV2
} from "@harness-anything/application";
import { stableStringify } from "@harness-anything/kernel";
import type { DurableAuthorityStateTable } from "./service-state.ts";

const bindingStateSchema = "authority-binding-state/v2" as const;
const legacyBindingStateSchema = "authority-binding-state/v1" as const;

interface DurableBindingRowV2 {
  readonly schema: typeof bindingStateSchema;
  readonly tokenId: string;
  readonly tokenDigest: string;
  readonly maxOperations: number;
  readonly consumedOperations: number;
  readonly consumedOperationIds: ReadonlyArray<string>;
  readonly record: ActorAxesBindingRecordV2;
}

interface LegacyDurableBindingRowV1 {
  readonly schema: typeof legacyBindingStateSchema;
  readonly tokenId: string;
  readonly tokenDigest: string;
  readonly maxOperations: number;
  readonly consumedOperations: number;
  readonly record: ActorAxesBindingRecordV2;
}

export function recoverAuthorityBindingRows(
  table: DurableAuthorityStateTable
): void {
  const unconsumedLegacyRows: Array<readonly [string, LegacyDurableBindingRowV1]> = [];
  for (const [key, value] of table.entries<unknown>()) {
    if (validBindingRow(value)) {
      if (key !== bindingKey(value.tokenId)) {
        throw new Error("AUTHORITY_BINDING_DURABLE_MISMATCH");
      }
      continue;
    }
    if (!validLegacyBindingRow(value) || key !== bindingKey(value.tokenId)) {
      throw new Error("AUTHORITY_BINDING_DURABLE_MISMATCH");
    }
    if (value.consumedOperations > 0) {
      throw new Error(
        `AUTHORITY_BINDING_LEGACY_CONSUMPTION_WITNESS_REQUIRED:${value.tokenId}:${value.consumedOperations}`
      );
    }
    unconsumedLegacyRows.push([key, value]);
  }
  for (const [key, row] of unconsumedLegacyRows) {
    table.put(key, {
      ...row,
      schema: bindingStateSchema,
      consumedOperationIds: []
    } satisfies DurableBindingRowV2);
  }
}

export function registerAuthorityBindingRow(
  table: DurableAuthorityStateTable,
  input: {
    readonly tokenId: string;
    readonly tokenDigest: Uint8Array;
    readonly maxOperations: number;
    readonly record: ActorAxesBindingRecordV2;
  }
): void {
  ensureBindingRow(table, bindingRow({
    ...input,
    consumedOperations: 0,
    consumedOperationIds: []
  }));
}

export function authorityBindingRecord(
  table: DurableAuthorityStateTable,
  bindingId: string
): ActorAxesBindingRecordV2 | undefined {
  return table.entries<unknown>()
    .map(([, row]) => row)
    .filter(validBindingRow)
    .find((row) => row.record.bindingId === bindingId)?.record;
}

export function consumeAuthorityBindingOperation(
  table: DurableAuthorityStateTable,
  input: ActorAxesBindingOperationConsumeInputV2
): ActorAxesBindingOperationConsumeResultV2 {
  const { tokenId, maximum, opId } = input;
  if (!isRequiredText(tokenId) || !isRequiredText(opId)
    || !Number.isSafeInteger(maximum) || maximum < 1) return "denied";
  const row = table.get<unknown>(bindingKey(tokenId));
  if (!validBindingRow(row) || maximum !== row.maxOperations || !row.record.active) {
    return "denied";
  }
  if (row.consumedOperationIds.includes(opId)) return "already-consumed-by-same-op";
  if (row.consumedOperations >= row.maxOperations) return "denied";
  ensureBindingRow(table, {
    ...row,
    consumedOperations: row.consumedOperations + 1,
    consumedOperationIds: [...row.consumedOperationIds, opId]
  }, true);
  return "consumed";
}

export function authorityBindingTokenMatches(
  table: DurableAuthorityStateTable,
  input: {
    readonly bindingId: string;
    readonly tokenId: string;
    readonly tokenDigest: Uint8Array;
  }
): boolean {
  const row = table.get<unknown>(bindingKey(input.tokenId));
  return validBindingRow(row) && row.record.active
    && row.record.bindingId === input.bindingId
    && row.tokenDigest === Buffer.from(input.tokenDigest).toString("base64url");
}

function bindingRow(
  input: Omit<DurableBindingRowV2, "schema" | "tokenDigest"> & {
    readonly tokenDigest: Uint8Array;
  }
): DurableBindingRowV2 {
  return {
    schema: bindingStateSchema,
    tokenId: requiredText(input.tokenId, "tokenId"),
    tokenDigest: digest32(input.tokenDigest, "tokenDigest"),
    maxOperations: requiredPositiveInteger(input.maxOperations, "maxOperations"),
    consumedOperations: nonNegativeInteger(
      input.consumedOperations,
      "consumedOperations"
    ),
    consumedOperationIds: input.consumedOperationIds.map(
      (opId) => requiredText(opId, "consumedOperationIds")
    ),
    record: input.record
  };
}

function ensureBindingRow(
  table: DurableAuthorityStateTable,
  row: DurableBindingRowV2,
  replace = false
): void {
  const key = bindingKey(row.tokenId);
  const existing = table.get<unknown>(key);
  if (existing && !replace) {
    if ((validBindingRow(existing) || validLegacyBindingRow(existing))
      && sameBindingRegistration(existing, row)) return;
    throw new Error("AUTHORITY_BINDING_DURABLE_MISMATCH");
  }
  if (!existing || replace) table.put(key, row);
}

function validBindingRow(value: unknown): value is DurableBindingRowV2 {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<DurableBindingRowV2>;
  return row.schema === bindingStateSchema && isRequiredText(row.tokenId)
    && canonicalDigest32(row.tokenDigest)
    && Number.isSafeInteger(row.maxOperations) && Number(row.maxOperations) >= 1
    && Number.isSafeInteger(row.consumedOperations) && Number(row.consumedOperations) >= 0
    && Number(row.consumedOperations) <= Number(row.maxOperations)
    && Array.isArray(row.consumedOperationIds)
    && row.consumedOperationIds.length === row.consumedOperations
    && row.consumedOperationIds.length <= Number(row.maxOperations)
    && new Set(row.consumedOperationIds).size === row.consumedOperationIds.length
    && row.consumedOperationIds.every(isRequiredText)
    && validBindingRecord(row.record);
}

function validLegacyBindingRow(value: unknown): value is LegacyDurableBindingRowV1 {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<LegacyDurableBindingRowV1>;
  return row.schema === legacyBindingStateSchema && isRequiredText(row.tokenId)
    && canonicalDigest32(row.tokenDigest)
    && Number.isSafeInteger(row.maxOperations) && Number(row.maxOperations) >= 1
    && Number.isSafeInteger(row.consumedOperations) && Number(row.consumedOperations) >= 0
    && Number(row.consumedOperations) <= Number(row.maxOperations)
    && validBindingRecord(row.record);
}

function sameBindingRegistration(
  left: DurableBindingRowV2 | LegacyDurableBindingRowV1,
  right: DurableBindingRowV2
): boolean {
  return left.tokenId === right.tokenId
    && left.tokenDigest === right.tokenDigest
    && left.maxOperations === right.maxOperations
    && stableStringify(left.record) === stableStringify(right.record);
}

function canonicalDigest32(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === value;
}

function validBindingRecord(value: unknown): value is ActorAxesBindingRecordV2 {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ActorAxesBindingRecordV2>;
  if (!isRequiredText(record.bindingId)
    || !isRequiredText(record.principalPersonId)
    || (record.executorAgentId !== null && !isRequiredText(record.executorAgentId))
    || !isRequiredText(record.workspaceId)
    || !isRequiredText(record.deviceId)
    || !isRequiredText(record.viewId)
    || !isRequiredText(record.sessionId)
    || typeof record.active !== "boolean"
    || !record.attribution || typeof record.attribution !== "object") return false;
  const attribution = record.attribution as Record<string, unknown>;
  const actor = attribution.actor;
  if (!actor || typeof actor !== "object") return false;
  const principal = (actor as Record<string, unknown>).principal;
  const executor = (actor as Record<string, unknown>).executor;
  if (!principal || typeof principal !== "object"
    || (principal as Record<string, unknown>).kind !== "person"
    || (principal as Record<string, unknown>).personId !== record.principalPersonId) return false;
  if (record.executorAgentId === null) {
    if (executor !== null || attribution.executorSource !== "none") return false;
  } else if (!executor || typeof executor !== "object"
    || (executor as Record<string, unknown>).kind !== "agent"
    || (executor as Record<string, unknown>).id !== record.executorAgentId
    || attribution.executorSource !== "client-asserted") return false;
  return validPrincipalSource(attribution.principalSource);
}

function validPrincipalSource(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  if (source.kind === "daemon-authenticated") {
    return isRequiredText(source.providerId) && isRequiredText(source.credentialFingerprint);
  }
  if (source.kind === "local-configured") {
    return (source.authority === "persons.yaml"
      || source.authority === "people.yaml-legacy"
      || source.authority === "harness.yaml")
      && isRequiredText(source.authoritySha256);
  }
  return source.kind === "migration" && isRequiredText(source.evidenceRef);
}

function bindingKey(tokenId: string): string {
  return `token:${requiredText(tokenId, "tokenId")}`;
}

function digest32(value: Uint8Array, name: string): string {
  if (value.byteLength !== 32) {
    throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  }
  return Buffer.from(value).toString("base64url");
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  }
  return Number(value);
}

function requiredText(value: unknown, name: string): string {
  if (!isRequiredText(value)) {
    throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  }
  return value;
}

function isRequiredText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.trim() === value && !value.includes("\0");
}
