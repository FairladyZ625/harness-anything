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
import { active, tasklessSettlementRuntime } from "./runtime-spawn-settlement.fixtures.ts";

for (const localWorkspace of [false, true]) {
  test(`daemon file changes never enter the runtime writer queue (local workspace: ${localWorkspace})`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-daemon-noise-")),
      cwd = localWorkspace ? path.join(root, ".harness") : root;
    mkdirSync(cwd, { recursive: true });
    let changed: ((event: string, filename: string | null) => void) | undefined;
    const watcher = Object.assign(new EventEmitter(), { close: () => undefined, unref: () => undefined });
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
    const scheduled: Array<() => void | Promise<void>> = [],
      runtime = tasklessSettlementRuntime(cwd, null),
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
      const ignored = localWorkspace ? "runtime/dispatches" : ".harness";
      for (let index = 0; index < 100; index++) {
        changed!("change", `${ignored}/output.jsonl`);
        changed!("rename", path.join(ignored, "cache", "task.sqlite"));
      }
      assert.equal(scheduled.length, 0, "daemon observations must be filtered before writer admission");
      changed!("change", `${ignored}-worker.txt`);
      assert.equal(scheduled.length, 1, "a similarly named worker file still records progress");
      await scheduled.shift()!();
      assert.equal(runtime.workspaceActivityCount, 1);
    } finally {
      disposeActiveRuntimeObservations(runtime);
    }
  });
}

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

test("workspace notification bursts leave the writer queue bounded", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-burst-"));
  let changed: ((event: string, filename: string | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close: () => undefined, unref: () => undefined });
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
  const scheduled: Array<() => void | Promise<void>> = [],
    runtime = tasklessSettlementRuntime(root, null),
    context = {
      input: {
        rootDir: root,
        now: () => new Date().toISOString(),
        schedule: (work: () => void | Promise<void>) => scheduled.push(work),
      },
      processes: new Map([[runtime.runtimeSessionId, runtime]]),
      exiting: new Set(),
    } as unknown as RuntimeSpawnerContext;
  runtime.lastProgressAtMs = Date.now() - 10_000;
  runtime.lastRealProgressAtMs = runtime.lastProgressAtMs;
  const previousProgress = runtime.lastProgressAtMs;
  try {
    attachActiveRuntime(context, runtime);
    for (let index = 0; index < 10_000; index += 1) changed!("change", `node_modules/file-${index}`);
    t.diagnostic(`notifications=10000 queued=${scheduled.length}`);
    assert.ok(scheduled.length <= 1, "a stalled writer must retain at most one workspace observation per runtime");
    let ordinaryWriteRan = false;
    context.input.schedule(() => {
      ordinaryWriteRan = true;
    });
    while (scheduled.length) await scheduled.shift()!();
    assert.equal(ordinaryWriteRan, true);
    assert.ok(runtime.lastProgressAtMs > previousProgress, "the burst advances the progress clock");
  } finally {
    disposeActiveRuntimeObservations(runtime);
  }
});

test("workspace progress is rate-limited with a trailing record", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-05T03:00:00.000Z") });
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-throttle-"));
  let changed: ((event: string, filename: string | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close: () => undefined, unref: () => undefined });
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
  const scheduled: Array<() => void | Promise<void>> = [],
    records: string[] = [],
    base = tasklessSettlementRuntime(root, null),
    runtime = active({
      ...base,
      lastRealProgressAtMs: Date.now(),
      stream: { ...base.stream, appendWorkspaceActivity: (at: string) => records.push(at) },
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
    changed!("change", "first.txt");
    while (scheduled.length) await scheduled.shift()!();
    t.mock.timers.tick(200);
    for (let index = 0; index < 1_000; index += 1) changed!("change", `file-${index}`);
    assert.equal(scheduled.length, 0);
    t.mock.timers.tick(799);
    assert.equal(scheduled.length, 0);
    t.mock.timers.tick(1);
    assert.equal(scheduled.length, 1);
    while (scheduled.length) await scheduled.shift()!();
    assert.deepEqual(records, ["2026-11-05T03:00:00.000Z", "2026-11-05T03:00:00.200Z"]);
    assert.equal(runtime.lastProgressAtMs, Date.parse("2026-11-05T03:00:00.200Z"));
  } finally {
    disposeActiveRuntimeObservations(runtime);
  }
});

test("provider exit flushes the last coalesced workspace progress before settlement", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-05T03:00:00.000Z") });
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-exit-"));
  let changed: ((event: string, filename: string | null) => void) | undefined,
    onExit: ((code: number | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close: () => undefined, unref: () => undefined });
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
  const scheduled: Array<() => void | Promise<void>> = [],
    order: string[] = [],
    base = tasklessSettlementRuntime(root, null),
    runtime = active({
      ...base,
      lastRealProgressAtMs: Date.now(),
      stream: { ...base.stream, appendWorkspaceActivity: (at: string) => order.push(at) },
      process: {
        ...base.process,
        onExit: (listener) => {
          onExit = listener;
        },
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
      consumeChunk: async () => undefined,
      publishRuntimeEvent: async () => {
        order.push("connectivity recovered");
      },
      publishExit: async () => {
        order.push("settled");
      },
    } as unknown as RuntimeSpawnerContext;
  attachActiveRuntime(context, runtime);
  changed!("change", "first.txt");
  while (scheduled.length) await scheduled.shift()!();
  t.mock.timers.tick(200);
  runtime.providerUnreachable = {
    state: "provider_unreachable",
    lastProgressAt: "2026-11-05T03:00:00.000Z",
    lastErrorAt: "2026-11-05T03:00:00.100Z",
    lastError: "connection lost",
  };
  changed!("change", "last.txt");
  onExit!(0);
  while (scheduled.length) await scheduled.shift()!();
  assert.deepEqual(order, [
    "2026-11-05T03:00:00.000Z",
    "2026-11-05T03:00:00.200Z",
    "connectivity recovered",
    "settled",
  ]);
  t.mock.timers.tick(1_000);
  assert.equal(scheduled.length, 0, "exit clears the trailing timer");
});
