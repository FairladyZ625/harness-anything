import type { BrowserWindow } from "electron";
import { APP_COMMAND_CHANNEL, type AppNavigationCommand } from "../api/app-command-contract.ts";

export function bindMainWindowAppCommand(mainWindow: BrowserWindow): void {
  mainWindow.on("app-command", (_event, command) => {
    if (mainWindow.isDestroyed()) return;
    const webContents = mainWindow.webContents;
    if (webContents.isDestroyed()) return;
    const navigation: AppNavigationCommand | null =
      command === "browser-backward" ? "back" : command === "browser-forward" ? "forward" : null;
    if (navigation) webContents.send(APP_COMMAND_CHANNEL, navigation);
  });
}
