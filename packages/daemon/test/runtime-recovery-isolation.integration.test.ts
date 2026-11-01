// harness-test-tier: integration
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptRuntimes } from "../src/runtime-spawn-adoption.ts";
import { openDispatchStream, appendRuntimeWorkerRecord, archiveDispatchStream } from "../src/dispatch-stream.ts";
import { currentWorktreeHead } from "../src/runtime-continuation-context.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";
import { makeRuntimeRecoveryWork } from "../src/runtime-recovery-work.ts";

function fixture(t: test.TestContext, settle: (active: ActiveRuntime) => Promise<void>) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-recovery-isolation-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const ids = ["dispatch_111111111111111111111111", "dispatch_222222222222222222222222"],
    sessions = ids.map((dispatchId, index) => ({
      runtimeSessionId: `runtime-${index}`,
      instanceId: `instance-${index}`,
      providerSessionId: null,
      liveness: "unknown",
      outcome: null,
      dispatchId,
    }));
  for (const session of sessions) {
    openDispatchStream(rootDir, {
      dispatchId: session.dispatchId,
      runtimeSessionId: session.runtimeSessionId,
      taskId: null,
      executionId: null,
      instanceId: session.instanceId,
      startedAt: "2026-11-01T00:00:00.000Z",
      dispatchOpId: session.dispatchId,
      kindId: "codex",
      permissionMode: "read-only",
      cwd: rootDir,
      binding: { actor: { principal: { personId: "owner" }, executor: null }, source: "local" },
      prompt: "recover",
      model: "test",
      reasoningEffort: null,
    });
    appendRuntimeWorkerRecord(rootDir, session.dispatchId, { kind: "process_started", pid: 2_147_483_647 });
  }
  // A terminal stream can move before its canonical session receives the outcome.
  archiveDispatchStream(rootDir, ids[1]!);
  const events: unknown[] = [];
  const context = {
    input: { rootDir, now: () => "2026-11-01T00:01:00.000Z", recordLifecycle: (event: unknown) => events.push(event) },
    processes: new Map(),
    exiting: new Set(),
    requiredRuntimeProjection: () => ({
      readRuntimeSessions: () => sessions,
      readRuntimeDispatch: (id: string) => ({
        payload: { dispatchId: sessions.find((s) => s.runtimeSessionId === id)!.dispatchId },
      }),
    }),
    publishExit: settle,
    runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as RuntimeSpawnerContext;
  return { context, events, rootDir };
}

for (const fault of ["HEAD timeout", "HEAD signal", "runtime restoration rejected"]) {
  test(`${fault} is a per-runtime failure and another archived runtime still restores`, async (t) => {
    const error = Object.assign(new Error(fault), {
      code: fault === "HEAD timeout" ? "ETIMEDOUT" : "ERR_TEST",
      signal: "SIGTERM",
    });
    const settled: string[] = [];
    const { context, events, rootDir } = fixture(t, async (active) => {
      if (active.runtimeSessionId === "runtime-0") {
        if (fault.startsWith("HEAD")) await currentWorktreeHead(rootDir);
        else throw error;
      }
      settled.push(active.runtimeSessionId);
    });
    if (fault.startsWith("HEAD")) {
      const original = childProcess.execFile;
      t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
        if (args[0] !== "git" || !Array.isArray(args[1]) || args[1][1] !== rootDir)
          return Reflect.apply(original, childProcess, args);
        const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: "SIGTERM", stdin: { end() {} } });
        const callback = args[3] as (error: Error, stdout: string, stderr: string) => void;
        queueMicrotask(() => callback(error, "", ""));
        return child;
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
    }
    const results = await adoptRuntimes(context);
    assert.deepEqual(
      results.map((result) => result.outcome),
      ["failed", "ready"],
    );
    assert.deepEqual(settled, ["runtime-1"]);
    assert.ok(events.some((event) => (event as { event: string }).event === "runtime_recovery_failed"));
  });
}

test("one unresolved recovery does not hold another runtime or the repository write queue", async (t) => {
  const blocked = Promise.withResolvers<void>(),
    second = Promise.withResolvers<void>();
  let tail = Promise.resolve();
  const work = makeRuntimeRecoveryWork(<T>(mutation: () => T | Promise<T>) => {
    const result = tail.then(mutation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  });
  const { context } = fixture(t, async (active) => {
    if (active.runtimeSessionId === "runtime-0") await blocked.promise;
    await work.write(() => {
      if (active.runtimeSessionId === "runtime-1") second.resolve();
    }, active.binding);
  });
  const recovery = work.run(() => adoptRuntimes(context));
  try {
    await second.promise;
    let written = false;
    await tail.then(() => {
      written = true;
    });
    assert.equal(written, true);
  } finally {
    blocked.resolve();
    await recovery;
  }
});

for (const fault of ["pending", "rejected"] as const) {
  test(`one ${fault} remote dispatch lookup does not hold another runtime`, async (t) => {
    const lookup = Promise.withResolvers<string | null>(),
      second = Promise.withResolvers<void>();
    const { context } = fixture(t, async (active) => {
      if (active.runtimeSessionId === "runtime-1") second.resolve();
    });
    const projection = context.requiredRuntimeProjection(context.input);
    const remoteContext = {
      ...context,
      input: {
        ...context.input,
        remote: {
          readRuntimeSessions: async () => projection.readRuntimeSessions(),
          readRuntimeDispatchId: async (id: string) => {
            if (id === "runtime-0") return lookup.promise;
            return projection.readRuntimeDispatch(id)!.payload.dispatchId;
          },
        },
      },
    } as RuntimeSpawnerContext;
    const recovery = adoptRuntimes(remoteContext);
    if (fault === "rejected") lookup.reject(new Error("dispatch lookup unavailable"));
    try {
      await second.promise;
    } finally {
      lookup.resolve("dispatch_111111111111111111111111");
      const result = await recovery;
      assert.equal(result[1]!.outcome, "ready");
      assert.equal(result[0]!.outcome, fault === "rejected" ? "failed" : "ready");
    }
  });
}
