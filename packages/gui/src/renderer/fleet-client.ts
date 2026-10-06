import type { DaemonGuiReadPayloadMap } from "@harness-anything/daemon/protocol";
import type { FleetOverviewRead } from "../api/renderer-dto.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import { invoke } from "./api-client-invoke.ts";

type RepoScope = { readonly repoId: string };

/**
 * `repo.fleet.overview.read` 的 renderer 入口(task_8ce646d94):协作页舰队拓扑的唯一
 * 数据源——节点、副本通道、每节点租约/派工、内部状态与 canonical 事件窗口都在这一条
 * typed read 里,daemon 侧已完成 join 与诚实三态标注,前端不再从任务列表自行推导。
 */
export const fleetClient = {
  overview: async (repoId: string): Promise<FleetOverviewRead> => {
    const result = await invoke(
      "repo.fleet.overview.read",
      { repoId } as DaemonGuiReadPayloadMap["repo.fleet.overview.read"] & RepoScope,
      "getFleetOverview",
    );
    if (!isRendererRecord(result) || result.schema !== "daemon.fleet-overview/v1" || result.ok !== true)
      throw new Error(rendererErrorHint(result, "fleet overview"));
    return result as FleetOverviewRead;
  },
};
