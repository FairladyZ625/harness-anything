// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { attachActiveRuntime, disposeActiveRuntimeObservations } from "../src/runtime-spawn-active.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import { active } from "./runtime-spawn-settlement.fixtures.ts";

for (const notification of ["rename", "ENOENT", "EPERM"] as const) {
  test(`a removed workspace releases its watcher on ${notification} and retains provider observation`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-observation-")),
      cwd = path.join(root, "workspace");
    mkdirSync(cwd);
    let closed = 0,
      changed: ((event: string, filename: string | null) => void) | undefined;
    const watcher = Object.assign(new EventEmitter(), {
      close: () => {
        closed += 1;
      },
      unref: () => undefined,
    });
    // Exercise the documented Windows EPERM deletion notification on every platform.
    t.mock.method(fs, "watch", (_path: unknown, _options: unknown, listener: typeof changed) => {
      changed = listener;
      return watcher;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    });
    let exitRegistrations = 0;
    const runtime = active({
        cwd,
        runtimeSessionId: "runtime-workspace-observation",
        stalledAt: null,
        lastProgressAtMs: Date.now(),
        process: {
          pid: process.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => {
            exitRegistrations += 1;
          },
          terminate: () => assert.fail("directory removal must not terminate the provider"),
        },
      }),
      context = {
        input: { rootDir: root, now: () => new Date().toISOString(), schedule: () => undefined },
        processes: new Map([[runtime.runtimeSessionId, runtime]]),
        exiting: new Set(),
      } as unknown as RuntimeSpawnerContext;
    try {
      attachActiveRuntime(context, runtime);
      assert.equal(exitRegistrations, 1, "the provider exit callback remains attached");
      const denied = Object.assign(new Error("workspace still exists"), { code: "EPERM" });
      assert.throws(
        () => watcher.emit("error", denied),
        (error) => error === denied,
      );
      assert.equal(closed, 0, "a real permission error keeps its identity");
      rmSync(cwd, { recursive: true });
      if (notification === "rename") changed!("rename", null);
      else watcher.emit("error", Object.assign(new Error("workspace removed"), { code: notification }));
      assert.equal(closed, 1);
      assert.equal(runtime.workspaceActivityCount, 0, "removal is not worker progress");
      assert.equal(typeof runtime.recordProviderProgress, "function");
      runtime.recordProviderProgress!();
    } finally {
      disposeActiveRuntimeObservations(runtime);
    }
    assert.equal(closed, 1, "disposal does not retain the removed workspace's watcher");
  });
}
