import {
  EDGE_UPGRADE_PROGRESS_EVENT,
  EDGE_UPGRADE_RELAUNCH_CHANNEL,
  EDGE_UPGRADE_RUN_CHANNEL,
  EDGE_UPGRADE_STATUS_CHANNEL,
  type EdgeUpgradeGuiApi,
  type EdgeUpgradeGuiProgress,
  type EdgeUpgradeGuiReceipt,
  type EdgeUpgradeGuiRunInput,
  type EdgeUpgradeGuiStatus,
} from "../api/edge-upgrade-contract.ts";

export function edgeUpgradePreloadApi(
  invoke: (channel: string, request: unknown) => Promise<unknown>,
  on: (channel: string, listener: (payload: unknown) => void) => () => void,
): EdgeUpgradeGuiApi {
  return {
    status: (repoId?: string) =>
      invoke(EDGE_UPGRADE_STATUS_CHANNEL, repoId ? { repoId } : null) as Promise<EdgeUpgradeGuiStatus>,
    run: (input?: EdgeUpgradeGuiRunInput) =>
      invoke(EDGE_UPGRADE_RUN_CHANNEL, input ?? {}) as Promise<EdgeUpgradeGuiReceipt>,
    relaunch: () => invoke(EDGE_UPGRADE_RELAUNCH_CHANNEL, null) as Promise<void>,
    onProgress: (listener: (progress: EdgeUpgradeGuiProgress) => void) =>
      on(EDGE_UPGRADE_PROGRESS_EVENT, (payload) => {
        if (typeof payload === "object" && payload !== null && "stage" in payload && "message" in payload) {
          listener(payload as EdgeUpgradeGuiProgress);
        }
      }),
  };
}
