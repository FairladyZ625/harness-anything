// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_CHECK_CHANNEL, UPDATE_STATUS_EVENT, type UpdateState } from "../src/api/update-contract.ts";
import { registerUpdaterIpc, type UpdaterController } from "../src/main/update-service.ts";

/**
 * 更新 IPC 契约(app-auto-update 迭代2 返工 F1):electron-updater 6.8.9 无更新时
 * checkForUpdates 仍返回 updateInfo,只有 isUpdateAvailable 才允许 downloadUpdate——
 * 无更新不进 error 也不下载,有更新走 available→downloaded。
 */

const trustedEvent = {
  sender: { id: 7 },
  senderFrame: { url: "file:///Applications/Harness/renderer/index.html" },
};
const trustPolicy = {
  isTrustedWebContentsId: (id: number) => id === 7,
  rendererUrl: { packagedRendererUrl: trustedEvent.senderFrame.url },
};
const APP_VERSION = "1.4.2";

class StubUpdater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  downloads = 0;
  private readonly listeners = new Map<string, Array<(argument?: unknown) => void>>();

  private readonly availableVersion: string | null;

  constructor(availableVersion: string | null) {
    this.availableVersion = availableVersion;
  }

  on(event: string, listener: (argument?: unknown) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  private emit(event: string, argument?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(argument);
  }

  async checkForUpdates() {
    if (this.availableVersion === null) this.emit("update-not-available");
    else this.emit("update-available", { version: this.availableVersion });
    return {
      isUpdateAvailable: this.availableVersion !== null,
      updateInfo: { version: this.availableVersion ?? APP_VERSION },
    };
  }

  async downloadUpdate() {
    if (this.availableVersion === null) throw new Error("no update available to download");
    this.downloads += 1;
    this.emit("update-downloaded", { version: this.availableVersion });
    return [] as string[];
  }

  setFeedURL(): void {}
  quitAndInstall(): void {}
}

function register(updater: UpdaterController) {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const sent: UpdateState[] = [];
  registerUpdaterIpc(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener as never);
      },
    },
    {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, status: UpdateState) => {
          if (channel === UPDATE_STATUS_EVENT) sent.push(status);
        },
      },
    },
    trustPolicy,
    updater,
    APP_VERSION,
  );
  return {
    invoke: (channel: string) => handlers.get(channel)!(trustedEvent, null),
    sent,
  };
}

test("update check without a newer version reports not-available and never downloads", async () => {
  const updater = new StubUpdater(null);
  const api = register(updater);
  const status = (await api.invoke(UPDATE_CHECK_CHANNEL)) as UpdateState;
  assert.equal(status.state, "not-available");
  assert.equal(updater.downloads, 0);
  assert.deepEqual(
    api.sent.map((state) => state.state),
    ["checking", "not-available"],
  );
});

test("update check with a newer version downloads it and reports downloaded", async () => {
  const updater = new StubUpdater("1.5.0");
  const api = register(updater);
  const status = (await api.invoke(UPDATE_CHECK_CHANNEL)) as UpdateState;
  assert.equal(status.state, "downloaded");
  assert.equal(status.version, "1.5.0");
  assert.equal(updater.downloads, 1);
  assert.deepEqual(
    api.sent.map((state) => state.state),
    ["checking", "available", "downloaded"],
  );
});
