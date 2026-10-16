import {
  PROJECT_WINDOW_ACTIVE_CHANNEL,
  PROJECT_WINDOW_OPEN_CHANNEL,
  isProjectWindowRepoId,
} from "../api/project-window-contract.ts";
import { assertTrustedIpcSender, type HarnessIpcRegistrar } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

/**
 * 项目窗口 IPC(task_ca1ee6b9e8f83c89cb376e5f07):renderer → 主进程两条通道,载荷
 * 只认 repoId(与 project-directory-ipc 同一形状判据);setActiveProject 的窗口身份
 * 取自 event.sender.id,renderer 无法替别的窗口上报。
 */
export function registerProjectWindowIpc(
  registrar: Pick<HarnessIpcRegistrar, "handle">,
  services: {
    readonly openProjectWindow: (repoId: string | null) => unknown;
    readonly setActiveProject: (webContentsId: number, repoId: string | null) => void;
  },
  trustPolicy: IpcWebContentsTrustPolicy,
): void {
  registrar.handle(PROJECT_WINDOW_OPEN_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const repoId = checkedRepoIdPayload(payload, false);
    services.openProjectWindow(repoId);
  });
  registrar.handle(PROJECT_WINDOW_ACTIVE_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    services.setActiveProject(event.sender.id, checkedRepoIdPayload(payload, true));
  });
}

function checkedRepoIdPayload(value: unknown, allowNull: boolean): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("repoId" in value)
  )
    throw new Error(`Set project window payload must be exactly { repoId }${allowNull ? " or null" : ""}.`);
  const repoId = (value as { readonly repoId: unknown }).repoId;
  if (repoId === null && allowNull) return null;
  if (!isProjectWindowRepoId(repoId)) throw new Error("Project window payload requires an exact repoId.");
  return repoId;
}
