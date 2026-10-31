import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { WorkBriefsRead } from "../../../api/renderer-dto.ts";
import { harnessClient } from "../../api-client.ts";
import { taskQueryKeys } from "../../task-data.ts";

export function useOverviewBriefsQuery(repoId: string | null): UseQueryResult<WorkBriefsRead, Error> {
  const selectedRepoId = repoId ?? "unselected";
  return useQuery({
    queryKey: taskQueryKeys.briefs(selectedRepoId),
    queryFn: () => harnessClient.getWorkBriefs({ repoId: selectedRepoId }),
    enabled: repoId !== null,
    staleTime: 10_000,
  });
}
