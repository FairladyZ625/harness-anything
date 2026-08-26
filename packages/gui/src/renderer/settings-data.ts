import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { harnessClient, type SettingsUpdateInput } from "./api-client.ts";

export const settingsQueryKeys = {
  read: (repoId: string) => ["settings", repoId] as const,
};

export function useSettingsQuery(repoId: string) {
  return useQuery({
    queryKey: settingsQueryKeys.read(repoId),
    queryFn: () => harnessClient.getSettings({ repoId }),
    staleTime: 10_000,
  });
}

export function useSettingsMutation(repoId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<SettingsUpdateInput, "repoId" | "idempotencyKey">) =>
      harnessClient.updateSettings({
        repoId,
        ...input,
        idempotencyKey: `settings-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: settingsQueryKeys.read(repoId) }),
  });
}
