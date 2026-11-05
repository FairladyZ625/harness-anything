// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { watchLinuxWorkspace } from "../src/runtime-workspace-watch-linux.ts";

test(
  "Linux workspace watch follows a symlinked root, directory changes, and file links",
  {
    skip: process.platform !== "linux" ? "requires Linux non-recursive fs.watch semantics" : false,
    timeout: 20_000,
  },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-watch-linux-")),
      root = path.join(parent, "root"),
      realRoot = path.join(parent, "real-root"),
      outside = path.join(parent, "outside");
    mkdirSync(path.join(realRoot, "old"), { recursive: true });
    symlinkSync(realRoot, root, "dir");
    writeFileSync(path.join(root, "old", "file"), "initial");
    writeFileSync(outside, "initial");
    symlinkSync(outside, path.join(root, "link"));
    linkSync(outside, path.join(root, "hardlink"));
    let next: ((name: string) => void) | undefined;
    const monitor = watchLinuxWorkspace(root, (_event, filename) => next?.(String(filename)));
    const change = (expected: string, action: () => void): Promise<void> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`missing ${expected}`)), 5_000);
        next = (name) => {
          if (name !== expected) return;
          next = undefined;
          clearTimeout(timeout);
          resolve();
        };
        action();
      });
    try {
      await change("old/file", () => writeFileSync(path.join(root, "old", "file"), "updated"));
      await change("new", () => mkdirSync(path.join(root, "new")));
      await change("new/file", () => writeFileSync(path.join(root, "new", "file"), "created"));
      await change("link", () => writeFileSync(outside, "updated"));
      await change("hardlink", () => writeFileSync(outside, "updated again"));
      await change("moved", () => renameSync(path.join(root, "old"), path.join(root, "moved")));
      await change("moved/file", () => writeFileSync(path.join(root, "moved", "file"), "updated again"));
    } finally {
      monitor.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

for (const code of ["ENOENT", "EACCES"] as const) {
  test(`opening a vanished entry handles ${code} without losing other failures`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-watch-race-")),
      child = path.join(root, "file"),
      failure = Object.assign(new Error("watch failed"), { code }),
      watcher = Object.assign(new EventEmitter(), { close: () => undefined });
    writeFileSync(child, "created");
    t.mock.method(fs, "watch", (target: unknown) => {
      if (String(target) === child) throw failure;
      return watcher;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    });
    if (code === "ENOENT") watchLinuxWorkspace(root, () => undefined).close();
    else
      assert.throws(
        () => watchLinuxWorkspace(root, () => undefined),
        (error) => error === failure,
      );
  });
}

test("a native watcher error retains the original failure", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-watch-error-")),
    watcher = Object.assign(new EventEmitter(), { close: () => undefined }),
    failure = Object.assign(new Error("watch failed"), { code: "EACCES" });
  t.mock.method(fs, "watch", () => watcher);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  const monitor = watchLinuxWorkspace(root, () => undefined),
    errors: Error[] = [];
  monitor.on("error", (error) => errors.push(error));
  watcher.emit("error", failure);
  monitor.close();
  assert.deepEqual(errors, [failure]);
});
