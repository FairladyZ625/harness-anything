import type { DaemonTaskDispatchesPayload } from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow } from "../api/renderer-dto.ts";
import { harnessClient, type TaskDispatchBatchRead } from "./api-client.ts";
import { drainCursorPages } from "./paginated-read.ts";
const TASK_DISPATCH_PAGE_LIMIT = 16;

type TaskDispatchSelection = { readonly repoId: string } & Pick<DaemonTaskDispatchesPayload, "advisorySurface"> &
  (
    | { readonly taskId: string; readonly taskIds?: never }
    | { readonly taskIds: readonly string[]; readonly taskId?: never }
  );

/** Complete GUI task history, with bounded requests/replies and the daemon's opaque cursor.
 * Member windows keep their separate limit/truncated contract. */
export async function readAllTaskDispatches(payload: TaskDispatchSelection): Promise<{
  readonly dispatches: readonly TaskDispatchProjectionRow[];
}> {
  const taskIds = [...new Set(payload.taskId === undefined ? payload.taskIds : [payload.taskId])].sort();
  const rows = new Map<string, TaskDispatchProjectionRow>();
  for (let offset = 0; offset < taskIds.length; offset += TASK_DISPATCH_PAGE_LIMIT) {
    const pages = await drainCursorPages(async (facets) => {
      const read = await harnessClient.getTaskDispatches({
        repoId: payload.repoId,
        taskIds: taskIds.slice(offset, offset + TASK_DISPATCH_PAGE_LIMIT),
        limit: TASK_DISPATCH_PAGE_LIMIT,
        ...(payload.advisorySurface === undefined ? {} : { advisorySurface: payload.advisorySurface }),
        ...facets,
      });
      // Batch listings degrade missing tasks per row. A single-task detail used
      // to reject that same absence; retain its error instead of showing no history.
      if (
        payload.taskId !== undefined &&
        "unavailableTaskIds" in read &&
        read.status === "ready" &&
        read.unavailableTaskIds.includes(payload.taskId)
      )
        throw Object.assign(new Error(`Task ${payload.taskId} has no projected package.`), { code: "task_not_found" });
      return read as TaskDispatchBatchRead;
    }, "task dispatches");
    for (const page of pages) for (const row of page.dispatches) rows.set(row.dispatchId, row);
  }
  return {
    dispatches: [...rows.values()].sort(
      (left, right) => left.startedAt.localeCompare(right.startedAt) || left.dispatchId.localeCompare(right.dispatchId),
    ),
  };
}
