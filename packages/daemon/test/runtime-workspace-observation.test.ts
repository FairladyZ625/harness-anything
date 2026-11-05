// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import workerThreads, { type WorkerOptions } from "node:worker_threads";
import { observeRuntimeWorkspace, type WorkspaceMonitorObservation } from "../src/runtime-workspace-monitor.ts";
import { createWorkspaceActivityQueue } from "../src/runtime-workspace-activity-queue.ts";
import { openRuntimeWorkspaceMonitor } from "../src/runtime-workspace-monitor-thread.ts";
import { attachActiveRuntime, disposeActiveRuntimeObservations } from "../src/runtime-spawn-active.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import { active, tasklessSettlementRuntime } from "./runtime-spawn-settlement.fixtures.ts";

for (const localWorkspace of [false, true]) {
  test(`watcher thread filters daemon writes (local workspace: ${localWorkspace})`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-thread-filter-")),
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
    const records: WorkspaceMonitorObservation[] = [],
      monitor = observeRuntimeWorkspace(root, cwd, (record) => records.push(record));
    const ignored = localWorkspace ? "runtime/dispatches" : ".harness";
    for (let index = 0; index < 100; index++) changed!("change", `${ignored}/output.jsonl`);
    assert.deepEqual(records, []);
    changed!("change", `${ignored}-worker.txt`);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.kind, "workspace_activity");
    monitor.close();
  });
}

for (const notification of ["rename", "ENOENT", "EPERM"] as const) {
  test(`watcher thread closes when the workspace is removed on ${notification}`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-thread-removed-")),
      cwd = path.join(root, "workspace");
    mkdirSync(cwd);
    let changed: ((event: string, filename: string | null) => void) | undefined,
      closed = 0;
    const watcher = Object.assign(new EventEmitter(), { close: () => closed++, unref: () => undefined });
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
    const records: WorkspaceMonitorObservation[] = [],
      monitor = observeRuntimeWorkspace(root, cwd, (record) => records.push(record));
    rmSync(cwd, { recursive: true });
    if (notification === "rename") changed!("rename", null);
    else watcher.emit("error", Object.assign(new Error("workspace removed"), { code: notification }));
    assert.equal(closed, 1);
    assert.deepEqual(records, [{ kind: "workspace_removed" }]);
    monitor.close();
    assert.equal(closed, 1);
  });
}

test("watcher thread coalesces a burst and retains the last observed timestamp", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-05T03:00:00.000Z") });
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-thread-burst-"));
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
  const records: WorkspaceMonitorObservation[] = [],
    observed: number[] = [],
    monitor = observeRuntimeWorkspace(
      root,
      root,
      (record) => records.push(record),
      (at) => observed.push(at),
    );
  changed!("change", "first.txt");
  t.mock.timers.tick(200);
  for (let index = 0; index < 10_000; index++) changed!("change", `file-${index}`);
  assert.equal(records.length, 1);
  assert.equal(observed.at(-1), Date.parse("2026-11-05T03:00:00.200Z"));
  t.mock.timers.tick(800);
  assert.deepEqual(records, [
    { kind: "workspace_activity", occurredAt: "2026-11-05T03:00:00.000Z" },
    { kind: "workspace_activity", occurredAt: "2026-11-05T03:00:00.200Z" },
  ]);
  monitor.close();
});

test("watcher fault reports the original error and closes its watcher", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-thread-fault-"));
  let closed = 0;
  const watcher = Object.assign(new EventEmitter(), { close: () => closed++, unref: () => undefined });
  t.mock.method(fs, "watch", () => watcher);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  const records: WorkspaceMonitorObservation[] = [],
    monitor = observeRuntimeWorkspace(root, root, (record) => records.push(record));
  watcher.emit("error", Object.assign(new Error("permission denied"), { code: "EACCES" }));
  assert.deepEqual(records, [{ kind: "workspace_observation_failed", code: "EACCES", message: "permission denied" }]);
  assert.equal(closed, 1);
  monitor.close();
});

test("the real watcher thread reports a file change before shutdown", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-thread-real-")),
    progress = Promise.withResolvers<WorkspaceMonitorObservation>(),
    monitor = openRuntimeWorkspaceMonitor(root, root, (record) => {
      if (record.kind === "workspace_activity") progress.resolve(record);
    });
  try {
    await monitor.ready;
    writeFileSync(path.join(root, "worker.txt"), "progress");
    const record = await progress.promise;
    assert.equal(record.kind, "workspace_activity");
    assert.equal(typeof record.occurredAt, "string");
  } finally {
    await monitor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a watcher thread startup error reaches the writer with its original code", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-thread-start-fault-")),
    records: WorkspaceMonitorObservation[] = [],
    monitor = openRuntimeWorkspaceMonitor(root, path.join(root, "invalid\u0000workspace"), (record) =>
      records.push(record),
    );
  try {
    await monitor.ready;
    assert.equal(records[0]?.kind, "workspace_observation_failed");
    assert.equal(records[0]?.code, "ERR_INVALID_ARG_VALUE");
  } finally {
    await monitor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "provider exit records pending workspace progress and recovery before settlement",
  { timeout: 70_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-workspace-thread-flush-")),
      root = path.join(parent, "repo"),
      ready = path.join(parent, "watcher-ready"),
      seen = path.join(parent, "second-seen"),
      at = Date.now(),
      queued = Promise.withResolvers<void>(),
      scheduled: Array<() => void | Promise<void>> = [],
      order: string[] = [];
    mkdirSync(root);
    const preload = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const nativeWatch = fs.watch;
const nativeTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, delay <= 1000 ? 60000 : delay, ...args);
let now = ${String(at)};
Date.now = () => now;
fs.watch = function(target, options, listener) {
  if (String(target) !== ${JSON.stringify(root)} || !options?.recursive)
    return nativeWatch.call(this, target, options, listener);
  const watcher = nativeWatch.call(this, target, options, (event, filename) => {
    if (String(filename) === "second.txt") now = ${String(at + 200)};
    listener(event, filename);
    if (String(filename) === "second.txt") fs.writeFileSync(${JSON.stringify(seen)}, "seen");
  });
  fs.writeFileSync(${JSON.stringify(ready)}, "ready");
  return watcher;
};
syncBuiltinESMExports();
`;
    let onExit: ((code: number | null) => void) | undefined,
      wake: (() => void) | undefined,
      settled = false;
    const base = tasklessSettlementRuntime(root, null),
      runtime = active({
        ...base,
        lastProgressAtMs: at - 1_000,
        lastRealProgressAtMs: at - 1_000,
        stream: { ...base.stream, appendWorkspaceActivity: (occurredAt: string) => order.push(occurredAt) },
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
          schedule: (work: () => void | Promise<void>) => {
            scheduled.push(work);
            queued.resolve();
            wake?.();
            wake = undefined;
          },
        },
        processes: new Map([[runtime.runtimeSessionId, runtime]]),
        exiting: new Set(),
        consumeChunk: async () => undefined,
        publishRuntimeEvent: async () => {
          order.push("connectivity recovered");
        },
        publishExit: async () => {
          order.push("settled");
          settled = true;
        },
      } as unknown as RuntimeSpawnerContext;
    const OriginalWorker = workerThreads.Worker;
    t.mock.method(
      workerThreads,
      "Worker",
      class extends OriginalWorker {
        constructor(filename: string | URL, options: WorkerOptions = {}) {
          super(filename, {
            ...options,
            execArgv: [...(options.execArgv ?? []), "--import", `data:text/javascript,${encodeURIComponent(preload)}`],
          });
        }
      },
    );
    syncBuiltinESMExports();
    try {
      attachActiveRuntime(context, runtime);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    try {
      await waitForFile(ready);
      writeFileSync(path.join(root, "first.txt"), "first");
      await withDeadline(queued.promise, "first workspace progress");
      while (scheduled.length) await scheduled.shift()!();
      runtime.providerUnreachable = {
        state: "provider_unreachable",
        lastProgressAt: new Date(at).toISOString(),
        lastErrorAt: new Date(at + 100).toISOString(),
        lastError: "connection lost",
      };
      writeFileSync(path.join(root, "second.txt"), "second");
      await waitForFile(seen);
      onExit!(0);
      while (!settled) {
        if (scheduled.length) await scheduled.shift()!();
        else await new Promise<void>((resolve) => (wake = resolve));
      }
      assert.deepEqual(order, [
        new Date(at).toISOString(),
        new Date(at + 200).toISOString(),
        "connectivity recovered",
        "settled",
      ]);
    } finally {
      disposeActiveRuntimeObservations(runtime);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

function waitForFile(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      watcher.close();
      reject(new Error(`Timed out waiting for ${file}`));
    }, 20_000);
    const watcher = fs.watch(path.dirname(file), () => {
      if (fs.existsSync(file)) {
        watcher.close();
        clearTimeout(timeout);
        resolve();
      }
    });
    if (fs.existsSync(file)) {
      watcher.close();
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function withDeadline<T>(promise: Promise<T>, stage: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${stage}`)), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("a blocked writer retains only one workspace admission and the latest timestamp", async () => {
  const scheduled: Array<() => void | Promise<void>> = [],
    observed: number[] = [],
    enqueue = createWorkspaceActivityQueue(
      (work) => scheduled.push(work),
      (at) => {
        observed.push(at);
      },
    );
  for (let index = 0; index < 10_000; index++) enqueue(index);
  assert.equal(scheduled.length, 1);
  let ordinaryWriteRan = false;
  scheduled.push(() => {
    ordinaryWriteRan = true;
  });
  while (scheduled.length) await scheduled.shift()!();
  assert.deepEqual(observed, [9_999]);
  assert.equal(ordinaryWriteRan, true);
});
