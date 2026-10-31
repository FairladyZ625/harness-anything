import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "../../api-client.ts";
import type { DaemonHomeOverviewResult } from "@harness-anything/daemon/protocol";

/** Cross-repository summary used by the original project manager page. */
export const projectOverviewQueryKeys = {
  all: () => ["home", "overview"] as const,
};

export function useProjectOverviewQuery() {
  return useQuery({
    queryKey: projectOverviewQueryKeys.all(),
    queryFn: (): Promise<DaemonHomeOverviewResult> => harnessClient.getHomeOverview(),
    staleTime: 3_000,
    refetchInterval: 5_000,
  });
}
