import type { DaemonTaskDispatchesPayload } from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow } from "../api/renderer-dto.ts";
import { harnessClient, type TaskDispatchBatchRead } from "./api-client.ts";
import { drainCursorPages } from "./paginated-read.ts";

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
  for (let offset = 0; offset < taskIds.length; offset += 500) {
    const pages = await drainCursorPages(
      async (facets) =>
        (await harnessClient.getTaskDispatches({
          repoId: payload.repoId,
          taskIds: taskIds.slice(offset, offset + 500),
          limit: 16,
          ...(payload.advisorySurface === undefined ? {} : { advisorySurface: payload.advisorySurface }),
          ...facets,
        })) as TaskDispatchBatchRead,
      "task dispatches",
    );
    for (const page of pages) for (const row of page.dispatches) rows.set(row.dispatchId, row);
  }
  return { dispatches: [...rows.values()] };
}
