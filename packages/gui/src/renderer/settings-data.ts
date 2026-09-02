import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { harnessClient, type SettingsUpdateInput } from "./api-client.ts";

export const settingsQueryKeys = {
  read: (repoId: string) => ["settings", repoId] as const,
};

export function useSettingsQuery(repoId: string | null) {
  return useQuery({
    queryKey: settingsQueryKeys.read(repoId ?? "unselected"),
    queryFn: () => harnessClient.getSettings({ repoId: repoId! }),
    staleTime: 10_000,
    // 无仓(首次运行空态)不发起仓库设置读;仓库与连接页不依赖它。
    enabled: repoId !== null,
  });
}

export function useSettingsMutation(repoId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<SettingsUpdateInput, "repoId" | "idempotencyKey">) => {
      if (repoId === null) throw new Error("Repository settings require a selected repository.");
      return harnessClient.updateSettings({
        repoId,
        ...input,
        idempotencyKey: `settings-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      });
    },
    onSuccess: async () => {
      if (repoId !== null) await queryClient.invalidateQueries({ queryKey: settingsQueryKeys.read(repoId) });
    },
  });
}
