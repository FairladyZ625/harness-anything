// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeJournaledWriteCoordinator, normalizeTaskLifecycleCommand } from "../../kernel/src/index.ts";
import { makeTaskEventStore, makeTaskLeaseStore, makeTaskProjection, TASK_LEASE_BROKER_CONTRACT, TaskLeaseConflictError } from "../../kernel/test/store/task-lifecycle-runtime.ts";
import { makeTaskLifecycleService, runTaskLifecycleEffect, TaskLifecycleOperationConflict } from "../src/task-lifecycle-service.ts";
import { lifecycleHarness, replayGraph } from "./task-lifecycle-test-harness.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "codex" } };
const command = <C extends Parameters<typeof normalizeTaskLifecycleCommand>[1]>(rootDir: string, intent: C, meta: { readonly eventId: string; readonly workspaceRevision: number; readonly occurredAt: string }, expectedRevision = meta.workspaceRevision - 1) =>
  ({ ...normalizeTaskLifecycleCommand({ workspaceId: rootDir, actor, source: "local", expectedRevision }, intent), ...meta });

test("transition service freezes targets and makes create/start idempotent by opId payload", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-service-"));
  try {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    const eventStore = makeTaskEventStore({ rootDir, coordinator });
    const projection = makeTaskProjection({ rootDir, eventStore });
    const leases = makeTaskLeaseStore({ rootDir, coordinator, runEffect: runTaskLifecycleEffect, now: () => "2026-08-11T00:00:00.000Z" });
    const service = makeTaskLifecycleService({ eventStore, projection, leases });
    const create = command(rootDir, { type: "CreateReplayTask" as const, taskId: "task-1", title: "Replay task", graph: replayGraph,
      completionGateIds: [] }, { eventId: "event-create", workspaceRevision: 1, occurredAt: "2026-08-11T00:00:00.000Z" });
    const createProof = { taskIdUnique: true as const, actorBinding: actor };
    const created = await service.execute(create, createProof);

    assert.equal(created.outcome, "applied");
    assert.equal((await service.execute(create, createProof)).revision, 1);
    assert.equal(Object.isFrozen(created.frozenPlan), true);
    assert.equal(Object.isFrozen(created.frozenPlan.targets), true);
    await assert.rejects(service.execute({ ...create, title: "Different" }, createProof), TaskLifecycleOperationConflict);

    const started = await service.execute(command(rootDir, {
      type: "StartExecution", taskId: "task-1", executionId: "execution-1"
    }, { eventId: "event-start", workspaceRevision: 2, occurredAt: "2026-08-11T00:01:00.000Z" }), {
      actorBinding: actor,
      reservation: { taskId: "task-1", executionId: "execution-1", expiresAt: "2026-08-11T01:00:00.000Z", ttlMs: 1_800_000,
        previousHolder: null, reason: "initial_claim", version: 0 }
    });

    assert.equal(started.outcome, "applied");
    assert.equal(started.snapshot.lease?.phase, "active");
    assert.equal(started.snapshot.executions[0]?.state, "active");
    assert.equal(JSON.stringify(eventStore.read().events).includes("credential"), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("second distinct task create uses aggregate revision zero in a non-empty workspace", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-two-tasks-"));
  try {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    const eventStore = makeTaskEventStore({ rootDir, coordinator });
    const projection = makeTaskProjection({ rootDir, eventStore });
    const leases = makeTaskLeaseStore({ rootDir, coordinator, runEffect: runTaskLifecycleEffect, now: () => "2026-08-11T00:00:00.000Z" });
    const service = makeTaskLifecycleService({ eventStore, projection, leases });
    const create = (taskId: string, title: string, revision: number) => command(rootDir, {
      type: "CreateReplayTask" as const, taskId, title, graph: replayGraph, completionGateIds: []
    }, { eventId: `event-create-${revision}`, workspaceRevision: revision, occurredAt: `2026-08-11T00:0${revision}:00.000Z` }, 0);
    await service.execute(create("task-1", "First task", 1), { taskIdUnique: true, actorBinding: actor });
    const second = await service.execute(create("task-2", "Second task", 2), { taskIdUnique: true, actorBinding: actor });
    assert.equal(second.snapshot.task?.taskId, "task-2");
    assert.equal(second.snapshot.revision, 2);
    assert.equal(eventStore.read().events.length, 2);
    await assert.rejects(() => service.execute(create("task-2", "Duplicate task", 3), { taskIdUnique: true, actorBinding: actor }));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("transition service replays reject through a new Execution before completion", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1");
    await harness.review("execution-1", "anti_entropy", "changes_requested");
    await harness.start("execution-2");
    await harness.submit("execution-2");
    await harness.review("execution-2", "anti_entropy", "approved");
    await harness.review("execution-2", "acceptance", "approved");
    const completed = await harness.complete("execution-2");

    assert.equal(completed.snapshot.task?.status, "done");
    assert.equal(completed.snapshot.task?.iteration, 1);
    assert.deepEqual(completed.snapshot.executions.map((execution) => execution.state), ["changes_requested", "accepted"]);
    assert.deepEqual(completed.snapshot.edgesTaken.map((edge) => edge.on), ["submitted", "changes_requested", "submitted", "approved"]);
  } finally {
    harness.cleanup();
  }
});

test("lease broker capacity ceiling rejects concurrent exhaustion and release restores availability", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lease-capacity-"));
  const now = () => "2026-08-11T00:00:00.000Z";
  const store = () => makeTaskLeaseStore({
    rootDir,
    coordinator: makeJournaledWriteCoordinator({ rootDir, lockConflictRetry: { maxWaitMs: 2_000 } }),
    runEffect: runTaskLifecycleEffect,
    now
  });
  try {
    const leases = store();
    for (let index = 0; index < TASK_LEASE_BROKER_CONTRACT.capacity - 1; index += 1) {
      await leases.reserve({
        taskId: `task-cap-${index}`, executionId: `execution-cap-${index}`, actor, source: "local",
        expiresAt: "2026-08-11T01:00:00.000Z", ttlMs: 1_800_000
      });
    }
    const contenders = ["left", "right"].map(async (id) => store().reserve({
      taskId: `task-${id}`, executionId: `execution-${id}`, actor, source: "local",
      expiresAt: "2026-08-11T01:00:00.000Z", ttlMs: 1_800_000
    }));
    const results = await Promise.allSettled(contenders);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected?.status, "rejected");
    assert.equal(rejected?.status === "rejected" && rejected.reason instanceof TaskLeaseConflictError, true);
    assert.equal(rejected?.status === "rejected" ? rejected.reason.code : "", "lease_capacity_exhausted",
      rejected?.status === "rejected" ? rejected.reason.message : "missing rejection");
    assert.match(rejected?.status === "rejected" ? rejected.reason.message : "", /capacity.*exhausted.*released or expire/iu);

    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("capacity contender did not win");
    await leases.release({
      taskId: winner.value.taskId, executionId: winner.value.executionId,
      actor: winner.value.actor, source: winner.value.source, version: winner.value.version
    });
    const loserId = winner.value.taskId === "task-left" ? "right" : "left";
    const recovered = await store().reserve({
      taskId: `task-${loserId}`, executionId: `execution-${loserId}`, actor, source: "local",
      expiresAt: "2026-08-11T01:00:00.000Z", ttlMs: 1_800_000
    });
    assert.equal(recovered.taskId, `task-${loserId}`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
