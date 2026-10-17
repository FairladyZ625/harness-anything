import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "../../api-client.ts";
import type { DaemonHomeOverviewResult } from "@harness-anything/daemon/protocol";

export const homeOverviewQueryKeys = {
  all: () => ["home", "overview"] as const,
};

export function homeOverviewQuery() {
  return {
    queryKey: homeOverviewQueryKeys.all(),
    queryFn: (): Promise<DaemonHomeOverviewResult> => harnessClient.getHomeOverview(),
    staleTime: 3_000,
    refetchInterval: 5_000,
  };
}

export function useHomeOverviewQuery() {
  return useQuery(homeOverviewQuery());
}
