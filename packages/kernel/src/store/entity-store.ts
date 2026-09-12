import { deepFreeze } from "../domain/artifact-entity.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { compileEntityUpsert, type EntityUpsertBundle } from "../domain/entity-event-compile.ts";
import {
  contractForDeclarationEvent,
  isEntityDeclarationEvent,
  isEntityEvent,
  type StoredEntityEventV1,
} from "../domain/entity-event.ts";
import { interpretEntityValue } from "../domain/entity-kind-projection.ts";
import { requireEntityStoreKindContract, type EntityStoreKindContract } from "../domain/entity-kind-registry.ts";
import { openSqliteEventStore } from "./sqlite-event-store.ts";
import type { CanonicalEventStore } from "./task-event-store-types.ts";

export interface StoredEntity<T = unknown> {
  readonly kind: string;
  readonly id: string;
  readonly value: T;
  readonly documentPath: string;
  readonly documentSha256: string;
  readonly workspaceRevision: number;
}

export interface EntityStore {
  readonly upsert: (input: Parameters<typeof compileEntityUpsert>[0]) => EntityUpsertBundle;
  readonly get: <T = unknown>(kind: string, id: string) => StoredEntity<T> | null;
  readonly list: <T = unknown>(kind: string) => readonly StoredEntity<T>[];
}

type EntityEventSource = Pick<CanonicalEventStore, "readBatch" | "readContentBlob">;

const entityEventCaches = new WeakMap<
  EntityEventSource,
  {
    cursor: string | null;
    latestByKind: Map<string, Map<string, StoredEntityEventV1>>;
    records: Map<string, { event: StoredEntityEventV1; contract: EntityStoreKindContract; record: StoredEntity }>;
  }
>();

function entityEventCache(source: EntityEventSource): Map<string, Map<string, StoredEntityEventV1>> {
  const cache = entityEventCaches.get(source) ?? {
    cursor: null,
    latestByKind: new Map<string, Map<string, StoredEntityEventV1>>(),
    records: new Map(),
  };
  entityEventCaches.set(source, cache);
  for (;;) {
    const batch = source.readBatch(cache.cursor, 1024);
    for (const event of batch.events) {
      if (!isEntityEvent(event)) continue;
      const latest = cache.latestByKind.get(event.payload.entityKind) ?? new Map<string, StoredEntityEventV1>();
      cache.latestByKind.set(event.payload.entityKind, latest);
      const previous = latest.get(event.payload.entityId);
      if (
        previous &&
        isEntityDeclarationEvent(previous) &&
        (isEntityDeclarationEvent(event) || event.type === "entity_deleted")
      )
        cache.records.delete(previous.payload.declarationDocumentClaim.sha256);
      if (isEntityDeclarationEvent(event)) latest.set(event.payload.entityId, event);
      else if (event.type === "entity_deleted") latest.delete(event.payload.entityId);
    }
    cache.cursor = batch.cursor;
    if (batch.done) return cache.latestByKind;
  }
}

export function createEntityStore(
  source: EntityEventSource,
  dynamicContracts: readonly EntityStoreKindContract[] = [],
): EntityStore {
  const contractForKind = (kind: string): EntityStoreKindContract => {
    const dynamic = dynamicContracts.find((candidate) => candidate.kind === kind);
    if (dynamic) return dynamic;
    try {
      return requireEntityStoreKindContract(kind);
    } catch (error) {
      const declaration = [...(entityEventCache(source).get(kind)?.values() ?? [])].find(
        (event) => event.type === "entity_content_observed",
      );
      if (declaration && declaration.type === "entity_content_observed")
        return contractForDeclarationEvent(declaration);
      throw error;
    }
  };
  const latestEvents = (kind: string): ReadonlyMap<string, StoredEntityEventV1> => {
    const contract = contractForKind(kind);
    return entityEventCache(source).get(contract.kind) ?? new Map<string, StoredEntityEventV1>();
  };
  const records = (kind: string): readonly StoredEntity[] => {
    const contract = contractForKind(kind);
    return [...latestEvents(kind).values()]
      .map((event) => entityEventRecord(event, source, contract))
      .sort((left, right) => left.id.localeCompare(right.id));
  };
  return {
    upsert: compileEntityUpsert,
    get: <T>(kind: string, id: string) => {
      const contract = contractForKind(kind),
        event = latestEvents(kind).get(id);
      return event === undefined ? null : (entityEventRecord(event, source, contract) as StoredEntity<T>);
    },
    list: <T>(kind: string) => records(kind) as readonly StoredEntity<T>[],
  };
}

export function openEntityStore(rootInput: HarnessLayoutInput): EntityStore {
  const canonical = openSqliteEventStore({ rootInput, readOnly: true });
  return createEntityStore({
    readBatch: (cursor, maxItems) => {
      const start = cursor === null ? 0 : Number(cursor),
        events = canonical.eventsAfter(start, maxItems),
        next = start + events.length;
      return {
        sourceRevision: canonical.revision(),
        events,
        cursor: events.length ? String(next) : cursor,
        done: next === canonical.revision(),
        accessedItems: events.length,
      };
    },
    readContentBlob: canonical.readContentObject,
  });
}

function entityEventRecord(
  event: StoredEntityEventV1,
  source: EntityEventSource,
  contract: ReturnType<typeof requireEntityStoreKindContract>,
): StoredEntity {
  if (!isEntityDeclarationEvent(event)) throw new Error("entity target-missing event has no declaration document");
  const claim = event.payload.declarationDocumentClaim,
    cache = entityEventCaches.get(source)!.records,
    cached = cache.get(claim.sha256);
  if (cached?.event === event && cached.contract === contract) return cached.record;
  const bytes = source.readContentBlob(claim.sha256);
  if (!bytes || bytes.byteLength !== claim.size)
    throw new Error(`entity declaration blob ${claim.sha256} is unavailable`);
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`entity declaration blob ${claim.sha256} is not UTF-8`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new Error(`entity declaration blob ${claim.sha256} is not JSON`);
  }
  const eventContract = contractForDeclarationEvent(event);
  if (eventContract.kind !== contract.kind) throw new Error("entity declaration contract kind mismatch");
  const entity = interpretEntityValue(eventContract, decoded),
    contractErrors = contract.entityStore.validate?.(entity.value) ?? [];
  if (contractErrors.length) throw new Error(contractErrors.join("; "));
  if (entity.id !== event.payload.entityId)
    throw new Error(`entity declaration blob ${claim.sha256} identity mismatch`);
  const record = deepFreeze({
    kind: contract.kind,
    id: event.payload.entityId,
    value: entity.value,
    documentPath: claim.path,
    documentSha256: claim.sha256,
    workspaceRevision: event.workspaceRevision,
  });
  cache.set(claim.sha256, { event, contract, record });
  return record;
}
