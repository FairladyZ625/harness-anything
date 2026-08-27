import { useQuery } from "@tanstack/react-query";
import { harnessClient } from "./api-client.ts";

export function useCiObservatoryQuery(repoId: string | null) {
  return useQuery({
    queryKey: ["ci-observatory", repoId ?? "unselected"],
    queryFn: () => harnessClient.getCiObservatory({ repoId: repoId!, window: 100 }),
    enabled: repoId !== null,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}
