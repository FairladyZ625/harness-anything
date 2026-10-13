import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fleetClient } from "./fleet-client.ts";
import { QUERY_PACING_MS } from "./query-pacing.ts";
import type { FleetOverviewRead } from "../api/renderer-dto.ts";

/**
 * 协作页舰队拓扑的读面(task_8ce646d94):`repo.fleet.overview.read` 一条 typed read,
 * daemon 侧聚合节点、副本通道、每节点租约/派工、内部状态三态字段与 canonical 事件
 * 窗口。daemon 级聚合读,台账 cut 覆盖不到,自持低频轮询(QUERY_PACING_MS.fleetOverview,
 * 2026-10-13 业主裁定:节点状态随数据自动变化);读失败与加载是页面显式状态,不在视图内
 * 兜底成空拓扑。设备管理写操作落地后用 useInvalidateFleetOverview 把新事实带回来。
 */

export const fleetOverviewKeys = {
  overview: (repoId: string) => ["fleet-overview", repoId] as const,
};

export function fleetOverviewQuery(repoId: string, enabled: boolean) {
  return {
    queryKey: fleetOverviewKeys.overview(repoId),
    // 返回类型显式标注本地别名:靠推断会把 daemon 源文件的深路径带进声明产物(TS2742)。
    queryFn: (): Promise<FleetOverviewRead> => fleetClient.overview(repoId),
    enabled: enabled && repoId !== "unselected",
    staleTime: 4_000,
    refetchInterval: QUERY_PACING_MS.fleetOverview,
  };
}

export function useFleetOverview(
  repoId: string | null,
  enabled: boolean,
): { readonly overview: FleetOverviewRead | null; readonly error: string | null; readonly loading: boolean } {
  const selectedRepoId = repoId ?? "unselected",
    query = useQuery(fleetOverviewQuery(selectedRepoId, enabled));
  return {
    overview: query.data ?? null,
    error: query.isError ? (query.error instanceof Error ? query.error.message : String(query.error)) : null,
    loading: query.isPending && query.fetchStatus === "fetching",
  };
}

/** 设备管理写操作(暂停/移除/退出会话)落地后,立即重读拓扑让节点状态与隐藏集合同步。 */
export function useInvalidateFleetOverview(repoId: string): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: fleetOverviewKeys.overview(repoId) });
  };
}
