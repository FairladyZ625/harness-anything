import {
  consumeKnownError,
  isMigrationImportEvent,
  normalizePersistedCanonicalEvent,
  parseCanonicalEvent,
  serializePersistedCanonicalEvent,
  stableStringify,
  type PersistedCanonicalEventV1,
} from "../../kernel/src/index.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";

export interface MigrationTaskProvenanceRestatement {
  readonly opId: string;
  readonly sourcePath: string;
}
export interface MigrationEventRead {
  readonly events: readonly PersistedCanonicalEventV1[];
  readonly migrationTaskProvenanceRestatements: readonly MigrationTaskProvenanceRestatement[];
}

export function restateLegacyMigrationTaskProvenance(value: unknown, body: string): PersistedCanonicalEventV1 | null {
  if (
    !isJsonObject(value) ||
    value.schema !== "migration-import-event/v1" ||
    !isJsonObject(value.payload) ||
    !isJsonObject(value.payload.entity) ||
    value.payload.entity.kind !== "task" ||
    Object.hasOwn(value.payload.entity, "provenance") ||
    `${stableStringify(value)}\n` !== body
  )
    return null;
  const normalized = normalizePersistedCanonicalEvent(
      value as unknown as PersistedCanonicalEventV1,
    ) as unknown as Record<string, unknown>,
    payload = normalized.payload;
  if (!isJsonObject(payload) || !isJsonObject(payload.entity)) return null;
  const candidate = {
    ...normalized,
    payload: {
      ...payload,
      entity: { ...payload.entity, provenance: "imported_snapshot" },
    },
  };
  try {
    const event = parseCanonicalEvent(
      serializePersistedCanonicalEvent(candidate as unknown as PersistedCanonicalEventV1),
    );
    return isMigrationImportEvent(event) && event.payload.entity.kind === "task" ? event : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
