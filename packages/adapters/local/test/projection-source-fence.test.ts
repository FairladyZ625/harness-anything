// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeLocalProjectionSourceFenceReader } from "../src/projection-source-fence.ts";

test("local projection source fence routes only generation-relevant watch events", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-local-fence-"));
  try {
    const authoredRoot = path.join(rootDir, "harness");
    mkdirSync(authoredRoot, { recursive: true });
    execFileSync("git", ["-C", authoredRoot, "init", "-b", "master"], { stdio: "ignore" });
    const watched = new Map<string, {
      readonly emit: (filename: string | null) => void;
      readonly fail: () => void;
      readonly closed: () => boolean;
    }>();
    const watchFactory = ((
      inputPath: string,
      _options: { readonly recursive?: boolean },
      listener: (eventType: "rename" | "change", filename: string | Buffer | null) => void
    ) => {
      let isClosed = false;
      const emitter = new EventEmitter();
      const watcher = Object.assign(emitter, {
        close: () => { isClosed = true; },
        ref: () => watcher,
        unref: () => watcher
      });
      watched.set(realpathSync(inputPath), {
        emit: (filename) => listener("change", filename),
        fail: () => emitter.emit("error", new Error("EMFILE: too many open files, watch")),
        closed: () => isClosed
      });
      return watcher;
    }) as typeof import("node:fs").watch;
    const reader = makeLocalProjectionSourceFenceReader({ rootDir, watchFactory });
    const resolvedAuthoredRoot = realpathSync(authoredRoot);
    const authoredWatcher = watched.get(resolvedAuthoredRoot);
    const gitWatcher = watched.get(realpathSync(path.join(resolvedAuthoredRoot, ".git")));
    assert.ok(authoredWatcher);
    assert.ok(gitWatcher);
    let hints = 0;
    reader.subscribe?.(() => { hints += 1; });

    authoredWatcher.emit(".git/index");
    gitWatcher.emit("objects/01/ignored");
    assert.equal(hints, 0);
    authoredWatcher.emit("tasks/task-1/INDEX.md");
    gitWatcher.emit("index");
    gitWatcher.fail();
    assert.equal(hints, 3);

    reader.close?.();
    assert.equal(authoredWatcher.closed(), true);
    assert.equal(gitWatcher.closed(), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
