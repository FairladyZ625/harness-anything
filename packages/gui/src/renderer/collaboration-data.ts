import { useQuery } from "@tanstack/react-query";
import { fleetClient } from "./fleet-client.ts";
import type { FleetOverviewRead } from "../api/renderer-dto.ts";

/**
 * 协作页舰队拓扑的读面(task_8ce646d94):`repo.fleet.overview.read` 一条 typed read,
 * daemon 侧聚合节点、副本通道、每节点租约/派工、内部状态三态字段与 canonical 事件
 * 窗口。页面挂载时读,不轮询;读失败与加载是页面显式状态,不在视图内兜底成空拓扑。
 */
export function useFleetOverview(
  repoId: string | null,
  enabled: boolean,
): { readonly overview: FleetOverviewRead | null; readonly error: string | null; readonly loading: boolean } {
  const selectedRepoId = repoId ?? "unselected",
    query = useQuery({
      queryKey: ["fleet-overview", selectedRepoId],
      queryFn: () => fleetClient.overview(selectedRepoId),
      enabled: enabled && repoId !== null,
      staleTime: 4_000,
    });
  return {
    overview: query.data ?? null,
    error: query.isError ? (query.error instanceof Error ? query.error.message : String(query.error)) : null,
    loading: query.isPending && query.fetchStatus === "fetching",
  };
}
