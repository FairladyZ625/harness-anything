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

/** A collection cannot treat an incomplete projection as an empty, ready answer. */
export function requireTaskCollectionReady(
  read: {
    readonly status: "ready" | "pending";
    readonly warnings: readonly string[];
  },
  parentMetadata = false,
): void {
  if (read.status !== "ready" || (parentMetadata && read.warnings.includes("task_parent_metadata_deferred")))
    throw Object.assign(new Error("索引迁移中"), { code: "projection_pending" });
}
