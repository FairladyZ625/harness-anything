// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { normalizeTaskLifecycleCommand, type TaskEventV1 } from "../../kernel/src/index.ts";
import { makeTaskEventStore, makeTaskProjection, serializeEventHead, serializeTaskEvent, TASK_LEASE_BROKER_CONTRACT } from "../../kernel/test/store/task-lifecycle-runtime.ts";
import { makeTaskLifecycleService, TaskLifecycleOperationConflict } from "../src/task-lifecycle-service.ts";
import { lifecycleHarness, replayGraph } from "./task-lifecycle-test-harness.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "codex" } };
const command = <C extends Parameters<typeof normalizeTaskLifecycleCommand>[1]>(rootDir: string, intent: C, meta: { readonly eventId: string; readonly workspaceRevision: number; readonly occurredAt: string }, expectedRevision = meta.workspaceRevision - 1) =>
  ({ ...normalizeTaskLifecycleCommand({ workspaceId: rootDir, actor, source: "local", expectedRevision }, intent), ...meta });

test("transition service freezes targets and makes create/start idempotent by opId payload", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-service-"));
  try {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore });
    const service = makeTaskLifecycleService({ eventStore, projection });
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
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore });
    const service = makeTaskLifecycleService({ eventStore, projection });
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

test("10,000 old events do not block a new write", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-10k-"));
  try {
    initRepo(rootDir);
    const eventsRoot = path.join(rootDir, "harness/events");
    mkdirSync(eventsRoot, { recursive: true });
    let last = oldTaskEvent(1);
    for (let revision = 1; revision <= 10_000; revision += 1) {
      last = oldTaskEvent(revision);
      writeFileSync(path.join(eventsRoot, `${last.opId}.json`), serializeTaskEvent(last));
    }
    const lastBytes = serializeTaskEvent(last);
    writeFileSync(path.join(eventsRoot, "head.json"), serializeEventHead({ revision: last.workspaceRevision, opId: last.opId,
      eventDigest: `sha256:${createHash("sha256").update(lastBytes).digest("hex")}` }));
    git(rootDir, "add", "--", "harness/events");
    git(rootDir, "commit", "--quiet", "-m", "10k old event fixture");

    const started = performance.now();
    const checkpoints = new Map<string, number>();
    const eventStore = makeTaskEventStore({ rootDir, killpoint: (point) => checkpoints.set(point, performance.now() - started) });
    const storeReady = performance.now();
    const phase = { readMs: 0, appendMs: 0, applyMs: 0, maxAccessedItems: 0 };
    const boundedEventStore = { ...eventStore, readBatch: (cursor: string | null, maxItems: number) => {
      const batch = eventStore.readBatch(cursor, maxItems);
      phase.maxAccessedItems = Math.max(phase.maxAccessedItems, batch.accessedItems);
      return batch;
    } };
    const projection = makeTaskProjection({ rootDir, eventStore: boundedEventStore });
    const service = makeTaskLifecycleService({
      eventStore: { ...boundedEventStore, append: (candidate) => {
        const phaseStarted = performance.now(); try { return eventStore.append(candidate); } finally { phase.appendMs += performance.now() - phaseStarted; }
      } },
      projection: { ...projection, read: (taskId) => {
        const phaseStarted = performance.now(); try { return projection.read(taskId); } finally { phase.readMs += performance.now() - phaseStarted; }
      }, apply: (candidate) => {
        const phaseStarted = performance.now(); try { return projection.apply(candidate); } finally { phase.applyMs += performance.now() - phaseStarted; }
      } }
    });
    const create = command(rootDir, { type: "CreateReplayTask" as const, taskId: "task-new", title: "New independent task",
      graph: replayGraph, completionGateIds: [] }, { eventId: "event-new", workspaceRevision: 10_001,
      occurredAt: "2026-08-12T00:00:00.000Z" }, 0);
    const receipt = await service.execute(create, { taskIdUnique: true, actorBinding: actor });
    const elapsedMs = performance.now() - started;

    context.diagnostic(`first-store-access-through-receipt elapsedMs=${elapsedMs.toFixed(3)} storeInitMs=${(storeReady - started).toFixed(3)} readMs=${phase.readMs.toFixed(3)} appendMs=${phase.appendMs.toFixed(3)} applyMs=${phase.applyMs.toFixed(3)}`);
    context.diagnostic(`publication checkpoints=${JSON.stringify(Object.fromEntries(checkpoints))}`);
    assert.notEqual(eventStore.readEvent(create.opId), null, "the independent write must enter L1");
    assert.equal(receipt.outcome, "pending", "L1 may lead the bounded L2 catch-up");
    assert.equal(phase.maxAccessedItems <= 64, true, `catch-up accessed ${phase.maxAccessedItems} event files`);
    assert.equal(elapsedMs < 250, true, `first store access through receipt took ${elapsedMs}ms`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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

test("second lifecycle claim uses monotonic lease CAS", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1");
    await harness.review("execution-1", "anti_entropy", "changes_requested");
    await harness.start("execution-2");

    const claims = harness.eventStore.read().events.filter((candidate) => candidate.type === "execution_started");
    assert.equal(claims.length, 2);
    const first = claims[0]!;
    const second = claims[1]!;
    if (first.type !== "execution_started" || second.type !== "execution_started") throw new Error("fixture requires claim events");
    assert.equal(second.payload.lease.version > first.payload.lease.version, true);
    assert.deepEqual(second.payload.previousHolder, {
      taskId: first.taskId, executionId: first.payload.execution.executionId, actor: first.actor, source: first.source
    });
    assert.equal(second.payload.reason, "same_principal_reconnect");
    assert.deepEqual(harness.projection.currentLease("task-1"), second.payload.lease);
  } finally {
    harness.cleanup();
  }
});

test("SQLite/response killpoints reconstruct the exact applied receipt by opId without another commit", async () => {
  for (const point of ["after_sqlite_commit", "before_response_write", "after_response_write"] as const) {
    const rootDir = mkdtempSync(path.join(tmpdir(), `ha-response-${point}-`));
    try {
      initRepo(rootDir);
      const eventStore = makeTaskEventStore({ rootDir });
      const projection = makeTaskProjection({ rootDir, eventStore });
      let armed = true;
      const interrupted = makeTaskLifecycleService({ eventStore, projection, killpoint: (candidate) => {
        if (armed && candidate === point) { armed = false; throw new Error(`killpoint:${point}`); }
      } });
      const create = command(rootDir, { type: "CreateReplayTask" as const, taskId: "task-1", title: "Replay task", graph: replayGraph,
        completionGateIds: [] }, { eventId: "event-create", workspaceRevision: 1, occurredAt: "2026-08-11T00:00:00.000Z" });
      const proof = { taskIdUnique: true as const, actorBinding: actor };
      await assert.rejects(interrupted.execute(create, proof), new RegExp(`killpoint:${point}`, "u"));
      const commitCount = git(rootDir, "rev-list", "--count", "HEAD").trim();
      const published = eventStore.readEvent(create.opId);
      if (published === null) throw new Error(`${point} did not publish an event`);
      const eventBytes = serializeTaskEvent(published);
      const digest = `sha256:${createHash("sha256").update(eventBytes).digest("hex")}` as const;
      assert.equal(readFileSync(path.join(rootDir, `harness/events/${create.opId}.json`), "utf8"), eventBytes);
      assert.equal(readFileSync(path.join(rootDir, "harness/events/head.json"), "utf8"),
        serializeEventHead({ revision: 1, opId: create.opId, eventDigest: digest }));

      const resumed = makeTaskLifecycleService({ eventStore, projection });
      const first = await resumed.execute(create, proof);
      const second = await resumed.execute(create, proof);
      assert.equal(first.outcome, "applied", point);
      assert.deepEqual(second, first, point);
      assert.equal(projection.readOperation(create.opId)?.event.opId, create.opId);
      assert.equal(git(rootDir, "rev-list", "--count", "HEAD").trim(), commitCount);
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
  }
});

test("lease broker capacity ceiling rejects concurrent exhaustion and release restores availability", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lease-capacity-"));
  try {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore });
    const lease = (id: string) => ({ schema: "lease/v1" as const, taskId: `task-${id}`, executionId: `execution-${id}`, actor, source: "local" as const,
      phase: "reserving" as const, expiresAt: "2026-08-11T01:00:00.000Z", ttlMs: 1_800_000, version: 0 });
    for (let index = 0; index < TASK_LEASE_BROKER_CONTRACT.capacity; index += 1) {
      projection.reserveLease(lease(`cap-${index}`), "2026-08-11T00:00:00.000Z");
    }
    assert.throws(() => projection.reserveLease(lease("overflow"), "2026-08-11T00:00:00.000Z"), /capacity.*exhausted/iu);
    projection.releaseLease(projection.currentLease("task-cap-0")!);
    assert.equal(projection.reserveLease(lease("recovered"), "2026-08-11T00:00:00.000Z").taskId, "task-recovered");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Lifecycle Service Test");
  git(rootDir, "config", "user.email", "service-test@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

function oldTaskEvent(revision: number): Extract<TaskEventV1, { readonly type: "task_created" }> {
  const suffix = String(revision).padStart(5, "0");
  const taskId = `task-old-${suffix}`;
  return {
    schema: "task-event/v1", eventId: `event-old-${suffix}`, workspaceRevision: revision, opId: `op-old-${suffix}`, taskId,
    type: "task_created", actor, source: "local", occurredAt: "2026-08-11T00:00:00.000Z",
    payload: { task: { schema: "task/v1", taskId, title: `Old task ${suffix}`, status: "planned", graph: replayGraph,
      currentNode: "implementation", iteration: 0, createdBy: actor, completionGateIds: [] } }
  };
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
