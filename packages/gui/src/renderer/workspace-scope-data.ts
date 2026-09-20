import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { WorkspaceScopeRead } from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";

export const workspaceScopeQueryKeys = {
  read: (repoId: string, rootTaskId: string) => ["workspace-scope", repoId, rootTaskId] as const,
};

export function useWorkspaceScopeQuery(
  repoId: string | null,
  rootTaskId: string | null,
): UseQueryResult<WorkspaceScopeRead, Error> {
  return useQuery({
    queryKey: workspaceScopeQueryKeys.read(repoId ?? "unselected", rootTaskId ?? "unselected"),
    queryFn: () =>
      harnessClient.getWorkspaceScope({
        repoId: repoId ?? "unselected",
        rootTaskId: rootTaskId ?? "unselected",
        limit: 100,
      }),
    staleTime: 4_000,
    enabled: repoId !== null && rootTaskId !== null,
  });
}
