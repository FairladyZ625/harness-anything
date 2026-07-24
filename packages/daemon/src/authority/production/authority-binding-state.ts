import type {
  ActorAxesBindingOperationConsumeInputV2,
  ActorAxesBindingOperationConsumeResultV2,
  ActorAxesBindingRecordV2
} from "@harness-anything/application";
import { stableStringify } from "@harness-anything/kernel";
import type { DurableAuthorityStateTable } from "./service-state.ts";

const bindingStateSchema = "authority-binding-state/v2" as const;
const legacyBindingStateSchema = "authority-binding-state/v1" as const;
/**
 * Reserved witness prefix for consumption a v1 row counted but never named.
 * v1 stored only a count, so the identity of an already-spent operation cannot
 * be reconstructed. Recovery mints one reserved witness per counted operation:
 * the count-derived invariants (exhaustion, remaining capacity) carry over
 * exactly, and the witness text states on its face that no operation id was
 * ever observed. Callers may never present a reserved witness as an opId.
 */
const legacyUnwitnessedPrefix = "legacy-unwitnessed:" as const;

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
  const legacyRows: Array<readonly [string, LegacyDurableBindingRowV1]> = [];
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
    legacyRows.push([key, value]);
  }
  for (const [key, row] of legacyRows) {
    table.put(key, {
      ...row,
      schema: bindingStateSchema,
      consumedOperationIds: legacyUnwitnessedOperationIds(row)
    } satisfies DurableBindingRowV2);
  }
}

/** One reserved witness per operation a v1 row counted but never named. */
export function legacyUnwitnessedOperationIds(
  row: Pick<LegacyDurableBindingRowV1, "tokenId" | "consumedOperations">
): ReadonlyArray<string> {
  return Array.from(
    { length: row.consumedOperations },
    (_unused, index) => `${legacyUnwitnessedPrefix}${row.tokenId}:${index + 1}`
  );
}

function isLegacyUnwitnessedOperationId(opId: string): boolean {
  return opId.startsWith(legacyUnwitnessedPrefix);
}

export function registerAuthorityBindingRow(
  table: DurableAuthorityStateTable,
  input: {
    readonly tokenId: string;
    readonly tokenDigest: Uint8Array;
    readonly maxOperations: number;
    readonly record: ActorAxesBindingRecordV2;
  },
  allowActiveMismatch = false
): void {
  ensureBindingRow(table, bindingRow({
    ...input,
    consumedOperations: 0,
    consumedOperationIds: []
  }), false, allowActiveMismatch);
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
  input: ActorAxesBindingOperationConsumeInputV2,
  allowInactive = false
): ActorAxesBindingOperationConsumeResultV2 {
  const { tokenId, maximum, opId } = input;
  if (!isRequiredText(tokenId) || !isRequiredText(opId)
    || isLegacyUnwitnessedOperationId(opId)
    || !Number.isSafeInteger(maximum) || maximum < 1) return "denied";
  const row = table.get<unknown>(bindingKey(tokenId));
  if (!validBindingRow(row) || maximum !== row.maxOperations
    || (!allowInactive && !row.record.active)) {
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
  },
  allowInactive = false
): boolean {
  const row = table.get<unknown>(bindingKey(input.tokenId));
  return validBindingRow(row) && (allowInactive || row.record.active)
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
    tokenId: requiredBindingText(input.tokenId, "tokenId"),
    tokenDigest: digest32(input.tokenDigest, "tokenDigest"),
    maxOperations: requiredBindingPositiveInteger(input.maxOperations, "maxOperations"),
    consumedOperations: bindingNonNegativeInteger(
      input.consumedOperations,
      "consumedOperations"
    ),
    consumedOperationIds: input.consumedOperationIds.map(
      (opId) => requiredBindingText(opId, "consumedOperationIds")
    ),
    record: input.record
  };
}

function ensureBindingRow(
  table: DurableAuthorityStateTable,
  row: DurableBindingRowV2,
  replace = false,
  allowActiveMismatch = false
): void {
  const key = bindingKey(row.tokenId);
  const existing = table.get<unknown>(key);
  if (existing && !replace) {
    if ((validBindingRow(existing) || validLegacyBindingRow(existing))
      && sameBindingRegistration(existing, row, allowActiveMismatch)) return;
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
  right: DurableBindingRowV2,
  allowActiveMismatch: boolean
): boolean {
  if (!allowActiveMismatch) {
    return left.tokenId === right.tokenId
      && left.tokenDigest === right.tokenDigest
      && left.maxOperations === right.maxOperations
      && stableStringify(left.record) === stableStringify(right.record);
  }
  const { active: _leftActive, ...leftRecord } = left.record;
  const { active: _rightActive, ...rightRecord } = right.record;
  return left.tokenId === right.tokenId
    && left.tokenDigest === right.tokenDigest
    && left.maxOperations === right.maxOperations
    && stableStringify(leftRecord) === stableStringify(rightRecord);
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
  return `token:${requiredBindingText(tokenId, "tokenId")}`;
}

function digest32(value: Uint8Array, name: string): string {
  if (value.byteLength !== 32) {
    throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  }
  return Buffer.from(value).toString("base64url");
}

function requiredBindingPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  }
  return Number(value);
}

function bindingNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  }
  return Number(value);
}

function requiredBindingText(value: unknown, name: string): string {
  if (!isRequiredText(value)) {
    throw new Error(`AUTHORITY_PRODUCTION_FIELD_INVALID:${name}`);
  }
  return value;
}

function isRequiredText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.trim() === value && !value.includes("\0");
}
