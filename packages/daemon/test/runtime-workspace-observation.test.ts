// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { attachActiveRuntime, disposeActiveRuntimeObservations } from "../src/runtime-spawn-active.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import { classifyRuntimeExit } from "../src/runtime-provider-fault.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import { active } from "./runtime-spawn-settlement.fixtures.ts";

for (const notification of ["rename", "ENOENT", "EPERM"] as const) {
  test(`a removed workspace releases its watcher on ${notification} and retains provider observation`, async (t) => {
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
    const scheduled: Array<() => void | Promise<void>> = [];
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
        input: {
          rootDir: root,
          now: () => new Date().toISOString(),
          schedule: (work: () => void | Promise<void>) => scheduled.push(work),
        },
        processes: new Map([[runtime.runtimeSessionId, runtime]]),
        exiting: new Set(),
      } as unknown as RuntimeSpawnerContext;
    try {
      attachActiveRuntime(context, runtime);
      assert.equal(exitRegistrations, 1, "the provider exit callback remains attached");
      rmSync(cwd, { recursive: true });
      if (notification === "rename") changed!("rename", null);
      else watcher.emit("error", Object.assign(new Error("workspace removed"), { code: notification }));
      await scheduled.shift()!();
      assert.equal(closed, 1);
      assert.equal(runtime.recordWorkspaceProgress, null, "the removed workspace has no progress source");
      assert.equal(runtime.workspaceActivityCount, 0, "removal is not worker progress");
      assert.equal(typeof runtime.recordProviderProgress, "function");
      runtime.recordProviderProgress!();
    } finally {
      disposeActiveRuntimeObservations(runtime);
    }
    assert.equal(closed, 1, "disposal does not retain the removed workspace's watcher");
  });
}

test("an already removed workspace has no progress callback while provider observation remains attached", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-already-removed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let exitRegistrations = 0;
  const runtime = active({
      cwd: path.join(root, "removed-workspace"),
      runtimeSessionId: "runtime-workspace-removed",
      stalledAt: null,
      lastProgressAtMs: Date.now(),
      process: {
        pid: process.pid,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => {
          exitRegistrations += 1;
        },
        terminate: () => assert.fail("workspace absence must not terminate the provider"),
      },
    }),
    context = {
      input: { rootDir: root, now: () => new Date().toISOString(), schedule: () => undefined },
      processes: new Map([[runtime.runtimeSessionId, runtime]]),
      exiting: new Set(),
    } as unknown as RuntimeSpawnerContext;
  try {
    attachActiveRuntime(context, runtime);
    assert.equal(runtime.recordWorkspaceProgress, null);
    assert.equal(typeof runtime.recordProviderProgress, "function");
    runtime.recordProviderProgress!();
    assert.equal(exitRegistrations, 1);
  } finally {
    disposeActiveRuntimeObservations(runtime);
  }
});

for (const notification of ["EPERM", "EACCES", "rename"] as const) {
  test(`a live workspace's asynchronous ${notification} fault retires only its runtime`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-fault-"));
    const denied = Object.assign(new Error("workspace observation refused"), { code: "EACCES" });
    const termination = Promise.withResolvers<void>(),
      started = Promise.withResolvers<void>();
    const scheduled: Array<() => void | Promise<void>> = [],
      failures: unknown[] = [];
    let changed: ((event: string, filename: string | null) => void) | undefined;
    let closed = 0,
      settled = 0;
    const watcher = Object.assign(new EventEmitter(), {
      close: () => {
        closed += 1;
      },
      unref: () => undefined,
    });
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
    const dispatchId = "dispatch_0000000000000000000000af";
    const runtime = active({
      cwd: root,
      dispatchId,
      runtimeSessionId: "runtime-observation-fault",
      stream: openDispatchStream(root, {
        dispatchId,
        runtimeSessionId: "runtime-observation-fault",
        startedAt: new Date().toISOString(),
      }),
      process: {
        pid: process.pid,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => assert.fail("tree termination is available"),
        terminateTree: async () => {
          started.resolve();
          await termination.promise;
        },
      },
    });
    const context = {
      input: {
        rootDir: root,
        now: () => new Date().toISOString(),
        schedule: (work: () => void | Promise<void>) => {
          scheduled.push(work);
        },
        recordLifecycle: (entry: unknown) => failures.push(entry),
      },
      processes: new Map([[runtime.runtimeSessionId, runtime]]),
      exiting: new Set(),
      publishExit: async () => {
        settled += 1;
      },
    } as unknown as RuntimeSpawnerContext;
    try {
      attachActiveRuntime(context, runtime);
      if (notification === "rename") {
        t.mock.method(fs, "statSync", () => {
          throw denied;
        });
        syncBuiltinESMExports();
        changed!("rename", null);
      } else {
        denied.code = notification;
        assert.doesNotThrow(() => watcher.emit("error", denied));
        watcher.emit("error", denied);
      }
      assert.throws(
        () => scheduled.shift()!(),
        (error) => error === denied,
        "the writer queue receives the original failure",
      );
      await started.promise;
      assert.equal(runtime.observationError, denied, "preserve the original fault identity");
      assert.match(runtime.lossReason!, new RegExp(denied.code));
      assert.equal(classifyRuntimeExit(runtime, null, null).outcome, "failed");
      assert.equal(classifyRuntimeExit(runtime, null, null).classification, "worker_stop", "not a provider fallback");
      assert.equal(closed, 1);
      assert.equal(runtime.recordWorkspaceProgress, null);
      assert.equal(failures.length, 1);
      while (scheduled.length) await scheduled.shift()!();
      assert.equal(failures.length, 1, "duplicate queued notifications cannot retire twice");
      assert.equal(settled, 0, "do not publish terminal success before termination completes");
      // A pending termination leaves the writer queue available for unrelated work.
      let unrelated = false;
      context.input.schedule(() => {
        unrelated = true;
      });
      await scheduled.shift()!();
      assert.equal(unrelated, true);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      termination.resolve();
      await termination.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      while (scheduled.length) await scheduled.shift()!();
      assert.equal(settled, 1);
    } finally {
      termination.resolve();
      disposeActiveRuntimeObservations(runtime);
    }
  });
}
