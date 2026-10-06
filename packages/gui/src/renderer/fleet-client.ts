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
    if (!isRendererRecord(result) || result.schema !== "daemon.fleet-overview/v1" || result.ok !== true) {
      // 拒绝收据并不总有 error.hint(边缘转发路径只回稳定 code):hint 缺席时把 code
      // 带回视图层,页面按 reason 映射说人话;两个都没有才退到无信息的地名。
      const code =
        isRendererRecord(result) && isRendererRecord(result.error) && typeof result.error.code === "string"
          ? result.error.code
          : null;
      throw new Error(rendererErrorHint(result, code ?? "fleet overview"));
    }
    return result as FleetOverviewRead;
  },
};
