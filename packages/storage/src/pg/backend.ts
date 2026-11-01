import type { Pool } from "pg";
import type { PostgresEventStoreScope } from "../postgres/pg-event-store.ts";
import { makePostgresTaskEventStore } from "../postgres/pg-task-event-store.ts";
import { createPgEntityStore, type PgEntityDeclarationStore } from "./pg-entity-store.ts";
import { materializePgProjectionEvents } from "./pg-task-event-materialize.ts";
import { createPgTaskProjectionSource, type PgTaskProjectionSource } from "./pg-task-source.ts";
import type { StorageScope } from "../storage-backend.ts";

export interface PgStorageBackendOptions {
  readonly pool: Pool;
  readonly repoId: string;
  readonly scope: PostgresEventStoreScope;
}

export function resolvePostgresEventStoreScope(scope: StorageScope | undefined): PostgresEventStoreScope {
  if (!scope?.tenantId || !scope.projectId || !Number.isSafeInteger(scope.policyEpoch) || scope.policyEpoch! < 0)
    throw new TypeError("PostgreSQL storage requires tenant, project, and non-negative policy epoch scope");
  return {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    policyEpoch: scope.policyEpoch!,
    readers: scope.readers ?? [],
  };
}

/** Shared PostgreSQL-dialect storage ports; callers retain ownership of the supplied pool. */
export function createPgStorageBackend(options: PgStorageBackendOptions): PgStorageBackend {
  const scope = { ...options.scope, readers: [...new Set(options.scope.readers)].sort() };
  if (!options.repoId || !scope.tenantId || !scope.projectId || !Number.isSafeInteger(scope.policyEpoch))
    throw new TypeError("PostgreSQL storage requires repo, tenant, project, and policy epoch scope");
  const eventStore = makePostgresTaskEventStore({
      pool: options.pool,
      repoId: options.repoId,
      scope,
      project: (client, input) => materializePgProjectionEvents(client, scope, input),
    }),
    projection = createPgTaskProjectionSource({ pool: options.pool, repoId: options.repoId, scope }),
    entities = createPgEntityStore({ pool: options.pool, scope });
  return { eventStore, projection, entities };
}

export interface PgStorageBackend {
  readonly eventStore: ReturnType<typeof makePostgresTaskEventStore>;
  readonly projection: PgTaskProjectionSource;
  readonly entities: PgEntityDeclarationStore;
}
