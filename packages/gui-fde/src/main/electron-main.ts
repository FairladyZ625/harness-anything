import net from "node:net";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { startFdeStudioServer, type FdeStudioServer } from "../server/fde-server.ts";

let activeServer: FdeStudioServer | null = null;

function notifyLaunchReadiness(payload: Record<string, unknown>): Promise<void> {
  const addr = process.env.HARNESS_FDE_LAUNCH_ADDR;
  const token = process.env.HARNESS_FDE_LAUNCH_TOKEN;
  if (!addr || !token) return Promise.resolve();
  const [host, portText] = addr.split(":");
  const port = Number(portText);
  if (!host || !Number.isInteger(port)) return Promise.resolve();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.end(`${JSON.stringify({ token, ...payload })}\n`);
    });
    socket.once("close", () => resolve());
    socket.once("error", () => resolve());
  });
}

async function createWorkbenchWindow(): Promise<void> {
  const rootDir = path.resolve(process.env.HARNESS_FDE_ROOT ?? process.cwd());
  const headless = process.env.HARNESS_FDE_HEADLESS === "1";
  const distDir = path.resolve(import.meta.dirname, "../dist");
  activeServer = await startFdeStudioServer({ rootDir, distDir });
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: !headless,
    title: "Harness Anything — FDE Domain Studio",
    webPreferences: {
      preload: path.resolve(import.meta.dirname, "electron-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  await win.loadURL(activeServer.url);
  await notifyLaunchReadiness({ ok: true, mode: headless ? "headless" : "window", pid: process.pid });
}

void app.whenReady().then(async () => {
  try {
    await createWorkbenchWindow();
  } catch (error) {
    await notifyLaunchReadiness({
      ok: false,
      reason: "fde_launch_failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    app.quit();
  }
});

app.on("window-all-closed", () => {
  void activeServer?.close().finally(() => app.quit());
});
