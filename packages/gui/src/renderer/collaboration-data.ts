import { useQuery } from "@tanstack/react-query";
import { fleetClient } from "./fleet-client.ts";
import { QUERY_PACING_MS } from "./query-pacing.ts";
import type { FleetOverviewRead } from "../api/renderer-dto.ts";

/**
 * 协作页舰队拓扑的读面(task_8ce646d94):`repo.fleet.overview.read` 一条 typed read,
 * daemon 侧聚合节点、副本通道、每节点租约/派工、内部状态三态字段与 canonical 事件
 * 窗口。停在页面上时要跟着台账与副本通道走(task_89085c1d5e532a54933b9bf444):该读面
 * 一半是台账派生(租约/派工/事件尾/rev)、一半是 daemon 级状态(副本 lag/ack/delivery,
 * 台账安静期也在走),所以走统一节奏常量的自持轮询(见 query-pacing.ts 分类 2),不挂
 * 台账 cut 扇出——挂扇出会在无人写台账的时段把页面冻回原 bug。失焦时 interval 自动
 * 暂停(react-query 默认),不在协作页时 enabled=false 不读。相对时间(事件「N 分钟前」、
 * 落后秒数)随每次轮询的新 now 在前端重算。读失败与加载是页面显式状态,不在视图内兜底
 * 成空拓扑。
 */
export function fleetOverviewQuery(repoId: string): {
  readonly queryKey: readonly [string, string];
  readonly queryFn: () => Promise<FleetOverviewRead>;
  readonly staleTime: number;
  readonly refetchInterval: number;
} {
  return {
    queryKey: ["fleet-overview", repoId],
    queryFn: () => fleetClient.overview(repoId),
    staleTime: 4_000,
    refetchInterval: QUERY_PACING_MS.fleetOverview,
  };
}

export function useFleetOverview(
  repoId: string | null,
  enabled: boolean,
): { readonly overview: FleetOverviewRead | null; readonly error: string | null; readonly loading: boolean } {
  const selectedRepoId = repoId ?? "unselected",
    query = useQuery({ ...fleetOverviewQuery(selectedRepoId), enabled: enabled && repoId !== null });
  return {
    overview: query.data ?? null,
    error: query.isError ? (query.error instanceof Error ? query.error.message : String(query.error)) : null,
    loading: query.isPending && query.fetchStatus === "fetching",
  };
}
