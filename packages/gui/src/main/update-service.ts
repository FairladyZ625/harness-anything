import type { IpcMainInvokeEvent } from "electron";
import {
  UPDATE_CHECK_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  UPDATE_STATUS_EVENT,
  type UpdateState,
} from "../api/update-contract.ts";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

type UpdateCheckOutcome = { readonly isUpdateAvailable: boolean; readonly updateInfo?: { readonly version: string } };

// electron-updater 的 autoUpdater 惰性加载 electron 运行时,纯 node 导不进来,由主进程注入、测试传 stub。
export interface UpdaterController {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(options: { provider: "generic"; url: string }): void;
  on(event: "checking-for-update", listener: () => void): void;
  on(event: "update-not-available", listener: () => void): void;
  on(event: "update-available", listener: (info: { version: string }) => void): void;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  checkForUpdates(): Promise<UpdateCheckOutcome | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export function registerUpdaterIpc(
  registrar: {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>) => void;
  },
  mainWindow: { isDestroyed(): boolean; webContents: { send(channel: string, status: UpdateState): void } },
  trustPolicy: IpcWebContentsTrustPolicy,
  updater: UpdaterController,
  appVersion: string,
): void {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  const channel = appVersion.includes("-") ? "beta" : "stable";
  updater.setFeedURL({ provider: "generic", url: `https://harness-update.qianbaner.top/${channel}/` });
  let current: UpdateState = { state: "idle" };
  const publish = (status: UpdateState) => {
    current = status;
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(UPDATE_STATUS_EVENT, status);
  };
  updater.on("checking-for-update", () => publish({ state: "checking" }));
  updater.on("update-not-available", () => publish({ state: "not-available" }));
  updater.on("update-available", (info) => publish({ state: "available", version: info.version }));
  updater.on("update-downloaded", (info) => publish({ state: "downloaded", version: info.version }));
  updater.on("error", (error) => publish({ state: "error", message: error.message }));
  registrar.handle(UPDATE_STATUS_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    if (payload !== null && payload !== undefined) throw new Error("Update status does not accept a payload.");
    return current;
  });
  registrar.handle(UPDATE_CHECK_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    if (payload !== null && payload !== undefined) throw new Error("Update check does not accept a payload.");
    publish({ state: "checking" });
    const result = await updater.checkForUpdates();
    if (result?.isUpdateAvailable) await updater.downloadUpdate();
    return current;
  });
  registrar.handle(UPDATE_INSTALL_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    if (payload !== null && payload !== undefined) throw new Error("Update install does not accept a payload.");
    updater.quitAndInstall();
  });
}
