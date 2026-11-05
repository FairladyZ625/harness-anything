import type { TaskProjectionQueries } from "@harness-anything/kernel";

/** Display reads select kernel derivation; command admission keeps event status. */
export function taskPresentationReads(
  projection: TaskProjectionQueries,
): Pick<TaskProjectionQueries, "read" | "list" | "readTaskIndex"> {
  return {
    read: (taskId) => projection.read(taskId, true),
    list: (query = {}) => projection.list({ ...query, presentationStatus: true }),
    readTaskIndex: (query = {}) => projection.readTaskIndex({ ...query, presentationStatus: true }),
  };
}

/** Parent collections cannot derive an answer from deferred relationship metadata. */
export function requireTaskParentMetadata(read: { readonly warnings: readonly string[] }): void {
  if (read.warnings.includes("task_parent_metadata_deferred"))
    throw Object.assign(new Error("索引迁移中"), { code: "projection_pending" });
}
