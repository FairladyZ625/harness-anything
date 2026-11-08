// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeEventV1, DispatchLifecycleRead } from "@harness-anything/kernel";
import { makeRuntimeSpawner } from "../src/runtime-spawn.ts";
import { definition, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";
import { readEdgeDispatchLifecycle } from "../src/fleet-edge-task-read.ts";

const nodeA = { kind: "node", nodeId: "node-a" } as const,
  nodeB = { kind: "node", nodeId: "node-b" } as const,
  binding = { actor: { principal: { personId: "owner" }, executor: null }, source: nodeA };

/**
 * Admission on an edge node reads only the dispatch lifecycle port. The canonical session list
 * deliberately disagrees with it (every session looks unsettled and unobservable), and no local
 * process table or dispatch stream exists, so a pass or refusal can only come from the aggregate.
 */
function admission(t: test.TestContext, events: AgentRuntimeEventV1[], read = dispatchLifecycleReadOf(() => events)) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-dispatch-admission-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const prepared = Object.assign(new Error("admission reached the launch port"), { code: "fixture_prepared" }),
    spawner = makeRuntimeSpawner({
      rootDir,
      repoId: "dispatch-admission",
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
          throw new Error("taskless admission must not request task context");
        },
        readRuntimeSession: async () => null,
        readRuntimeSessions: async () =>
          events
            .filter((event) => event.type === "runtime_dispatch_requested")
            .map((event) => ({
              runtimeSessionId: (event.payload as { runtimeSessionId: string }).runtimeSessionId,
              instanceId: definition.instanceId,
              providerSessionId: null,
              liveness: "unknown" as const,
              outcome: null,
            })),
        readRuntimeDispatch: async () => null,
        readDispatchLifecycle: read,
        publish: async () => {
          throw new Error("an admission probe must not publish a dispatch");
        },
        archive: async () => ({ outcome: "applied" }),
      } as never,
    });
  t.after(() => spawner.close());
  return {
    prepared,
    spawn: () =>
      spawner.spawn(
        {
          runtimeInstanceId: definition.instanceId,
          prompt: "admit",
          cwd: { scope: "repo-root" },
          dispatchKey: "admit",
        },
        binding,
      ),
  };
}

const on = (source: AgentRuntimeEventV1["source"], instanceId = definition.instanceId) => ({ source, instanceId });

test("an attempt whose owner cannot observe its process blocks only that owner's admission", async (t) => {
  const events = [
    lifecycleEvent("R", "unobservable", on(nodeA)),
    lifecycleEvent("S", "unobservable", on(nodeA)),
    lifecycleEvent("L", "unobservable", { ...on(nodeA), liveness: "unknown" }),
  ];
  const blocked = admission(t, events);
  await assert.rejects(blocked.spawn(), { code: "runtime_recovery_pending", message: /unresolved capacity/u });
  // Once the owner observes the process again, the same instance admits the next dispatch.
  events.push(lifecycleEvent("L", "unobservable", { ...on(nodeA), liveness: "live" }));
  await assert.rejects(blocked.spawn(), blocked.prepared);
});

test("running, exited, foreign and undispatched sessions never block admission", async (t) => {
  const events = [
    // Running on this node (the restart-adoption gap): capacity is held, admission still proceeds.
    lifecycleEvent("R", "running", on(nodeA)),
    lifecycleEvent("S", "running", on(nodeA)),
    // Exited without a settled outcome: the owner observed the stop, so the slot is free.
    lifecycleEvent("R", "exited", on(nodeA)),
    lifecycleEvent("S", "exited", on(nodeA)),
    lifecycleEvent("X", "exited", on(nodeA)),
    // Another node's unobservable attempt is that node's recovery, not this node's admission.
    lifecycleEvent("R", "foreign", on(nodeB)),
    lifecycleEvent("S", "foreign", on(nodeB)),
    lifecycleEvent("L", "foreign", { ...on(nodeB), liveness: "unknown" }),
    // A session no dispatch admitted is not a dispatch.
    lifecycleEvent("S", "undispatched", on(nodeA)),
    lifecycleEvent("L", "undispatched", { ...on(nodeA), liveness: "unknown" }),
    // An unobservable attempt on a different instance.
    lifecycleEvent("R", "elsewhere", on(nodeA, "another-instance")),
    lifecycleEvent("L", "elsewhere", { ...on(nodeA, "another-instance"), liveness: "unknown" }),
  ];
  const probe = admission(t, events);
  await assert.rejects(probe.spawn(), probe.prepared);
});

test("a lifecycle read model behind its source fails admission closed", async (t) => {
  const pending = async (): Promise<DispatchLifecycleRead> => ({ status: "pending", watermark: 4, sourceRevision: 9 });
  const probe = admission(t, [], pending);
  await assert.rejects(probe.spawn(), { code: "dispatch_lifecycle_pending", message: /revision 4 of 9/u });
});

test("an attempt whose owner the center cannot verify fails every launcher's admission on its instance closed", async (t) => {
  const events = [lifecycleEvent("R", "imported", on("migration-import/v1"))];
  const probe = admission(t, events);
  await assert.rejects(probe.spawn(), { code: "dispatch_owner_unverified" });
});

test("a stale edge replica answers pending, so edge admission fails closed", async (t) => {
  const fresh = { state: "fresh", ageMs: 0, lagRevisions: 0, maxAgeMs: 60_000, maxLagRevisions: 32, confirmedAt: "x" },
    projection = {
      readDispatchLifecycle: () => ({ status: "ready", watermark: 7, sourceRevision: 7, rows: [], nextCursor: null }),
    },
    query = { by: "active", limit: 100 } as const,
    cut = { revision: 7, headDigest: "sha256:x" };
  assert.equal(
    readEdgeDispatchLifecycle(projection as never, { cut, freshness: fresh } as never, query).status,
    "ready",
  );
  const stale = readEdgeDispatchLifecycle(
    projection as never,
    { cut, freshness: { ...fresh, state: "stale", ageMs: 120_000, lagRevisions: 3 } } as never,
    query,
  );
  assert.deepEqual(stale, { status: "pending", watermark: 7, sourceRevision: 10 });
  const probe = admission(t, [], async () => stale);
  await assert.rejects(probe.spawn(), { code: "dispatch_lifecycle_pending" });
});
