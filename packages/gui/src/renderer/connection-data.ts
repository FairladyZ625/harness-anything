import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchConnectionStatus,
  probeConnection,
  registerConnection,
  registerRepo,
  unregisterConnection,
  unbindRepo,
  updateConnection,
  updateRepo,
} from "./connection-admin-client.ts";
import { QUERY_PACING_MS } from "./query-pacing.ts";
import { systemQueryKeys } from "./system-data.ts";

/** 连接/仓库 admin 的读键:与 systemQueryKeys 同级,改动后两者都失效。 */
export const connectionQueryKeys = {
  status: () => ["connections", "status"] as const,
  probe: (endpoint: string) => ["connections", "probe", endpoint] as const,
};

/** admin 连接状态读:台账 cut 覆盖不到,自持低频轮询,admin 写后再统一失效。 */
export function connectionsQuery() {
  return {
    queryKey: connectionQueryKeys.status(),
    queryFn: () => fetchConnectionStatus(),
    staleTime: 10_000,
    refetchInterval: QUERY_PACING_MS.connectionStatus,
  };
}

export function useConnectionsQuery() {
  return useQuery(connectionsQuery());
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
    mutationFn: (repoId: string) => unbindRepo(repoId),
    onSuccess: invalidate,
  });
  return { register, update, unregister };
}
