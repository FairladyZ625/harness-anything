import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "./api-client.ts";

/**
 * 单条 Decision 的完整读(decision-show includeBody):正文页签与评审切面共用同一个查询键,
 * 一次读同时给出正文、当前评审切面摘要与 accept 就绪判定——列表读面不带正文,算不出这两项。
 */
export const decisionShowQueryKeys = {
  repo: (repoId: string) => ["decision-body", repoId] as const,
  one: (repoId: string, decisionId: string) => ["decision-body", repoId, decisionId] as const,
};

export function useDecisionShowQuery(repoId: string, decisionId: string) {
  return useQuery({
    queryKey: decisionShowQueryKeys.one(repoId, decisionId),
    queryFn: () => harnessClient.showDecision({ repoId, decisionId, includeBody: true }),
    enabled: decisionId !== "",
    staleTime: 10_000,
  });
}
