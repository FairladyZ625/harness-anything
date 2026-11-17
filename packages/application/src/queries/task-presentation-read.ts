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
