// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  emptyDispatchLifecycleProjection,
  readDispatchLifecycle,
  reduceDispatchLifecycle,
  type DispatchLifecycleEvent,
  type DispatchLifecycleProjection,
  type RuntimeSession,
} from "@harness-anything/kernel";
import { makeAgentRuntimeStreamHub } from "../src/agent-runtime-stream.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import { makeRuntimeSpawner } from "../src/runtime-spawner.ts";

const repoId = "lifecycle-adoption",
  dispatchId = "dispatch_0a0b0c0d0e0f101112131415",
  runtimeSessionId = "runtime-lifecycle-adoption",
  instanceId = "adoption-instance",
  previousOwner = { ownerId: "daemon-before-restart", epoch: 1 },
  restartedOwner = { ownerId: "daemon-after-restart", epoch: 2 },
  actor = { principal: { personId: "owner" }, executor: null };

/** A worker host in its own process group, so a mistaken stop cannot reach the test runner. */
function startWorker(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { detached: true, stdio: "ignore" });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lifecycleEvent(
  type: "dispatch_admitted" | "process_started",
  expectedGroupVersion: number,
): DispatchLifecycleEvent {
  return {
    schema: "dispatch-lifecycle-event/v1",
    source: "center",
    eventId: `seed-${type}`,
    repoId,
    attemptGroupId: dispatchId,
    dispatchId,
    expectedGroupVersion,
    ownerFence: previousOwner,
    type,
    ...(type === "dispatch_admitted"
      ? { instanceId, runtimeSessionId, reservationId: dispatchId, capacityLimit: 64 }
      : {}),
  } as DispatchLifecycleEvent;
}

/** Restart harness: the canonical lifecycle is the kernel reducer behind a single-writer commit. */
function restartedDaemon(input: {
  readonly rootDir: string;
  readonly pid: number;
  readonly seededPhase: "starting" | "running";
  readonly centerReachable: () => boolean;
}) {
  let lifecycle: DispatchLifecycleProjection = emptyDispatchLifecycleProjection(),
    revision = 0;
  const accept = (event: DispatchLifecycleEvent) => {
    lifecycle = reduceDispatchLifecycle(lifecycle, event, ++revision).projection;
  };
  accept(lifecycleEvent("dispatch_admitted", 0));
  if (input.seededPhase === "running") accept(lifecycleEvent("process_started", 1));
  const session = {
      runtimeSessionId,
      instanceId,
      providerSessionId: null,
      outcome: null,
      liveness: "live",
      attachable: true,
      taskBindings: [],
      lastObservedAt: "2026-11-08T00:00:00.000Z",
    } as unknown as RuntimeSession,
    lifecycleObservations: DispatchLifecycleEvent[] = [],
    launches: string[] = [],
    projection = {
      readRuntimeSessions: () => [session],
      readRuntimeSession: () => session,
      readRuntimeDispatch: () => ({ actor, source: "local", payload: { dispatchId } }),
      readDispatchLifecycle: (query: Parameters<typeof readDispatchLifecycle>[1]) =>
        readDispatchLifecycle(lifecycle, query),
    },
    hub = makeAgentRuntimeStreamHub({ readSession: () => session, canAttach: () => false });
  openDispatchStream(input.rootDir, {
    dispatchId,
    runtimeSessionId,
    taskId: null,
    executionId: null,
    instanceId,
    startedAt: session.lastObservedAt,
    dispatchOpId: dispatchId,
    kindId: "codex",
    permissionMode: "read-only",
    binding: { actor, source: "local" },
    cwd: input.rootDir,
    prompt: "survive the daemon restart",
    model: "test",
    reasoningEffort: null,
  });
  appendRuntimeWorkerRecord(input.rootDir, dispatchId, { kind: "process_started", pid: input.pid });
  const runtime = makeRuntimeSpawner({
    repoId,
    rootDir: input.rootDir,
    daemonGeneration: 2,
    now: () => "2026-11-08T00:01:00.000Z",
    stream: hub,
    projection: () => projection as never,
    writerEpochFence: () =>
      ({
        schema: "harness-writer-epoch-fence/v1",
        stateRoot: input.rootDir,
        repoId,
        holderId: restartedOwner.ownerId,
        epoch: restartedOwner.epoch,
      }) as never,
    prepareLaunch: async () => {
      launches.push(dispatchId);
      throw new Error("adoption must never relaunch a dispatch");
    },
    schedule: async (work) => {
      await work();
    },
    commitRuntimeEvent: async (draft) => {
      if (draft.type === "runtime_dispatch_lifecycle_observed") {
        if (!input.centerReachable()) throw Object.assign(new Error("center unavailable"), { code: "center_down" });
        const event = (draft.payload as { readonly lifecycle: DispatchLifecycleEvent }).lifecycle;
        accept(event);
        lifecycleObservations.push(event);
      }
      return {
        event: { schema: "agent-runtime-event/v1", type: draft.type, payload: draft.payload } as never,
        receipt: { outcome: "applied" },
      };
    },
  } as never);
  return {
    runtime,
    hub,
    launches,
    lifecycleObservations,
    group: () => lifecycle.groups[dispatchId]!,
  };
}

for (const seededPhase of ["starting", "running"] as const) {
  test(`a live ${seededPhase} worker is adopted once after restart, renews the owner fence, and is not killed`, async (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-adopt-alive-")),
      worker = startWorker();
    t.after(() => {
      worker.kill("SIGKILL");
      rmSync(rootDir, { recursive: true, force: true });
    });
    const daemon = restartedDaemon({ rootDir, pid: worker.pid!, seededPhase, centerReachable: () => true });
    try {
      const [first, concurrent] = await Promise.all([daemon.runtime.adopt(), daemon.runtime.adopt()]);
      const again = await daemon.runtime.adopt();
      assert.deepEqual(
        [first, concurrent, again].map((results) => results.map(({ outcome }) => outcome)),
        [["ready"], ["ready"], ["ready"]],
      );
      assert.deepEqual(
        daemon.lifecycleObservations.map(({ type, ownerFence }) => [type, ownerFence]),
        [["adopted_process_observed", restartedOwner]],
        "the same live attempt is adopted exactly once",
      );
      const group = daemon.group();
      assert.equal(group.phase, "running", "a live starting attempt is confirmed running, never restarted");
      assert.deepEqual(group.ownerFence, restartedOwner);
      assert.equal(group.attempts.length, 1);
      assert.equal(group.attempts[0]?.capacity, "held");
      assert.equal(alive(worker.pid!), true, "adoption must not kill a live worker");
      assert.deepEqual(daemon.launches, [], "adoption must not relaunch");
    } finally {
      daemon.runtime.close();
      daemon.hub.close();
    }
  });
}

test("a missing PID after restart enters loss reconciliation under the restarted owner fence", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-adopt-lost-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const daemon = restartedDaemon({ rootDir, pid: 2_147_483_647, seededPhase: "running", centerReachable: () => true });
  try {
    const [recovery] = await daemon.runtime.adopt();
    assert.equal(recovery?.outcome, "ready");
    const observed = daemon.lifecycleObservations.map(({ type }) => type);
    // Adoption records the absent process and the loss under its renewed fence before any
    // settlement fact; the loss itself is an observation, and only the settlement path closes it.
    assert.deepEqual(observed.slice(0, 2), ["adopted_process_observed", "process_lost"]);
    assert.ok(
      observed.indexOf("process_lost") < observed.indexOf("process_stop_proven") ||
        !observed.includes("process_stop_proven"),
      observed.join(","),
    );
    assert.ok(
      daemon.lifecycleObservations.every(({ ownerFence }) => ownerFence?.epoch === restartedOwner.epoch),
      "every reconciliation fact is published under the restarted owner fence",
    );
    const group = daemon.group();
    assert.equal(group.attempts[0]?.process, "lost");
    assert.notEqual(group.phase, "running", "a missing PID never stays live");
    assert.deepEqual(daemon.launches, []);
  } finally {
    daemon.runtime.close();
    daemon.hub.close();
  }
});

test("an unreachable center neither relaunches nor releases the reservation of a live worker", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-adopt-offline-")),
    worker = startWorker();
  t.after(() => {
    worker.kill("SIGKILL");
    rmSync(rootDir, { recursive: true, force: true });
  });
  let reachable = false;
  const daemon = restartedDaemon({
    rootDir,
    pid: worker.pid!,
    seededPhase: "starting",
    centerReachable: () => reachable,
  });
  try {
    const [first] = await daemon.runtime.adopt();
    assert.equal(first?.outcome, "failed");
    assert.match(String(first?.error), /center unavailable/u);
    reachable = true;
    const [retry] = await daemon.runtime.adopt();
    assert.equal(retry?.outcome, "ready", "the live worker stays owned; recovery does not start it again");
    assert.deepEqual(daemon.lifecycleObservations, [], "no fact is published under the superseded owner fence");
    const group = daemon.group();
    assert.deepEqual(
      [group.phase, group.attempts[0]?.capacity, group.ownerFence],
      ["starting", "reserved", previousOwner],
      "the accepted reservation is kept unchanged while the center is unreachable",
    );
    assert.equal(alive(worker.pid!), true);
    assert.deepEqual(daemon.launches, []);
  } finally {
    daemon.runtime.close();
    daemon.hub.close();
  }
});
