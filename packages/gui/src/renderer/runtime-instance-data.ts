import type { QueryClient } from "@tanstack/react-query";
import { runtimeInstanceClient } from "./runtime-instance-client.ts";

export const runtimeInstanceCatalogQueryKey = ["runtime-instances", "machine"] as const;

export function runtimeInstanceCatalogQuery(repoId?: string) {
  return {
    queryKey: repoId === undefined ? runtimeInstanceCatalogQueryKey : [...runtimeInstanceCatalogQueryKey, repoId],
    queryFn: () => runtimeInstanceClient.list(repoId),
    staleTime: 2_000,
    // Startup prewarm has no observer until a runtime page opens. Retain that result for the GUI
    // session so a stale catalog can paint immediately while React Query refreshes it.
    gcTime: Infinity,
  };
}

export function prewarmRuntimeInstanceCatalog(client: QueryClient): Promise<void> {
  return client.prefetchQuery(runtimeInstanceCatalogQuery());
}
