// harness-test-tier: integration
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptRuntimes, assertRuntimeRecoveryReady } from "../src/runtime-spawn-adoption.ts";
import { openDispatchStream, appendRuntimeWorkerRecord, archiveDispatchStream } from "../src/dispatch-stream.ts";
import { currentWorktreeHead } from "../src/runtime-continuation-context.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";
import { makeRuntimeRecoveryWork } from "../src/runtime-recovery-work.ts";
import { makeRuntimeSpawner } from "../src/runtime-spawn.ts";
import { definition, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";

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
        source: "local",
        payload: { dispatchId: sessions.find((s) => s.runtimeSessionId === id)!.dispatchId },
      }),
    }),
    publishExit: settle,
    runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as RuntimeSpawnerContext;
  return { context, events, rootDir };
}

for (const owner of ["node-a", "node-b", null]) {
  test(`a session arriving after census reserves capacity only on its canonical node (${owner})`, async (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-late-owner-"));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    let arrived = false;
    const prepared = Object.assign(new Error("selection reached the launch port"), { code: "fixture_prepared" });
    const spawner = makeRuntimeSpawner({
      rootDir,
      repoId: "late-owner",
      daemonGeneration: 1,
      runtimeNode: { nodeId: "node-a" },
      now: () => new Date().toISOString(),
      stream: { publish: () => ({}) as never },
      runtimeInstances: scheduleRuntimePorts().runtimeInstances,
      readSettings: () => ({ runtime: { allowedInstances: [definition.instanceId] } }) as never,
      prepareLaunch: async () => {
        throw prepared;
      },
      schedule: () => undefined,
      remote: {
        existing: async () => null,
        taskContext: async () => {
          throw new Error("taskless probe must not request task context");
        },
        readRuntimeSessions: async () =>
          arrived
            ? [
                {
                  runtimeSessionId: "late",
                  instanceId: definition.instanceId,
                  providerSessionId: null,
                  liveness: "live",
                  outcome: null,
                },
              ]
            : [],
        readRuntimeDispatch: async () =>
          owner === null
            ? null
            : {
                payload: { dispatchId: "late-dispatch" },
                source: { kind: "node", nodeId: owner },
              },
        publish: async () => {
          throw new Error("the selection probe must not publish a dispatch");
        },
        archive: async () => ({ outcome: "applied" }),
      },
    });
    t.after(() => spawner.close());
    await spawner.adopt();
    arrived = true;
    await assert.rejects(
      spawner.spawn(
        {
          runtimeInstanceId: definition.instanceId,
          prompt: "select",
          cwd: { scope: "repo-root" },
          dispatchKey: "probe",
        },
        { actor: { principal: { personId: "owner" }, executor: null }, source: { kind: "node", nodeId: "node-a" } },
      ),
      owner === "node-b" || owner === null ? prepared : { code: "runtime_recovery_pending" },
    );
  });
}

test("a session without a dispatch never holds its instance, while a dispatched failed recovery still does", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-residual-dispatch-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const prepared = Object.assign(new Error("selection reached the launch port"), { code: "fixture_prepared" });
  let sessions: Array<{
    runtimeSessionId: string;
    instanceId: string;
    providerSessionId: null;
    liveness: "unknown";
    outcome: null;
  }> = [];
  const spawner = makeRuntimeSpawner({
    rootDir,
    repoId: "residual-dispatch",
    daemonGeneration: 1,
    runtimeNode: { nodeId: "node-a" },
    now: () => new Date().toISOString(),
    stream: { publish: () => ({}) as never },
    runtimeInstances: scheduleRuntimePorts().runtimeInstances,
    readSettings: () => ({ runtime: { allowedInstances: [definition.instanceId] } }) as never,
    prepareLaunch: async () => {
      throw prepared;
    },
    schedule: () => undefined,
    remote: {
      taskContext: async () => {
        throw new Error("taskless probe must not request task context");
      },
      readRuntimeSessions: async () => sessions,
      readRuntimeDispatch: async (runtimeSessionId: string) =>
        runtimeSessionId === "residual"
          ? null
          : {
              payload: { dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa" },
              source: { kind: "node", nodeId: "node-a" },
            },
      publish: async () => {
        throw new Error("the selection probe must not publish a dispatch");
      },
      archive: async () => ({ outcome: "applied" }),
    },
  });
  t.after(() => spawner.close());
  const session = (runtimeSessionId: string) => ({
      runtimeSessionId,
      instanceId: definition.instanceId,
      providerSessionId: null,
      liveness: "unknown" as const,
      outcome: null,
    }),
    spawn = () =>
      spawner.spawn(
        {
          runtimeInstanceId: definition.instanceId,
          prompt: "select",
          cwd: { scope: "repo-root" },
          dispatchKey: "probe",
        },
        { actor: { principal: { personId: "owner" }, executor: null }, source: { kind: "node", nodeId: "node-a" } },
      );
  // Maintenance still records the failure: the session has no dispatch to read.
  sessions = [session("residual")];
  const residualRecovery = await spawner.adopt();
  assert.equal(residualRecovery[0]?.outcome, "failed");
  assert.equal((residualRecovery[0]?.error as { code?: string }).code, "runtime_recovery_missing_dispatch");
  // ...but that failure cannot hold capacity the session never occupied.
  await assert.rejects(spawn(), prepared);
  // A dispatched session's failed recovery is a real unresolved runtime and still refuses.
  sessions = [session("dispatched")];
  const dispatchedRecovery = await spawner.adopt();
  assert.equal(dispatchedRecovery[0]?.outcome, "failed");
  await assert.rejects(spawn(), { code: "runtime_recovery_missing_dispatch" });
});

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
    const lookup = Promise.withResolvers<{ payload: { dispatchId: string }; source: "local" }>(),
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
          readRuntimeDispatch: async (id: string) => {
            if (id === "runtime-0") return lookup.promise;
            return projection.readRuntimeDispatch(id);
          },
        },
      },
    } as RuntimeSpawnerContext;
    const recovery = adoptRuntimes(remoteContext);
    if (fault === "rejected") lookup.reject(new Error("dispatch lookup unavailable"));
    try {
      await second.promise;
    } finally {
      lookup.resolve({ payload: { dispatchId: "dispatch_111111111111111111111111" }, source: "local" });
      const result = await recovery;
      assert.equal(result[1]!.outcome, "ready");
      assert.equal(result[0]!.outcome, fault === "rejected" ? "failed" : "ready");
    }
  });
}

test("canonical dispatch ownership excludes another node without requiring its local header", async (t) => {
  const { context } = fixture(t, async () => {
    throw new Error("foreign runtime cannot settle here");
  });
  const projection = context.requiredRuntimeProjection(context.input);
  const foreign = {
    ...context,
    input: {
      ...context.input,
      runtimeNode: { nodeId: "node-b" },
      remote: {
        readRuntimeSessions: async () => projection.readRuntimeSessions(),
        readRuntimeDispatch: async (id: string) => ({
          ...projection.readRuntimeDispatch(id)!,
          source: { kind: "node", nodeId: "node-a" },
        }),
      },
    },
  } as RuntimeSpawnerContext;
  const results = await adoptRuntimes(foreign);
  assert.deepEqual(
    results.map((result) => result.outcome),
    ["foreign", "foreign"],
  );
  assert.equal(assertRuntimeRecoveryReady(foreign, "runtime-0"), false);
  assert.equal(foreign.processes.size, 0);
});
