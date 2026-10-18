import { autoUpdater } from "electron-updater";
import { app } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import {
  UPDATE_CHECK_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  UPDATE_STATUS_EVENT,
  type UpdateState,
} from "../api/update-contract.ts";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

export function registerUpdaterIpc(
  registrar: {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>) => void;
  },
  mainWindow: BrowserWindow,
  trustPolicy: IpcWebContentsTrustPolicy,
): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  const channel = app.getVersion().includes("-") ? "beta" : "stable";
  autoUpdater.setFeedURL({ provider: "generic", url: `https://harness-update.qianbaner.top/${channel}/` });
  let current: UpdateState = { state: "idle" };
  const publish = (status: UpdateState) => {
    current = status;
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(UPDATE_STATUS_EVENT, status);
  };
  autoUpdater.on("checking-for-update", () => publish({ state: "checking" }));
  autoUpdater.on("update-not-available", () => publish({ state: "not-available" }));
  autoUpdater.on("update-available", (info) => publish({ state: "available", version: info.version }));
  autoUpdater.on("update-downloaded", (info) => publish({ state: "downloaded", version: info.version }));
  autoUpdater.on("error", (error) => publish({ state: "error", message: error.message }));
  registrar.handle(UPDATE_STATUS_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    if (payload !== null && payload !== undefined) throw new Error("Update status does not accept a payload.");
    return current;
  });
  registrar.handle(UPDATE_CHECK_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    if (payload !== null && payload !== undefined) throw new Error("Update check does not accept a payload.");
    publish({ state: "checking" });
    const result = await autoUpdater.checkForUpdates();
    if (result?.updateInfo) await autoUpdater.downloadUpdate();
    return current;
  });
  registrar.handle(UPDATE_INSTALL_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    if (payload !== null && payload !== undefined) throw new Error("Update install does not accept a payload.");
    autoUpdater.quitAndInstall();
  });
}
