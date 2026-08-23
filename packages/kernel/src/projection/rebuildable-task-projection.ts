// Public compatibility façade for the rebuildable task projection.
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";
export * from "./projection-reads.ts";
export { defaultLifecycleTaskProjectionPath, makeTaskProjection } from "./rebuildable-task-projection-factory.ts";
export { closeTaskProjectionsUnder } from "./rebuildable-task-projection-database.ts";
