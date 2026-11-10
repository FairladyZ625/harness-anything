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
import { lifecycleReadFor } from "./dispatch-lifecycle-read.fixtures.ts";

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
      startedAt: new Date().toISOString(),
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
    input: {
      rootDir,
      now: () => "2026-11-01T00:01:00.000Z",
      schedule: (work: () => void | Promise<void>) => {
        void Promise.resolve().then(work);
      },
      recordLifecycle: (event: unknown) => events.push(event),
      runtimeInstances: () => sessions.map(({ instanceId }) => ({ instanceId, enabled: true }) as never),
    },
    processes: new Map(),
    exiting: new Set(),
    requiredRuntimeProjection: () => ({
      readRuntimeSession(id: string) {
        return (
          this.readRuntimeSessions().find(
            (session: { readonly runtimeSessionId: string }) => session.runtimeSessionId === id,
          ) ?? null
        );
      },
      readRuntimeSessions: () => sessions,
      readRuntimeDispatch: (id: string) => ({
        source: "local",
        payload: { dispatchId: sessions.find((s) => s.runtimeSessionId === id)!.dispatchId },
      }),
      readDispatchLifecycle: lifecycleReadFor(
        sessions.map((session) => ({
          runtimeSessionId: session.runtimeSessionId,
          dispatchId: session.dispatchId,
          instanceId: session.instanceId,
          process: "unknown" as const,
        })),
      ),
    }),
    publishExit: settle,
    publishRuntimeEvent: async (type: string, payload: unknown) => {
      events.push({ type, payload });
      return { event: { type } as never, receipt: { outcome: "applied" } };
    },
    runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as RuntimeSpawnerContext;
  return { context, events, rootDir };
}

test("recovery releases its temporary process when the aggregate settles during adoption", async (t) => {
  const { context } = fixture(t, async () => assert.fail("settled attempt must not settle twice"));
  const projection = context.requiredRuntimeProjection(context.input),
    originalRead = projection.readDispatchLifecycle.bind(projection);
  let dispatchReads = 0;
  projection.readDispatchLifecycle = async (query) => {
    const read = await originalRead(query);
    if (query.by !== "dispatch" || ++dispatchReads < 2 || read.status !== "ready") return read;
    return { ...read, rows: read.rows.map((view) => ({ ...view, policy: { ...view.policy, attemptSettled: true } })) };
  };
  context.requiredRuntimeProjection = () => projection;
  const result = await adoptRuntimes(context, undefined, { runtimeSessionId: "runtime-0" });
  assert.equal(result[0]?.outcome, "settled");
  assert.equal(context.processes.size, 0);
});

test("recovery records a missing dispatch as a per-runtime failure", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-residual-dispatch-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let sessions: Array<{
    runtimeSessionId: string;
    instanceId: string;
    providerSessionId: null;
    liveness: "unknown";
    outcome: null;
  }> = [];
  let activeAttempts: Parameters<typeof lifecycleReadFor>[0] = [];
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
      throw new Error("recovery must not launch");
    },
    schedule: () => undefined,
    remote: {
      taskContext: async () => {
        throw new Error("taskless probe must not request task context");
      },
      async readRuntimeSession(id: string) {
        return (
          (await this.readRuntimeSessions()).find(
            (session: { readonly runtimeSessionId: string }) => session.runtimeSessionId === id,
          ) ?? null
        );
      },
      readRuntimeSessions: async () => sessions,
      readDispatchLifecycle: (query) => lifecycleReadFor(activeAttempts)(query),
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
  });
  // A migrated legacy session without an aggregate attempt is historical, not adoptable work.
  sessions = [session("residual")];
  const residualRecovery = await spawner.adopt();
  assert.deepEqual(residualRecovery, []);
  // An active aggregate attempt with no local stream is reported as a per-runtime failure.
  sessions = [session("dispatched")];
  activeAttempts = [
    {
      runtimeSessionId: "dispatched",
      dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
      instanceId: definition.instanceId,
      owner: "node:node-a",
      process: "unknown",
    },
  ];
  const dispatchedRecovery = await spawner.adopt();
  assert.equal(dispatchedRecovery[0]?.outcome, "failed");
  assert.equal((dispatchedRecovery[0]?.error as { code?: string }).code, "runtime_recovery_missing_dispatch");
});

test("a failed recovery for an exited owner without a local process is recorded", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-exited-failed-recovery-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dispatchId = "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
    recoveryError = new Error("terminal publication unavailable"),
    session = {
      runtimeSessionId: "runtime_44510389bdda9a99ff61d7a1",
      instanceId: definition.instanceId,
      providerSessionId: null,
      liveness: "exited" as const,
      outcome: null as "succeeded" | "failed" | "unknown" | "cancelled" | "stopped" | null,
    },
    lifecycle: unknown[] = [];
  const spawner = makeRuntimeSpawner({
    rootDir,
    repoId: "exited-failed-recovery",
    daemonGeneration: 1,
    runtimeNode: { nodeId: "node-a" },
    now: () => "2026-11-01T00:01:00.000Z",
    stream: { publish: () => ({}) as never },
    runtimeInstances: scheduleRuntimePorts().runtimeInstances,
    readSettings: () => ({ runtime: { allowedInstances: [definition.instanceId] } }) as never,
    prepareLaunch: async () => {
      throw new Error("recovery must not launch");
    },
    schedule: () => undefined,
    recordLifecycle: (event) => lifecycle.push(event),
    remote: {
      taskContext: async () => {
        throw new Error("taskless probe must not request task context");
      },
      async readRuntimeSession(id: string) {
        return (
          (await this.readRuntimeSessions()).find(
            (session: { readonly runtimeSessionId: string }) => session.runtimeSessionId === id,
          ) ?? null
        );
      },
      readRuntimeSessions: async () => [session],
      readRuntimeDispatch: async () => ({
        payload: { dispatchId },
        actor: { principal: { personId: "owner" }, executor: null },
        source: { kind: "node", nodeId: "node-a" },
      }),
      readDispatchLifecycle: lifecycleReadFor([
        {
          runtimeSessionId: session.runtimeSessionId,
          dispatchId,
          instanceId: definition.instanceId,
          owner: "node:node-a",
          process: "unknown",
          stopProof: "proven_stopped",
        },
      ]),
      publish: async (draft) => {
        if (draft.type === "runtime_session_outcome_observed") throw recoveryError;
        return { event: { type: draft.type } as never, receipt: { outcome: "applied" } };
      },
      archive: async () => ({ outcome: "applied" }),
    },
  });
  t.after(() => spawner.close());
  const recovery = await spawner.adopt();
  assert.equal(recovery[0]?.outcome, "failed");
  assert.equal(recovery[0]?.error, recoveryError);
  assert.ok(lifecycle.some((entry) => (entry as { event?: string }).event === "runtime_recovery_failed"));
});

test("an exited session with a process still owned locally retains instance capacity", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-exited-process-owner-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const runtimeSessionId = "runtime-exited-process-owner",
    dispatchId = "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb",
    session = {
      runtimeSessionId,
      instanceId: definition.instanceId,
      providerSessionId: null,
      liveness: "exited" as const,
      outcome: null,
    },
    context = {
      input: {
        rootDir,
        runtimeNode: { nodeId: "node-a" },
        runtimeInstances: () => [{ instanceId: definition.instanceId, enabled: true }],
        now: () => "2026-11-01T00:01:00.000Z",
        remote: {
          async readRuntimeSession(id: string) {
            return (
              (await this.readRuntimeSessions()).find(
                (session: { readonly runtimeSessionId: string }) => session.runtimeSessionId === id,
              ) ?? null
            );
          },
          readRuntimeSessions: async () => [session],
          readRuntimeDispatch: async () => ({
            payload: { dispatchId },
            actor: { principal: { personId: "owner" }, executor: null },
            source: { kind: "node", nodeId: "node-a" },
          }),
          readDispatchLifecycle: lifecycleReadFor([
            { runtimeSessionId, dispatchId, instanceId: definition.instanceId, owner: "node:node-a", process: "alive" },
          ]),
        },
      },
      processes: new Map([[runtimeSessionId, { process: { pid: process.pid } }]]),
      exiting: new Set(),
      runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    } as unknown as RuntimeSpawnerContext;
  const recovery = await adoptRuntimes(context);
  assert.equal(recovery[0]?.outcome, "failed");
  await assert.rejects(
    () => assertRuntimeRecoveryReady(context, runtimeSessionId, dispatchId),
    (error) => error === recovery[0]?.error,
  );
});

test("an exited owner session with a dispatch but no stream header settles", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-recovery-missing-header-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dispatchId = "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa";
  const session = {
    runtimeSessionId: "runtime-missing-header",
    instanceId: definition.instanceId,
    providerSessionId: null,
    liveness: "exited" as const,
    outcome: null as "succeeded" | "failed" | "unknown" | "cancelled" | "stopped" | null,
  };
  const published: Array<{
    readonly type: string;
    readonly opId: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly resultBody?: string;
  }> = [];
  const spawner = makeRuntimeSpawner({
    rootDir,
    repoId: "missing-header",
    daemonGeneration: 1,
    runtimeNode: { nodeId: "node-a" },
    now: () => "2026-11-01T00:01:00.000Z",
    stream: { publish: () => ({}) as never },
    runtimeInstances: scheduleRuntimePorts().runtimeInstances,
    readSettings: () => ({ runtime: { allowedInstances: [definition.instanceId] } }) as never,
    prepareLaunch: async () => {
      throw new Error("recovery must not launch");
    },
    schedule: () => undefined,
    remote: {
      taskContext: async () => {
        throw new Error("taskless probe must not request task context");
      },
      async readRuntimeSession(id: string) {
        return (
          (await this.readRuntimeSessions()).find(
            (session: { readonly runtimeSessionId: string }) => session.runtimeSessionId === id,
          ) ?? null
        );
      },
      readRuntimeSessions: async () => [session],
      readRuntimeDispatch: async () => ({
        payload: { dispatchId },
        actor: { principal: { personId: "owner" }, executor: null },
        source: { kind: "node", nodeId: "node-a" },
      }),
      readDispatchLifecycle: lifecycleReadFor([
        {
          runtimeSessionId: session.runtimeSessionId,
          dispatchId,
          instanceId: definition.instanceId,
          owner: "node:node-a",
          process: "unknown",
          stopProof: "proven_stopped",
        },
      ]),
      publish: async (draft) => {
        published.push({
          type: draft.type,
          opId: draft.opId,
          payload: draft.payload,
          ...(draft.resultBody === undefined ? {} : { resultBody: draft.resultBody }),
        });
        if (draft.type === "runtime_session_outcome_observed")
          session.outcome = draft.payload.outcome as typeof session.outcome;
        return { event: { type: draft.type } as never, receipt: { outcome: "applied" } };
      },
      archive: async () => ({ outcome: "applied" }),
    },
  });
  t.after(() => spawner.close());
  const recovery = await spawner.adopt();
  assert.equal(recovery[0]?.outcome, "settled");
  assert.equal(session.outcome, "unknown");
  assert.deepEqual(
    published.map(({ type }) => type),
    ["runtime_session_exited", "runtime_session_outcome_observed"],
  );
  assert.deepEqual(
    published.map(({ opId }) => opId),
    [`runtime-recovery-${dispatchId}-exited`, `runtime-recovery-${dispatchId}-outcome`],
  );
  assert.equal(published[1]?.payload.dispatchId, dispatchId);
  assert.equal(
    published[1]?.resultBody,
    "Runtime session lost: runtime process was no longer alive after daemon restart.",
  );
});

test("a missing dispatch stream cannot settle a live or foreign runtime", async (t) => {
  const dispatchId = "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb",
    published: string[] = [],
    rootDir = mkdtempSync(path.join(tmpdir(), "runtime-recovery-negative-control-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const makeContext = (
    session: {
      readonly runtimeSessionId: string;
      readonly liveness: "live" | "exited";
      outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped" | null;
    },
    owner: string,
  ) => {
    return {
      input: {
        rootDir,
        runtimeNode: { nodeId: "node-a" },
        runtimeInstances: () => [{ instanceId: definition.instanceId, enabled: true }],
        remote: {
          async readRuntimeSession(id: string) {
            return (
              (await this.readRuntimeSessions()).find(
                (session: { readonly runtimeSessionId: string }) => session.runtimeSessionId === id,
              ) ?? null
            );
          },
          readRuntimeSessions: async () => [session],
          readRuntimeDispatch: async () => ({
            payload: { dispatchId },
            actor: { principal: { personId: "owner" }, executor: null },
            source: { kind: "node", nodeId: owner },
          }),
          readDispatchLifecycle: lifecycleReadFor([
            {
              runtimeSessionId: session.runtimeSessionId,
              dispatchId,
              instanceId: definition.instanceId,
              owner: `node:${owner}`,
              process: session.liveness === "live" ? "alive" : "exited",
              attemptSettled: session.outcome !== null,
              groupSettled: session.outcome !== null,
            },
          ]),
        },
      },
      processes: new Map(),
      exiting: new Set(),
      runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      publishRuntimeEvent: async (type: string, payload: { runtimeSessionId: string; outcome?: string }) => {
        published.push(type);
        if (type === "runtime_session_outcome_observed") session.outcome = payload.outcome as typeof session.outcome;
        return { event: { type } as never };
      },
    } as unknown as RuntimeSpawnerContext;
  };
  const liveSession = { runtimeSessionId: "live-runtime", liveness: "live" as const, outcome: null },
    liveContext = makeContext(liveSession, "node-a"),
    liveResult = await adoptRuntimes(liveContext);
  assert.equal(liveResult[0]?.outcome, "failed");
  assert.equal(liveSession.outcome, null);
  assert.deepEqual(published, []);

  const foreignSession = { runtimeSessionId: "foreign-runtime", liveness: "exited" as const, outcome: null },
    foreignContext = makeContext(foreignSession, "node-b"),
    foreignResult = await adoptRuntimes(foreignContext);
  assert.deepEqual(foreignResult, []);
  assert.equal(foreignSession.outcome, null);
  assert.deepEqual(published, []);
});

for (const fault of ["HEAD timeout", "HEAD signal", "runtime restoration rejected"]) {
  test(`${fault} is a per-runtime failure and another archived runtime still restores`, async (t) => {
    const error = Object.assign(new Error(fault), {
      code: fault === "HEAD timeout" ? "ETIMEDOUT" : "ERR_TEST",
      signal: "SIGTERM",
    });
    const { context, events, rootDir } = fixture(t, async (active) => {
      if (active.runtimeSessionId === "runtime-0") {
        if (fault.startsWith("HEAD")) await currentWorktreeHead(rootDir);
        else throw error;
      }
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
      ["failed", "settled"],
    );
    assert.equal(results[1]?.runtimeSessionId, "runtime-1");
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
  Object.assign(context, {
    publishRuntimeEvent: async (
      _type: string,
      _payload: unknown,
      _opId: string,
      binding: import("../src/runtime-spawn-types.ts").RuntimeBinding,
    ) => await work.write(() => undefined, binding),
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
  test(`one ${fault} remote lifecycle point-read does not hold another runtime`, async (t) => {
    const lookup = Promise.withResolvers<import("@harness-anything/kernel").DispatchLifecycleRead>(),
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
          async readRuntimeSession(id: string) {
            return (
              (await this.readRuntimeSessions()).find(
                (session: { readonly runtimeSessionId: string }) => session.runtimeSessionId === id,
              ) ?? null
            );
          },
          readRuntimeSessions: async () => projection.readRuntimeSessions(),
          readRuntimeDispatch: async (id: string) => projection.readRuntimeDispatch(id),
          readDispatchLifecycle: (query: import("@harness-anything/kernel").DispatchLifecycleQuery) => {
            if (query.by === "dispatch" && query.dispatchIds.includes("dispatch_111111111111111111111111"))
              return lookup.promise;
            return projection.readDispatchLifecycle(query);
          },
        },
      },
    } as RuntimeSpawnerContext;
    const recovery = adoptRuntimes(remoteContext);
    if (fault === "rejected") lookup.reject(new Error("lifecycle point-read unavailable"));
    try {
      await second.promise;
    } finally {
      lookup.resolve(
        projection.readDispatchLifecycle({
          by: "dispatch",
          dispatchIds: ["dispatch_111111111111111111111111"],
        }),
      );
      const result = await recovery;
      assert.equal(result[1]!.outcome, "settled");
      assert.equal(result[0]!.outcome, fault === "rejected" ? "failed" : "settled");
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
        async readRuntimeSession(id: string) {
          return (
            (await this.readRuntimeSessions()).find(
              (session: { readonly runtimeSessionId: string }) => session.runtimeSessionId === id,
            ) ?? null
          );
        },
        readRuntimeSessions: async () => projection.readRuntimeSessions(),
        readDispatchLifecycle: projection.readDispatchLifecycle,
        readRuntimeDispatch: async (id: string) => ({
          ...projection.readRuntimeDispatch(id)!,
          source: { kind: "node", nodeId: "node-a" },
        }),
      },
    },
  } as RuntimeSpawnerContext;
  const results = await adoptRuntimes(foreign);
  assert.deepEqual(results, []);
  assert.equal(foreign.processes.size, 0);
});
