// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BrowserWindow } from "electron";
import { APP_COMMAND_CHANNEL } from "../src/api/app-command-contract.ts";
import { bindMainWindowAppCommand } from "../src/main/main-window-app-command.ts";

class MockBrowserWindow extends EventEmitter {
  destroyed = false;
  readonly sent: unknown[][] = [];
  readonly rawWebContents = {
    isDestroyed: () => this.destroyed,
    send: (...args: unknown[]) => this.sent.push(args),
  };

  isDestroyed(): boolean {
    return this.destroyed;
  }

  get webContents() {
    if (this.destroyed) throw new TypeError("Object has been destroyed");
    return this.rawWebContents;
  }
}

test("a live main window forwards supported app commands", () => {
  const window = new MockBrowserWindow();
  bindMainWindowAppCommand(window as unknown as BrowserWindow);

  window.emit("app-command", {}, "browser-backward");
  window.emit("app-command", {}, "browser-forward");
  window.emit("app-command", {}, "other");

  assert.deepEqual(window.sent, [
    [APP_COMMAND_CHANNEL, "back"],
    [APP_COMMAND_CHANNEL, "forward"],
  ]);
});

test("an app command queued before close is ignored after the window is destroyed", () => {
  const window = new MockBrowserWindow();
  bindMainWindowAppCommand(window as unknown as BrowserWindow);
  window.destroyed = true;

  assert.doesNotThrow(() => window.emit("app-command", {}, "browser-backward"));
  assert.deepEqual(window.sent, []);
});
