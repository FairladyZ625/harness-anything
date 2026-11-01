// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { createEntityStore, openEntityStore } from "../../src/store/entity-store.ts";
import {
  makeTaskEventReader,
  makeTaskEventStore,
  resolveStorageBackend,
  type LedgerEventStorePort,
  type PostgresStorageBackendConfig,
  type SqliteCanonicalEventStore,
  type StorageBackendOptions,
  type StorageScope,
} from "../../src/store/task-event-store.ts";
import type { EntityDeclarationStorePort, StoredEntity } from "../../src/store/entity-store.ts";
import {
  makeTaskProjectionReader,
  type TaskProjectionPort,
  type TaskProjectionReaderPort,
} from "../../src/projection/rebuildable-task-projection.ts";
import { withTempStore } from "./helpers.ts";

const scope: StorageScope = {
  tenantId: "tenant-a",
  projectId: "project-a",
  readers: ["reader-a"],
  policyEpoch: 7,
};

test("storage config defaults to SQLite and resolves one nested config field", () => {
  assert.deepEqual(resolveStorageBackend(), { backend: "sqlite" });
  assert.deepEqual(resolveStorageBackend({ storage: { backend: "sqlite", scope } }), {
    backend: "sqlite",
    scope,
  });
  withTempStore((rootDir) => {
    const store = makeTaskEventStore({ repoId: "backend-route", rootDir, storage: { scope } });
    assert.equal("scope" in store, false);
    assert.equal(typeof store.append, "function");
  });
  assert.deepEqual(
    resolveStorageBackend({ storage: { backend: "pglite", dataDir: "memory://backend-route", scope } }),
    {
      backend: "pglite",
      dataDir: "memory://backend-route",
      scope,
    },
  );
});

test("postgres is a typed route with an explicit Wave 1 implementation boundary", () => {
  assert.throws(
    () =>
      makeTaskEventStore({
        repoId: "postgres-route",
        rootDir: "/tmp/unused",
        storage: { backend: "postgres", connectionString: "postgres://localhost/ha" },
      }),
    /storage backend "postgres" is not implemented by kernel Wave 1/u,
  );
  assert.throws(
    () =>
      makeTaskEventReader({
        repoId: "postgres-route",
        rootDir: "/tmp/unused",
        storage: { backend: "postgres", connectionString: "postgres://localhost/ha" },
      }),
    /storage backend "postgres" is not implemented by kernel Wave 1/u,
  );
  assert.throws(
    () =>
      createEntityStore(emptyEventSource, {
        storage: { backend: "postgres", connectionString: "postgres://localhost/ha", scope },
      }),
    /storage backend "postgres" is not implemented by kernel Wave 1/u,
  );
  assert.throws(
    () =>
      openEntityStore("/tmp/unused", { storage: { backend: "postgres", connectionString: "postgres://localhost/ha" } }),
    /storage backend "postgres" is not implemented by kernel Wave 1/u,
  );
  assert.throws(
    () => makeTaskProjectionReader({ storage: { backend: "postgres", connectionString: "postgres://localhost/ha" } }),
    /storage backend "postgres" is not implemented by kernel Wave 1/u,
  );
});

test("pglite is a typed route and cannot accidentally fall through to SQLite", () => {
  assert.throws(
    () =>
      makeTaskEventStore({
        repoId: "pglite-route",
        rootDir: "/tmp/unused",
        storage: { backend: "pglite", dataDir: "memory://pglite-route" },
      }),
    /storage backend "pglite" is not implemented by kernel Wave 1/u,
  );
});

const emptyEventSource = {
  readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }),
  readContentBlob: () => null,
};

declare const ledgerPort: LedgerEventStorePort;
declare const projectionPort: TaskProjectionPort;
declare const projectionReaderPort: TaskProjectionReaderPort;
declare const entityStorePort: EntityDeclarationStorePort;

function postgresStoreRoute(): LedgerEventStorePort {
  return makeTaskEventStore({
    repoId: "typed-postgres-route",
    storage: { backend: "postgres", connectionString: "postgres://localhost/ha" },
  });
}
function pgliteStoreRoute(): LedgerEventStorePort {
  return makeTaskEventStore({
    repoId: "typed-pglite-route",
    storage: { backend: "pglite", dataDir: "memory://typed-pglite-route" },
  });
}
function sqliteStoreRoute(): SqliteCanonicalEventStore {
  return makeTaskEventStore({ repoId: "typed-sqlite-route" });
}
function postgresProjectionRoute(): TaskProjectionPort {
  return makeTaskProjection({
    rootDir: "/unused-for-postgres",
    eventStore: asyncLedgerPort,
    storage: { backend: "postgres", connectionString: "postgres://localhost/ha" },
  });
}
function postgresProjectionReaderRoute(): TaskProjectionReaderPort {
  return makeTaskProjectionReader({ storage: { backend: "postgres", connectionString: "postgres://localhost/ha" } });
}
function postgresEntityStoreRoute(): EntityDeclarationStorePort {
  return createEntityStore(emptyEventSource, {
    storage: { backend: "postgres", connectionString: "postgres://localhost/ha" },
  });
}
function syncPortMethodTypes() {
  const syncLedgerRead: ReturnType<LedgerEventStorePort["read"]> = ledgerPort.read();
  const syncProjectionRead: ReturnType<TaskProjectionPort["read"]> = projectionPort.read("task");
  const syncProjectionReaderClose: ReturnType<TaskProjectionReaderPort["close"]> = projectionReaderPort.close();
  const syncEntityRead: StoredEntity | null = entityStorePort.get("agent", "agent");
  return [syncLedgerRead, syncProjectionRead, syncProjectionReaderClose, syncEntityRead];
}
void [
  postgresStoreRoute,
  pgliteStoreRoute,
  sqliteStoreRoute,
  postgresProjectionRoute,
  postgresProjectionReaderRoute,
  postgresEntityStoreRoute,
];
void syncPortMethodTypes;

function rejectsLegacyTopLevelConfig(): void {
  // @ts-expect-error backend belongs inside the single storage config field.
  const backendOption: StorageBackendOptions = { backend: "postgres" };
  // @ts-expect-error connectionString belongs inside the postgres storage config.
  const connectionStringOption: StorageBackendOptions = { connectionString: "postgres://localhost/ha" };
  // @ts-expect-error postgres requires its connection string in the storage config.
  const incompletePostgresConfig: PostgresStorageBackendConfig = { backend: "postgres" };
  void [backendOption, connectionStringOption, incompletePostgresConfig];
}
void rejectsLegacyTopLevelConfig;
