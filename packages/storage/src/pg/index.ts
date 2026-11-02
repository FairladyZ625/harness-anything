export { createPgStorageBackend, resolvePostgresEventStoreScope } from "./backend.ts";
export type { PgStorageBackend, PgStorageBackendOptions } from "./backend.ts";
export {
  ensurePgProjectionSchema,
  grantPgProjectionRuntimeAccess,
  PG_PROJECTION_SCHEMA_VERSION,
  PG_PROJECTION_TABLES,
  projectionDdl,
} from "./pg-projection-schema.ts";
export {
  materializePgProjectionEvent,
  materializePgProjectionEvents,
  projectionStateDigest,
  rebuildPgProjection,
} from "./pg-task-event-materialize.ts";
export type {
  PgProjectionEventInput,
  PgProjectionMaterializationReceipt,
  PgProjectionRebuildInput,
  PgProjectionScope,
} from "./pg-task-event-materialize.ts";
export { createPgTaskProjectionSource } from "./pg-task-source.ts";
export type { PgProjectionCut, PgTaskProjectionSource, PgTaskProjectionSourceOptions } from "./pg-task-source.ts";
export { createPgTaskQueryReader } from "./pg-task-query-reader.ts";
export type { PgTaskQueryMethods, PgTaskQueryReader, PgTaskQueryReaderOptions } from "./pg-task-query-reader.ts";
export {
  createPgEntityStore,
  persistPgEntityDeclaration,
  persistPgEntityDeclarationInTransaction,
} from "./pg-entity-store.ts";
export type { PgEntityDeclarationStore, PgEntityDeclarationWrite, PgEntityStoreOptions } from "./pg-entity-store.ts";
