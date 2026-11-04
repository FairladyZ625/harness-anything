import { reduceEntityDeclarationState } from "./entity-declaration-state.ts";
import type { EntityDeclarationState } from "@harness-anything/kernel/internal/ports/entity-declarations.ts";
import { createSqlTaskQueryReader } from "../pg/sql-task-query-reader.ts";
import { resolvePostgresEventStoreScope } from "../pg/backend.ts";
import { deepFreeze } from "@harness-anything/kernel/internal/domain/artifact-entity.ts";
import type { HarnessLayoutInput } from "@harness-anything/kernel/internal/layout/index.ts";
import {
  compileEntityUpsert,
  type EntityUpsertBundle,
} from "@harness-anything/kernel/internal/domain/entity-event-compile.ts";
import {
  contractForDeclarationEvent,
  isEntityDeclarationEvent,
  isEntityEvent,
  type StoredEntityEventV1,
} from "@harness-anything/kernel/internal/domain/entity-event.ts";
import { interpretEntityValue } from "@harness-anything/kernel/internal/domain/entity-kind-projection.ts";
import {
  requireEntityStoreKindContract,
  type EntityStoreKindContract,
} from "@harness-anything/kernel/internal/domain/entity-kind-registry.ts";
import { openSqliteEventStore } from "./sqlite-event-store.ts";
import type { CanonicalEventStore } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import {
  type PostgresStorageBackendConfig,
  type PGliteStorageBackendConfig,
  type SqliteStorageBackendConfig,
  type StorageBackendOptions,
  type StorageScope,
} from "../storage-backend.ts";

export interface StoredEntity<T = unknown> {
  readonly kind: string;
  readonly id: string;
  readonly value: T;
  readonly documentPath: string | null;
  readonly documentSha256: string | null;
  /** Backend-specific declaration metadata retained outside the canonical document. */
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
  readonly workspaceRevision: number;
}

export interface EntityDeclarationStorePort {
  readonly upsert: (input: Parameters<typeof compileEntityUpsert>[0], scope?: StorageScope) => EntityUpsertBundle;
  readonly get: <T = unknown>(kind: string, id: string, scope?: StorageScope) => StoredEntity<T> | null;
  readonly list: <T = unknown>(kind: string, scope?: StorageScope) => readonly StoredEntity<T>[];
}

/** Existing synchronous SQLite entity-store contract. */
export interface EntityStore {
  readonly upsert: (input: Parameters<typeof compileEntityUpsert>[0], scope?: StorageScope) => EntityUpsertBundle;
  readonly get: <T = unknown>(kind: string, id: string, scope?: StorageScope) => StoredEntity<T> | null;
  readonly list: <T = unknown>(kind: string, scope?: StorageScope) => readonly StoredEntity<T>[];
}

type EntityEventSource = Pick<CanonicalEventStore, "readBatch" | "readContentBlob" | "readEntityDeclarations">;
type SqliteEntityStoreOptions = Omit<StorageBackendOptions, "storage"> & {
  readonly storage?: SqliteStorageBackendConfig;
};
export type PostgresEntityDeclarationStoreOptions = {
  readonly storage: PostgresStorageBackendConfig;
  readonly repoId?: string;
};
export type SqlEntityStoreOptions = {
  readonly storage: PostgresStorageBackendConfig | PGliteStorageBackendConfig;
  readonly repoId?: string;
};
export type OpenedEntityStore = EntityStore & { readonly close: () => void };

const entityEventCaches = new WeakMap<
  EntityEventSource,
  {
    cursor: string | null;
    headsByKind: Map<string, Map<string, EntityDeclarationState>>;
    records: Map<string, { event: StoredEntityEventV1; contract: EntityStoreKindContract; record: StoredEntity }>;
  }
>();
function cacheFor(source: EntityEventSource) {
  let cache = entityEventCaches.get(source);
  if (!cache) {
    cache = { cursor: null, headsByKind: new Map(), records: new Map() };
    entityEventCaches.set(source, cache);
  }
  return cache;
}

function entityEventCache(source: EntityEventSource): Map<string, Map<string, EntityDeclarationState>> {
  const cache = cacheFor(source);
  for (;;) {
    const batch = source.readBatch(cache.cursor, 1024);
    for (const event of batch.events) {
      if (!isEntityEvent(event)) continue;
      const { entityKind, entityId } = event.payload,
        heads = cache.headsByKind.get(entityKind) ?? new Map<string, EntityDeclarationState>(),
        before = heads.get(entityId)?.declaration;
      cache.headsByKind.set(entityKind, heads);
      if (
        before &&
        (isEntityDeclarationEvent(event) || event.type === "entity_deleted") &&
        before.type !== "entity_reference_declared"
      )
        cache.records.delete(before.payload.declarationDocumentClaim.sha256);
      heads.set(entityId, reduceEntityDeclarationState(heads.get(entityId) ?? null, event));
    }
    cache.cursor = batch.cursor;
    if (batch.done) return cache.headsByKind;
  }
}

export function createEntityStore(
  source: EntityEventSource,
  options: PostgresEntityDeclarationStoreOptions,
): EntityDeclarationStorePort;
export function createEntityStore(
  source: EntityEventSource,
  dynamicContracts: readonly EntityStoreKindContract[],
  options: PostgresEntityDeclarationStoreOptions,
): EntityDeclarationStorePort;
export function createEntityStore(source: EntityEventSource): EntityStore;
export function createEntityStore(source: EntityEventSource, options: StorageBackendOptions): EntityStore;
export function createEntityStore(
  source: EntityEventSource,
  dynamicContracts: readonly EntityStoreKindContract[],
  options?: StorageBackendOptions,
): EntityStore;
export function createEntityStore(
  source: EntityEventSource,
  dynamicContractsOrOptions: readonly EntityStoreKindContract[] | StorageBackendOptions = [],
  _options: StorageBackendOptions = {},
): EntityStore | EntityDeclarationStorePort {
  const dynamicContracts = Array.isArray(dynamicContractsOrOptions) ? dynamicContractsOrOptions : [];
  // The supplied event source already owns backend selection and scope. This reader compiles
  // bundles and interprets accepted declarations; it never opens another physical database.
  const heads = (kind: string, id?: string, limit?: number): readonly EntityDeclarationState[] => {
    if (source.readEntityDeclarations)
      return source.readEntityDeclarations({
        kind,
        ...(id === undefined ? {} : { id }),
        ...(limit === undefined ? {} : { limit }),
      });
    const values = entityEventCache(source).get(kind);
    const candidates = id === undefined ? [...(values?.values() ?? [])] : [values?.get(id)];
    const live = candidates.filter((state): state is EntityDeclarationState => state?.declaration != null);
    return limit === undefined ? live : live.slice(0, limit);
  };
  const contractForKind = (kind: string): EntityStoreKindContract => {
    const dynamic = dynamicContracts.find((candidate) => candidate.kind === kind);
    if (dynamic) return dynamic;
    try {
      return requireEntityStoreKindContract(kind);
    } catch (error) {
      const declaration = heads(kind, undefined, 1)[0]?.declaration;
      if (
        declaration &&
        (declaration.type === "entity_content_observed" || declaration.type === "entity_reference_declared")
      )
        return contractForDeclarationEvent(declaration);
      throw error;
    }
  };
  const recordFor = (kind: string, state: EntityDeclarationState, contract: EntityStoreKindContract): StoredEntity => {
    const record = entityEventRecord(state.declaration!, source, contract);
    return kind === "agent" && state.retirement
      ? {
          ...record,
          value: {
            ...(record.value as Record<string, unknown>),
            lifecycleState: "retired",
            retirement: state.retirement,
          },
        }
      : record;
  };
  return {
    upsert: compileEntityUpsert,
    get: <T>(kind: string, id: string) => {
      const contract = contractForKind(kind),
        state = heads(contract.kind, id, 1)[0];
      return state ? (recordFor(kind, state, contract) as StoredEntity<T>) : null;
    },
    list: <T>(kind: string) => {
      const contract = contractForKind(kind);
      return heads(contract.kind)
        .map((state) => recordFor(kind, state, contract))
        .sort((left, right) => left.id.localeCompare(right.id)) as readonly StoredEntity<T>[];
    },
  };
}

export function openEntityStore(rootInput: HarnessLayoutInput, options: SqlEntityStoreOptions): OpenedEntityStore;
export function openEntityStore(rootInput: HarnessLayoutInput, options?: SqliteEntityStoreOptions): OpenedEntityStore;
export function openEntityStore(
  rootInput: HarnessLayoutInput,
  options: StorageBackendOptions & { readonly repoId?: string } = {},
): OpenedEntityStore {
  const storage = options.storage;
  if (storage?.backend === "postgres" || storage?.backend === "pglite") {
    resolvePostgresEventStoreScope(storage.scope);
    if (!options.repoId) throw new TypeError("SQL entity store requires explicit repoId");
    const reader = createSqlTaskQueryReader({ storage, repoId: options.repoId, requireRuntimeRole: true }),
      source: EntityEventSource = {
        readBatch: (cursor, maxItems) =>
          reader.executeCanonical({ operation: "batch", cursor, maxItems }) as ReturnType<
            EntityEventSource["readBatch"]
          >,
        readContentBlob: (sha256) => reader.executeCanonical({ operation: "content", sha256 }) as Uint8Array | null,
        readEntityDeclarations: (query) =>
          reader.executeCanonical({ operation: "entity-declarations", query }) as ReturnType<
            NonNullable<EntityEventSource["readEntityDeclarations"]>
          >,
      };
    return { ...createEntityStore(source), close: reader.close };
  }
  const canonical = openSqliteEventStore({ rootInput, readOnly: true });
  return {
    ...createEntityStore({
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
      readEntityDeclarations: canonical.readEntityDeclarations,
    }),
    close: canonical.close,
  };
}

function entityEventRecord(
  event: StoredEntityEventV1,
  source: EntityEventSource,
  contract: ReturnType<typeof requireEntityStoreKindContract>,
): StoredEntity {
  if (!isEntityDeclarationEvent(event)) throw new Error("entity target-missing event has no declaration document");
  if (event.type === "entity_reference_declared") {
    const eventContract = contractForDeclarationEvent(event);
    if (eventContract.kind !== contract.kind) throw new Error("entity declaration contract kind mismatch");
    const entity = interpretEntityValue(eventContract, event.payload.descriptor),
      contractErrors = contract.entityStore.validate?.(entity.value) ?? [];
    if (contractErrors.length) throw new Error(contractErrors.join("; "));
    if (entity.id !== event.payload.entityId) throw new Error("entity reference identity mismatch");
    return deepFreeze({
      kind: contract.kind,
      id: event.payload.entityId,
      value: entity.value,
      documentPath: null,
      documentSha256: null,
      workspaceRevision: event.workspaceRevision,
    });
  }
  const claim = event.payload.declarationDocumentClaim,
    cache = source.readEntityDeclarations ? undefined : cacheFor(source).records,
    cached = cache?.get(claim.sha256);
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
  cache?.set(claim.sha256, { event, contract, record });
  return record;
}
