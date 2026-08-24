import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "./api-client.ts";

export const workspaceSummaryQueryKeys = {
  read: (repoId: string) => ["workspace-summary", repoId] as const
};

export function workspaceSummaryQuery(repoId: string) {
  return {
    queryKey: workspaceSummaryQueryKeys.read(repoId),
    queryFn: () => harnessClient.getWorkspaceSummary({ repoId }),
    staleTime: 10_000,
    refetchOnWindowFocus: "always" as const
  };
}

export function useWorkspaceSummaryQuery(repoId: string | null) {
  const selectedRepoId = repoId ?? "unselected";
  return useQuery({
    ...workspaceSummaryQuery(selectedRepoId),
    enabled: repoId !== null
  });
}
