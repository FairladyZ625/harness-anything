import { useQueries } from "@tanstack/react-query";
import { harnessClient } from "./api-client.ts";
import type { TaskDispatchProjectionRow } from "../api/renderer-dto.ts";
import type { AgendaRow } from "./model/agenda-rows.ts";

/** Batched reads use the same dispatch projection as task detail and CLI, including on edges. */
export function useAgendaAdvisories(
  repoId: string,
  rows: readonly AgendaRow[],
): {
  readonly advisories: ReadonlyMap<string, NonNullable<TaskDispatchProjectionRow["advisories"]>>;
  readonly error: Error | null | undefined;
} {
  const taskIds = [
    ...new Set(
      rows.flatMap((row) => {
        const match = /^task(?:review)?\/([^/]+)/u.exec(row.target ?? "");
        return match ? [match[1]!] : [];
      }),
    ),
  ].sort();
  const batches: string[][] = [];
  for (let offset = 0; offset < taskIds.length; offset += 500) batches.push(taskIds.slice(offset, offset + 500));
  const queries = useQueries({
    queries: batches.map((ids) => ({
      queryKey: ["dispatches", repoId, "agenda", ids],
      queryFn: () => readAgendaDispatches(repoId, ids),
      staleTime: 4_000,
    })),
  });
  const advisories = new Map<string, NonNullable<TaskDispatchProjectionRow["advisories"]>>();
  for (const query of queries)
    for (const row of query.data ?? []) {
      if (row.advisories?.length)
        advisories.set(row.taskId, [...(advisories.get(row.taskId) ?? []), ...row.advisories]);
    }
  return { advisories, error: queries.find((query) => query.error)?.error };
}

export async function readAgendaDispatches(
  repoId: string,
  taskIds: readonly string[],
): Promise<readonly TaskDispatchProjectionRow[]> {
  const rows: TaskDispatchProjectionRow[] = [];
  let cursor: string | null = null;
  do {
    const read = await harnessClient.getTaskDispatches({
      repoId,
      taskIds,
      limit: 500,
      advisorySurface: "agenda",
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...read.dispatches);
    cursor = "page" in read ? read.page.nextCursor : null;
  } while (cursor !== null);
  return rows;
}
