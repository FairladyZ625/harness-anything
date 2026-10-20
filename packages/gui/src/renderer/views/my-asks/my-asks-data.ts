import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { harnessClient } from "../../api-client.ts";
import { taskQueryKeys } from "../../task-data.ts";
import type { WorkBriefsRead } from "../../../api/renderer-dto.ts";

/**
 * 「你交代的事」读面(daemon `repo.works.briefs.read`,dec_C612E69B7C7E3480A5F9D2CAD3
 * 重构区):状态桶、分句次序与抽屉行全部由 daemon 推导,这里只持有一份切面;挂键在
 * taskQueryKeys.all 前缀下,台账切面换代时的扇出(invalidateLedgerDependents)自动带新。
 */
export function useWorkBriefsQuery(repoId: string | null): UseQueryResult<WorkBriefsRead, Error> {
  const selectedRepoId = repoId ?? "unselected";
  return useQuery({
    queryKey: taskQueryKeys.briefs(selectedRepoId),
    queryFn: () => harnessClient.getWorkBriefs({ repoId: selectedRepoId }),
    enabled: repoId !== null,
    staleTime: 10_000,
  });
}
