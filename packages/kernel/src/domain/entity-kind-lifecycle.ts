import { randomBytes } from "node:crypto";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import {
  parseEntityJsonSchema,
  type EntityDocumentJsonSchema,
  type EntityJsonObjectSchema,
} from "./entity-json-schema.ts";

export const ENTITY_KIND_LIFECYCLE_EVENT_SCHEMA = "entity-kind-event/v1" as const;
export const ENTITY_KIND_ID_PREFIX = "entity-kind/KND-" as const;
export const ENTITY_ID_PREFIX = "entity/RES-" as const;

export type KindId = `${typeof ENTITY_KIND_ID_PREFIX}${string}`;
export type EntityId = `${typeof ENTITY_ID_PREFIX}${string}`;

export interface KindSchemaVersion {
  readonly version: number;
  readonly schema: EntityJsonObjectSchema;
  readonly digest: `sha256:${string}`;
}

export interface EntityKindRecord {
  readonly id: KindId;
  readonly name: string;
  readonly schemaVersions: readonly KindSchemaVersion[];
  readonly latestSchemaVersion: number;
  readonly archived: boolean;
  readonly revision: number;
}

export interface GenericEntityRecord {
  readonly id: EntityId;
  readonly kindId: KindId;
  readonly kindVersion: number;
  readonly title: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly archived: boolean;
  readonly revision: number;
}

export type EntityKindLifecycleEvent = {
  readonly schema: typeof ENTITY_KIND_LIFECYCLE_EVENT_SCHEMA;
  readonly eventId: string;
  readonly opId: string;
  readonly revision: number;
  readonly type:
    | "kind_created"
    | "kind_schema_published"
    | "kind_renamed"
    | "kind_archived"
    | "entity_imported"
    | "entity_updated"
    | "entity_archived";
  readonly payload: Readonly<Record<string, unknown>>;
};

export type EntityKindLifecycleAction =
  | {
      readonly kind: "entity-kind-create";
      readonly name: string;
      readonly schema: EntityJsonObjectSchema;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: "entity-kind-schema-publish";
      readonly kindId: KindId;
      readonly schema: EntityJsonObjectSchema;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: "entity-kind-rename";
      readonly kindId: KindId;
      readonly name: string;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: "entity-kind-archive";
      readonly kindId: KindId;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: "entity-import";
      readonly kindId: KindId;
      readonly title: string;
      readonly attributes: Readonly<Record<string, unknown>>;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: "entity-update";
      readonly entityId: EntityId;
      readonly title?: string;
      readonly attributes?: Readonly<Record<string, unknown>>;
      readonly expectedRevision: number;
    }
  | { readonly kind: "entity-archive"; readonly entityId: EntityId; readonly expectedRevision: number };

export interface EntityKindLifecycle {
  readonly dispatch: (action: EntityKindLifecycleAction) => EntityKindLifecycleEvent;
  readonly events: () => readonly EntityKindLifecycleEvent[];
  readonly readKind: (kindId: KindId) => EntityKindRecord | null;
  readonly listKinds: () => readonly EntityKindRecord[];
  readonly readEntity: (entityId: EntityId) => GenericEntityRecord | null;
}

export function createEntityKindLifecycle(
  input: {
    readonly events?: readonly EntityKindLifecycleEvent[];
    readonly append?: (event: EntityKindLifecycleEvent) => void;
    readonly mint?: () => string;
  } = {},
): EntityKindLifecycle {
  const log = [...(input.events ?? [])];
  const kinds = new Map<KindId, EntityKindRecord>();
  const entities = new Map<EntityId, GenericEntityRecord>();
  const mint = input.mint ?? (() => randomBytes(16).toString("hex"));
  for (const event of log) applyEvent(event, kinds, entities);

  const dispatch = (action: EntityKindLifecycleAction): EntityKindLifecycleEvent => {
    const expected = action.expectedRevision;
    if (!Number.isSafeInteger(expected) || expected !== log.length)
      fail("revision_conflict", `Expected revision ${expected}, current revision is ${log.length}.`);
    const event = compileAction(action, kinds, entities, mint, log.length + 1);
    input.append?.(event);
    applyEvent(event, kinds, entities);
    log.push(event);
    return event;
  };
  return {
    dispatch,
    events: () => Object.freeze([...log]),
    readKind: (kindId) => kinds.get(kindId) ?? null,
    listKinds: () => Object.freeze([...kinds.values()].sort((a, b) => a.id.localeCompare(b.id))),
    readEntity: (entityId) => entities.get(entityId) ?? null,
  };
}

export const applyEntityKindAction = createEntityKindLifecycle;

function compileAction(
  action: EntityKindLifecycleAction,
  kinds: ReadonlyMap<KindId, EntityKindRecord>,
  entities: ReadonlyMap<EntityId, GenericEntityRecord>,
  mint: () => string,
  revision: number,
): EntityKindLifecycleEvent {
  const eventId = `event-${mint()}`,
    opId = `entity-kind-${revision}-${mint()}`;
  if (action.kind === "entity-kind-create") {
    const name = nonBlank(action.name, "name"),
      schema = normalizeSchema(action.schema);
    return event(eventId, opId, revision, "kind_created", {
      kindId: mintUniqueKindId(kinds, mint),
      name,
      schemaVersion: schemaVersion(schema, 1),
    });
  }
  if (action.kind === "entity-kind-schema-publish") {
    const current = requireKind(kinds, action.kindId);
    if (current.archived) fail("kind_archived", `${action.kindId} is archived.`);
    const schema = normalizeSchema(action.schema),
      version = current.latestSchemaVersion + 1;
    return event(eventId, opId, revision, "kind_schema_published", {
      kindId: current.id,
      schemaVersion: schemaVersion(schema, version),
    });
  }
  if (action.kind === "entity-kind-rename") {
    const current = requireKind(kinds, action.kindId);
    if (current.archived) fail("kind_archived", `${action.kindId} is archived.`);
    return event(eventId, opId, revision, "kind_renamed", { kindId: current.id, name: nonBlank(action.name, "name") });
  }
  if (action.kind === "entity-kind-archive") {
    requireKind(kinds, action.kindId);
    return event(eventId, opId, revision, "kind_archived", { kindId: action.kindId });
  }
  if (action.kind === "entity-import") {
    const current = requireKind(kinds, action.kindId);
    if (current.archived) fail("kind_archived", `${action.kindId} is archived and cannot create instances.`);
    const title = nonBlank(action.title, "title"),
      attributes = validateAttributes(current, action.attributes);
    return event(eventId, opId, revision, "entity_imported", {
      entityId: mintUniqueEntityId(entities, mint),
      kindId: current.id,
      kindVersion: current.latestSchemaVersion,
      title,
      attributes,
    });
  }
  if (action.kind === "entity-update") {
    const current = entities.get(action.entityId);
    if (!current) fail("entity_not_found", `${action.entityId} does not exist.`);
    const kind = requireKind(kinds, current.kindId);
    if (current.archived) fail("entity_archived", `${action.entityId} is archived.`);
    const attributes =
      action.attributes === undefined
        ? current.attributes
        : validateAttributesAt(kind, current.kindVersion, action.attributes);
    return event(eventId, opId, revision, "entity_updated", {
      entityId: current.id,
      title: action.title === undefined ? current.title : nonBlank(action.title, "title"),
      attributes,
    });
  }
  const current = entities.get(action.entityId);
  if (!current) fail("entity_not_found", `${action.entityId} does not exist.`);
  return event(eventId, opId, revision, "entity_archived", { entityId: current.id });
}

function applyEvent(
  event: EntityKindLifecycleEvent,
  kinds: Map<KindId, EntityKindRecord>,
  entities: Map<EntityId, GenericEntityRecord>,
): void {
  const p = event.payload;
  if (event.type === "kind_created") {
    const kindId = p.kindId as KindId;
    kinds.set(kindId, {
      id: kindId,
      name: String(p.name),
      schemaVersions: [p.schemaVersion as KindSchemaVersion],
      latestSchemaVersion: 1,
      archived: false,
      revision: event.revision,
    });
  } else if (event.type === "kind_schema_published") {
    const current = requireKind(kinds, p.kindId as KindId),
      next = p.schemaVersion as KindSchemaVersion;
    kinds.set(current.id, {
      ...current,
      schemaVersions: [...current.schemaVersions, next],
      latestSchemaVersion: next.version,
      revision: event.revision,
    });
  } else if (event.type === "kind_renamed") {
    const current = requireKind(kinds, p.kindId as KindId);
    kinds.set(current.id, { ...current, name: String(p.name), revision: event.revision });
  } else if (event.type === "kind_archived") {
    const current = requireKind(kinds, p.kindId as KindId);
    kinds.set(current.id, { ...current, archived: true, revision: event.revision });
  } else if (event.type === "entity_imported") {
    const id = p.entityId as EntityId;
    entities.set(id, {
      id,
      kindId: p.kindId as KindId,
      kindVersion: Number(p.kindVersion),
      title: String(p.title),
      attributes: p.attributes as Readonly<Record<string, unknown>>,
      archived: false,
      revision: event.revision,
    });
  } else {
    const current = entities.get(p.entityId as EntityId);
    if (!current) fail("entity_not_found", `${String(p.entityId)} does not exist.`);
    entities.set(
      current.id,
      event.type === "entity_archived"
        ? { ...current, archived: true, revision: event.revision }
        : {
            ...current,
            ...(p.title === undefined ? {} : { title: String(p.title) }),
            ...(p.attributes === undefined ? {} : { attributes: p.attributes as Readonly<Record<string, unknown>> }),
            revision: event.revision,
          },
    );
  }
}

function validateAttributes(kind: EntityKindRecord, value: unknown): Readonly<Record<string, unknown>> {
  return validateAttributesAt(kind, kind.latestSchemaVersion, value);
}

function validateAttributesAt(
  kind: EntityKindRecord,
  version: number,
  value: unknown,
): Readonly<Record<string, unknown>> {
  const schema = kind.schemaVersions.find((candidate) => candidate.version === version)?.schema;
  if (!schema) fail("schema_not_found", `${kind.id} schema v${version} is unavailable.`);
  try {
    return parseEntityJsonSchema(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `entity-kind/${kind.id}/v${version}`,
        ...schema,
      },
      value,
      "entity attributes",
    ) as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
      code: "invalid_attributes",
    });
  }
}

function normalizeSchema(schema: EntityJsonObjectSchema): EntityJsonObjectSchema {
  if (schema.type !== "object" || schema.additionalProperties)
    fail("invalid_schema", "Kind attributes schema must be a closed JSON object.");
  return Object.freeze({
    ...schema,
    properties: Object.freeze({ ...schema.properties }),
    required: Object.freeze([...schema.required]),
  });
}

function schemaVersion(schema: EntityJsonObjectSchema, version: number): KindSchemaVersion {
  return { version, schema, digest: `sha256:${sha256Text(stableStringify(schema))}` };
}

function requireKind(kinds: ReadonlyMap<KindId, EntityKindRecord>, id: KindId): EntityKindRecord {
  const kind = kinds.get(id);
  if (!kind) fail("kind_not_found", `${id} does not exist.`);
  return kind;
}

function mintKindId(mint: () => string): KindId {
  return `${ENTITY_KIND_ID_PREFIX}${mint()
    .replace(/[^0-9a-f]/giu, "")
    .slice(0, 32)
    .padEnd(32, "0")}` as KindId;
}
function mintUniqueKindId(kinds: ReadonlyMap<KindId, EntityKindRecord>, mint: () => string): KindId {
  let id = mintKindId(mint);
  while (kinds.has(id)) id = mintKindId(mint);
  return id;
}
function mintEntityId(mint: () => string): EntityId {
  return `${ENTITY_ID_PREFIX}${mint()
    .replace(/[^0-9a-f]/giu, "")
    .slice(0, 32)
    .padEnd(32, "0")}` as EntityId;
}
function mintUniqueEntityId(entities: ReadonlyMap<EntityId, GenericEntityRecord>, mint: () => string): EntityId {
  let id = mintEntityId(mint);
  while (entities.has(id)) id = mintEntityId(mint);
  return id;
}
function nonBlank(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail("invalid_field", `${field} must be non-empty.`);
  return value.trim();
}
function event(
  eventId: string,
  opId: string,
  revision: number,
  type: EntityKindLifecycleEvent["type"],
  payload: Record<string, unknown>,
): EntityKindLifecycleEvent {
  return Object.freeze({
    schema: ENTITY_KIND_LIFECYCLE_EVENT_SCHEMA,
    eventId,
    opId,
    revision,
    type,
    payload: Object.freeze(payload),
  });
}
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export type { EntityDocumentJsonSchema };
