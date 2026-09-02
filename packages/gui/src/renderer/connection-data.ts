import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchConnectionStatus,
  probeConnection,
  registerConnection,
  registerRepo,
  unregisterConnection,
  unregisterRepo,
  updateConnection,
  updateRepo,
} from "./connection-admin-client.ts";
import { systemQueryKeys } from "./system-data.ts";

/** 连接/仓库 admin 的读键:与 systemQueryKeys 同级,改动后两者都失效。 */
export const connectionQueryKeys = {
  status: () => ["connections", "status"] as const,
  probe: (endpoint: string) => ["connections", "probe", endpoint] as const,
};

export function useConnectionsQuery() {
  return useQuery({
    queryKey: connectionQueryKeys.status(),
    queryFn: () => fetchConnectionStatus(),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

/** admin 写后的统一失效:连接面与仓库面(gui-system-status)一起刷新。 */
async function invalidateAdminSurfaces(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: connectionQueryKeys.status() }),
    queryClient.invalidateQueries({ queryKey: systemQueryKeys.status() }),
  ]);
}

export function useConnectionMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => invalidateAdminSurfaces(queryClient);
  const probe = useMutation({
    mutationFn: (endpoint: string) => probeConnection(endpoint),
  });
  const register = useMutation({
    mutationFn: (input: Parameters<typeof registerConnection>[0]) => registerConnection(input),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (input: Parameters<typeof updateConnection>[0]) => updateConnection(input),
    onSuccess: invalidate,
  });
  const unregister = useMutation({
    mutationFn: (connectionId: string) => unregisterConnection(connectionId),
    onSuccess: invalidate,
  });
  return { probe, register, update, unregister };
}

export function useRepoAdminMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => invalidateAdminSurfaces(queryClient);
  const register = useMutation({
    mutationFn: (input: Parameters<typeof registerRepo>[0]) => registerRepo(input),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (input: Parameters<typeof updateRepo>[0]) => updateRepo(input),
    onSuccess: invalidate,
  });
  const unregister = useMutation({
    mutationFn: (repoId: string) => unregisterRepo(repoId),
    onSuccess: invalidate,
  });
  return { register, update, unregister };
}
