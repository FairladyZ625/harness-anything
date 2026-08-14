import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { harnessClient } from "./api-client.ts";

export const catalogQueryKeys = {
  all: (repoId: string) => ["catalog", repoId] as const,
  snapshot: (repoId: string) => ["catalog", repoId, "snapshot"] as const,
  preset: (repoId: string, presetId: string, locale: string) => ["catalog", repoId, "preset", presetId, locale] as const,
};

export function useCatalogSnapshot(repoId: string | null) {
  return useQuery({ queryKey: catalogQueryKeys.snapshot(repoId ?? "unselected"), queryFn: () => harnessClient.getCatalogSnapshot({ repoId: repoId! }), enabled: repoId !== null, staleTime: 10_000 });
}

export function useCatalogPreset(repoId: string, presetId: string | null, locale: string) {
  return useQuery({ queryKey: catalogQueryKeys.preset(repoId, presetId ?? "unselected", locale), queryFn: () => harnessClient.getCatalogPreset({ repoId, presetId: presetId!, locale }), enabled: presetId !== null, staleTime: 10_000 });
}

export function useCatalogReread(repoId: string, expectedDigest: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: () => harnessClient.rereadCatalog({ repoId, ...(expectedDigest ? { expectedDigest } : {}) }), onSuccess: async (receipt) => {
    if (receipt.ok && receipt.outcome === "applied") await queryClient.invalidateQueries({ queryKey: catalogQueryKeys.all(repoId) });
  } });
}
