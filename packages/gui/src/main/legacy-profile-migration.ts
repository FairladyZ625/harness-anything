import { app, BrowserWindow, session, type Session } from "electron";
import { migrateLegacyElectronLocalStorage, type LegacyProfileMigrationResult } from "./gui-launch-channel.ts";
import { storageMigrationShimPath } from "./window-config.ts";

export type CompletedLegacyProfileMigrationResult = Exclude<
  LegacyProfileMigrationResult,
  { readonly status: "failed" }
>;

async function closeTransientMigrationWindow(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  await new Promise<void>((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (!win.isDestroyed()) win.destroy();
      done();
    }, 2_000);
    timer.unref?.();
    win.once("closed", done);
    win.close();
  });
}

async function runInMigrationShimWindow<T>(
  shimPath: string,
  targetSession: Session | undefined,
  perform: (win: BrowserWindow) => Promise<T>,
): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    focusable: false,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      ...(targetSession ? { session: targetSession } : {}),
    },
  });
  let crashedReason: string | null = null;
  win.webContents.once("render-process-gone", (_event, details) => {
    crashedReason = `Migration renderer exited unexpectedly (${details.reason}).`;
  });
  try {
    await win.loadFile(shimPath);
    if (crashedReason !== null || win.isDestroyed() || win.webContents.isCrashed()) {
      throw new Error(crashedReason ?? "Migration renderer became unavailable.");
    }
    const result = await perform(win);
    if (crashedReason !== null || win.isDestroyed() || win.webContents.isCrashed()) {
      throw new Error(crashedReason ?? "Migration renderer crashed before completing.");
    }
    return result;
  } finally {
    await closeTransientMigrationWindow(win);
  }
}

/**
 * Copy only Harness-owned localStorage keys when upgrading an unpackaged source install
 * from generic `appData/Electron` to isolated `appData/Harness Anything`, throwing if
 * migration cannot finish cleanly so incomplete profiles never appear finished.
 */
export async function migrateLegacyElectronProfile(): Promise<CompletedLegacyProfileMigrationResult> {
  const shimPath = storageMigrationShimPath();
  const result = await migrateLegacyElectronLocalStorage({
    app,
    readLegacyEntries: async (legacyUserDataDir) => {
      const legacySession = session.fromPath(legacyUserDataDir, { cache: false });
      return runInMigrationShimWindow(shimPath, legacySession, async (win) => {
        const entries: unknown = await win.webContents.executeJavaScript(`(() => {
          const out = {};
          for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key === null) continue;
            const value = localStorage.getItem(key);
            if (value !== null) out[key] = value;
          }
          return out;
        })()`);
        if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
          throw new Error("Legacy profile storage read did not return a key-value object.");
        }
        return entries as Readonly<Record<string, string>>;
      });
    },
    writeMissingTargetEntries: async (_targetUserDataDir, entries) => {
      const serializedEntries = JSON.stringify(JSON.stringify(entries));
      const written = await runInMigrationShimWindow(shimPath, undefined, async (win) => {
        const count: unknown = await win.webContents.executeJavaScript(`(() => {
          const items = JSON.parse(${serializedEntries});
          let applied = 0;
          for (const [key, value] of items) {
            if (localStorage.getItem(key) === null) {
              localStorage.setItem(key, value);
              applied += 1;
            }
          }
          return applied;
        })()`);
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
          throw new Error("Legacy profile storage write did not return an applied entry count.");
        }
        return count;
      });
      await session.defaultSession.flushStorageData();
      return written;
    },
  });
  if (result.status === "failed") {
    throw new Error(`Legacy Electron profile migration failed: ${result.detail}`);
  }
  return result;
}
