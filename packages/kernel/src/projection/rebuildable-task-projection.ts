// Public compatibility façade for the rebuildable task projection.
export type {
  ProjectionPage,
  TaskProjectionListQuery,
  TaskRelationNeighborhoodQuery,
  TaskRelationQuery,
} from "./task-query-projection.ts";
export type {
  TaskProjection,
  TaskProjectionPort,
  TaskProjectionQueriesPort,
  TaskProjectionQueries,
  TaskProjectionReader,
  TaskProjectionReaderPort,
  TaskProjectionWriter,
} from "./task-projection-port.ts";
export * from "./projection-reads.ts";
export {
  defaultLifecycleTaskProjectionPath,
  makeTaskProjection,
  makeTaskProjectionReader,
} from "./rebuildable-task-projection-factory.ts";
export type {
  TaskProjectionFactoryOptions,
  TaskProjectionReaderFactoryOptions,
  PostgresTaskProjectionFactoryOptions,
  PostgresTaskProjectionReaderFactoryOptions,
} from "./rebuildable-task-projection-factory.ts";
export { ProjectionIdentityMismatchError, closeTaskProjectionsUnder } from "./rebuildable-task-projection-database.ts";
