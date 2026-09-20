import { useInfiniteQuery, type InfiniteData, type UseInfiniteQueryResult } from "@tanstack/react-query";
import type { WorkspaceScopeRead } from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";

export const workspaceScopeQueryKeys = {
  read: (repoId: string, rootTaskId: string) => ["workspace-scope", repoId, rootTaskId] as const,
};

export function useWorkspaceScopeQuery(
  repoId: string | null,
  rootTaskId: string | null,
): UseInfiniteQueryResult<InfiniteData<WorkspaceScopeRead, string | null>, Error> {
  return useInfiniteQuery({
    queryKey: workspaceScopeQueryKeys.read(repoId ?? "unselected", rootTaskId ?? "unselected"),
    queryFn: ({ pageParam }) =>
      harnessClient.getWorkspaceScope({
        repoId: repoId ?? "unselected",
        rootTaskId: rootTaskId ?? "unselected",
        limit: 100,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    staleTime: 4_000,
    enabled: repoId !== null && rootTaskId !== null,
  });
}

export function combineWorkspaceScopePages(pages: readonly WorkspaceScopeRead[]): WorkspaceScopeRead | undefined {
  const first = pages[0];
  if (!first) return undefined;
  return {
    ...first,
    tasks: [...new Map(pages.flatMap(({ tasks }) => tasks).map((task) => [task.taskId, task])).values()],
    page: pages.at(-1)?.page ?? first.page,
  };
}
