import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "./api-client.ts";

export const workspaceSummaryQueryKeys = {
  read: (repoId: string) => ["workspace-summary", repoId] as const
};

export function useWorkspaceSummaryQuery(repoId: string | null) {
  const selectedRepoId = repoId ?? "unselected";
  return useQuery({
    queryKey: workspaceSummaryQueryKeys.read(selectedRepoId),
    queryFn: () => harnessClient.getWorkspaceSummary({ repoId: selectedRepoId }),
    enabled: repoId !== null,
    staleTime: 10_000,
    refetchInterval: 2_000,
    refetchOnWindowFocus: "always"
  });
}
