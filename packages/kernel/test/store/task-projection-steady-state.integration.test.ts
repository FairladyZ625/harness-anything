// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { compileEntityUpsert } from "../../src/domain/entity-event-compile.ts";
import type { TaskEventV1 } from "../../src/domain/task-lifecycle.contract.ts";
import { serializeCanonicalEvent, type CanonicalEventV1 } from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { lifecycleFixture, twoRoundLifecycleEvents } from "./task-lifecycle-fixture.ts";
import { withTempStoreAsync } from "./helpers.ts";
test("steady apply reads only the projection rows its event touches", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const [first, ...rest] = lifecycleFixture().events;
    eventStore.append(taskBundle(first!));
    projection.apply(first!);
    // Task lifecycle events never write decision content pins; any whole-state scan would still read the table.
    const db = new DatabaseSync(projection.path);
    db.exec("DROP TABLE decision_content_pin");
    db.close();
    for (const event of rest) {
      eventStore.append(taskBundle(event));
      assert.deepEqual(projection.apply(event).metrics, { sqliteTransactions: 1, reducedItems: 1 });
    }
    assert.equal(projection.read("task-1").snapshot.task?.status, "done");
    projection.close();
  });
});
// harness-contract: projection.deterministic-rebuild
test("steady apply and rebuild use the same reducer and reproduce watermark, op index, lease intervals", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    for (const event of lifecycleFixture().events) {
      eventStore.append(taskBundle(event));
      assert.deepEqual(projection.apply(event).metrics, { sqliteTransactions: 1, reducedItems: 1 });
    }

    const first = projection.read("task-1");
    assert.equal(first.status, "ready");
    assert.equal(first.watermark, 6);
    assert.equal(first.snapshot.task?.status, "done");
    assert.deepEqual(
      first.snapshot.executions.map((execution) => execution.state),
      ["accepted"],
    );
    const startOpId = lifecycleFixture().events[1]!.opId;
    assert.equal(projection.readOperation(startOpId)?.event.type, "execution_started");
    assert.deepEqual(projection.readWorkspaceSummary().summary.tasks, {
      total: 1,
      byStatus: { planned: 0, active: 0, blocked: 0, in_review: 0, done: 1, cancelled: 0, unknown: 0 },
    });
    assert.deepEqual(
      projection.readLeaseIntervals("task-1").map((interval) => ({
        executionId: interval.executionId,
        acquiredRevision: interval.acquiredRevision,
        releasedRevision: interval.releasedRevision,
        reason: interval.reason,
      })),
      [{ executionId: "execution-1", acquiredRevision: 2, releasedRevision: 3, reason: "initial_claim" }],
    );
    const firstDerivedRelations = projection
      .readRelationQuery()
      .rows.filter(({ relationType }) => relationType === "executes" || relationType === "reviews")
      .map(({ sourceRef, targetRef, relationType }) => ({ sourceRef, targetRef, relationType }))
      .sort((left, right) => left.relationType.localeCompare(right.relationType));
    assert.deepEqual(firstDerivedRelations, [
      { sourceRef: "execution/execution-1", targetRef: "task/task-1", relationType: "executes" },
      { sourceRef: "review/review-execution", targetRef: "execution/execution-1", relationType: "reviews" },
    ]);
    const incrementalStateDigest = projection.readStateDigest();
    if (incrementalStateDigest === null)
      assert.fail("a source-complete incremental projection must report its state digest");

    projection.close();
    rmSync(projection.path, { force: true });
    const rebuilt = projection.rebuild();
    assert.equal(rebuilt.watermark, 6);
    assert.equal(rebuilt.stateDigest, incrementalStateDigest);
    assert.equal(projection.readStateDigest(), incrementalStateDigest);
    assert.equal(rebuilt.metrics.reducedItems, 6);
    assert.equal(rebuilt.metrics.maxBatchItems <= 64, true);
    assert.deepEqual(projection.read("task-1").snapshot, first.snapshot);
    assert.deepEqual(
      projection
        .readRelationQuery()
        .rows.filter(({ relationType }) => relationType === "executes" || relationType === "reviews")
        .map(({ sourceRef, targetRef, relationType }) => ({ sourceRef, targetRef, relationType }))
        .sort((left, right) => left.relationType.localeCompare(right.relationType)),
      firstDerivedRelations,
    );
    assert.equal(projection.readOperation(startOpId)?.event.type, "execution_started");

    const db = new DatabaseSync(projection.path);
    assert.throws(() => db.prepare("UPDATE task_snapshot SET snapshot_json = 'not-json'").run(), /malformed JSON/u);
    db.close();
    assert.equal(projection.read("task-1").snapshot.task?.title, "Fixture");
    projection.rebuild();
    assert.equal(projection.read("task-1").snapshot.executions[0]?.state, "accepted");
  });
});
test("executions project in iteration order regardless of internal entity id ordering", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      { events } = twoRoundLifecycleEvents({
        taskId: "task-execution-order",
        // Alphabetically reversed against arrival order: a naive `ORDER BY entity_id`
        // would list the second round before the first.
        firstExecutionId: "execution-zz-round-one",
        secondExecutionId: "execution-aa-round-two",
      });
    for (const event of events) {
      eventStore.append(taskBundle(event));
      projection.apply(event);
    }
    assert.deepEqual(
      projection.read("task-execution-order").snapshot.executions.map((execution) => ({
        executionId: execution.executionId,
        iteration: execution.iteration,
      })),
      [
        { executionId: "execution-zz-round-one", iteration: 0 },
        { executionId: "execution-aa-round-two", iteration: 1 },
      ],
    );
  });
});
test("generic entity events project declaration documents without overriding lifecycle entities", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "generic-entity-projection", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      [created, started] = lifecycleFixture().events;
    if (created === undefined || started?.type !== "execution_started") throw new Error("fixture requires start event");
    eventStore.append(taskBundle(created));
    projection.apply(created);
    eventStore.append(taskBundle(started));
    projection.apply(started);
    const bundle = compileEntityUpsert({
      entityKind: "agent",
      entity: {
        schema: "agent-declaration/v1",
        id: "projection-agent",
        name: "Projection Agent",
        instructions: "Exercise the generic projection writer.",
        runtimes: [{ type: "codex" }],
      },
      eventId: "event-generic-agent",
      opId: "op-generic-agent",
      workspaceRevision: 3,
      actor: started.actor,
      source: started.source,
      occurredAt: "2026-08-11T00:03:00.000Z",
    });
    eventStore.append(bundle);
    projection.apply(bundle.event, bundle.plan);

    const listedAgents = projection.listEntities("agent");
    assert.deepEqual(
      listedAgents.map(({ kind, id, ownerId, workspaceRevision, value }) => ({
        kind,
        id,
        ownerId,
        workspaceRevision,
        name: value.name,
      })),
      [
        {
          kind: "agent",
          id: "projection-agent",
          ownerId: null,
          workspaceRevision: 3,
          name: "Projection Agent",
        },
      ],
    );
    assert.deepEqual(projection.getEntity("agent", "projection-agent"), listedAgents[0]);
    assert.equal(projection.getEntity("agent", "missing"), null);

    assert.equal(projection.read("task-1").snapshot.executions[0]?.state, "active");
    assert.deepEqual(
      projection
        .readRelationQuery()
        .rows.filter(({ relationType }) => relationType === "executes")
        .map(({ sourceRef, targetRef }) => ({ sourceRef, targetRef })),
      [{ sourceRef: "execution/execution-1", targetRef: "task/task-1" }],
    );
    const document = projection.readDocument("agents/projection-agent.json").document;
    assert.ok(document);
    assert.deepEqual(
      { path: document.path, workspaceRevision: document.workspaceRevision, id: JSON.parse(document.body).id },
      { path: "agents/projection-agent.json", workspaceRevision: 3, id: "projection-agent" },
    );
  });
});
test("historical agent entity envelopes replay into the generic entity projection", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const actor = lifecycleFixture().events[0]!.actor,
      bundle = compileEntityUpsert({
        entityKind: "agent",
        entity: {
          schema: "agent-declaration/v1",
          id: "historical-agent",
          name: "Historical Agent",
          instructions: "Remain readable after projection cutover.",
          runtimes: [{ type: "codex" }],
        },
        eventId: "event-historical-agent",
        opId: "op-historical-agent",
        workspaceRevision: 1,
        actor,
        source: "local",
        occurredAt: "2026-08-11T00:01:00.000Z",
      }),
      event = {
        ...bundle.event,
        schema: "agent-entity-event/v1",
        type: "agent_entity_written",
      } as unknown as CanonicalEventV1,
      body = bundle.blobs[0].body,
      bytes = new TextEncoder().encode(body),
      eventDigest = `sha256:${sha256Text(serializeCanonicalEvent(event))}` as const,
      eventStore = {
        readHead: () => ({ revision: 1, eventDigest }),
        readBatch: () => ({
          sourceRevision: 1,
          events: [event],
          cursor: null,
          done: true,
          accessedItems: 1,
          prefetchContent: () => new Map([[bundle.blobs[0].sha256, bytes]]),
        }),
        readContentBlob: (sha256: string) => (sha256 === bundle.blobs[0].sha256 ? bytes : null),
      },
      projection = makeTaskProjection({ rootDir, eventStore });
    try {
      projection.catchUp?.();
      const read = projection.getEntity("agent", "historical-agent");
      assert.deepEqual(
        read === null
          ? null
          : {
              kind: read.kind,
              id: read.id,
              ownerId: read.ownerId,
              workspaceRevision: read.workspaceRevision,
              name: read.value.name,
            },
        {
          kind: "agent",
          id: "historical-agent",
          ownerId: null,
          workspaceRevision: 1,
          name: "Historical Agent",
        },
      );
    } finally {
      projection.close();
    }
  });
});
test("stale persistent event projection schema is discarded and replayed from the ledger", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      created = lifecycleFixture().events[0]!;
    eventStore.append(taskBundle(created));
    const projectionPath = path.join(rootDir, ".harness/cache/task.sqlite");
    mkdirSync(path.dirname(projectionPath), { recursive: true });
    const stale = new DatabaseSync(projectionPath);
    stale.exec(
      "CREATE TABLE projection_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), watermark INTEGER NOT NULL, scan_cursor TEXT, scanned_revision INTEGER NOT NULL); INSERT INTO projection_meta VALUES (1, 1, NULL, 1)",
    );
    stale.close();

    const projection = makeTaskProjection({ rootDir, eventStore });
    projection.catchUp?.();
    const read = projection.read(created.taskId);
    assert.equal(read.status, "ready");
    assert.equal(read.snapshot.task?.taskId, created.taskId);
    assert.equal(read.watermark, 1);
    t.diagnostic(JSON.stringify({ case: "complete-stream-schema-rebuild", sourceRevision: 1, watermark: 1 }));
  });
});
test("squad run cache rows are replaceable, monotonic, and cleared for stream replay on rebuild", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      initial = {
        squadRunId: "squad_0123456789abcdef01234567",
        revision: 2,
        state: { schema: "squad-run/v1", phase: "leader_running" },
      };
    assert.equal(projection.squadRunProjectionReady(), false);
    projection.replaceSquadRuns([initial]);
    assert.equal(projection.squadRunProjectionReady(), true);
    assert.deepEqual(projection.readSquadRun(initial.squadRunId), initial);
    projection.upsertSquadRun({ ...initial, revision: 1, state: { phase: "stale" } });
    assert.deepEqual(projection.readSquadRun(initial.squadRunId), initial);
    projection.markSquadRunProjectionDirty();
    assert.equal(projection.squadRunProjectionReady(), false);
    projection.upsertSquadRun({ ...initial, revision: 3, state: { phase: "converged" } });
    assert.equal(projection.squadRunProjectionReady(), true);
    assert.equal(projection.readSquadRun(initial.squadRunId)?.revision, 3);
    projection.rebuild();
    assert.equal(projection.squadRunProjectionReady(), false);
    assert.deepEqual(projection.readSquadRuns(), []);
  });
});
// The title's "64-item/100ms" is pinned by check-implementation-contracts.mjs and no longer
// describes this test: it runs at catchUpLimit 2, and the 100ms budget was an unenforced
// literal removed with the receipt field that carried it. Renaming needs that gate updated.
test("completion lookup answers from the projection index and stays scoped to one task and execution", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      events = lifecycleFixture().events;
    const completion = events.find((event) => event.type === "task_completed")!;
    for (const event of events) {
      eventStore.append(taskBundle(event));
      projection.apply(event);
    }
    assert.deepEqual(
      projection.readTaskRuntimeBatch({ taskIds: ["task-1"] }).rows.map(({ taskId, title }) => ({ taskId, title })),
      [{ taskId: "task-1", title: "Fixture" }],
    );
    assert.deepEqual(projection.readTaskCompletion("task-1", "execution-1"), completion);
    assert.equal(projection.readTaskCompletion("task-1", "execution-2"), null);
    assert.equal(projection.readTaskCompletion("task-2", "execution-1"), null);
    // A completion published to the store but not yet reduced must still be found, or a crash between publication and
    // projection would report the write as unpublished and invite a duplicate attempt.
    const lagging = makeTaskProjection({ rootDir, eventStore, projectionPath: `${projection.path}.lagging` });
    for (const event of events.filter((event) => event.type !== "task_completed")) lagging.apply(event);
    assert.deepEqual(lagging.readTaskCompletion("task-1", "execution-1"), completion);
  });
});
// harness-contract: projection.bounded-catch-up-no-stale-ready
test("projection catch-up processes at most one bounded round and never reports stale data ready", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    for (const event of lifecycleFixture().events) eventStore.append(taskBundle(event));
    const projection = makeTaskProjection({
      rootDir,
      eventStore,
      catchUpLimit: 2,
      now: () => "2026-08-11T00:30:00.000Z",
    });

    const before = projection.read("task-1");
    assert.deepEqual(
      { status: before.status, watermark: before.watermark, sourceRevision: before.sourceRevision },
      { status: "pending", watermark: 0, sourceRevision: 6 },
    );
    assert.deepEqual(before.catchUp, { maxItems: 2, reducedItems: 0, sqliteTransactions: 0 });

    const catchUp = projection.catchUp!(),
      read = projection.read("task-1");
    assert.equal(catchUp.metrics.maxBatchItems <= 2, true);
    assert.equal(catchUp.metrics.reducedItems, 6);
    assert.deepEqual(
      { status: read.status, watermark: read.watermark, sourceRevision: read.sourceRevision },
      { status: "ready", watermark: 6, sourceRevision: 6 },
    );
    assert.deepEqual(read.catchUp, { maxItems: 2, reducedItems: 0, sqliteTransactions: 0 });
  });
});
// harness-contract: projection.lease-cas-rejection
test("lease CAS rejects stale renew/release, marks expiry orphaned, and permits takeover", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const fixture = lifecycleFixture();
    eventStore.append(taskBundle(fixture.events[0]!));
    projection.apply(fixture.events[0]!);
    const started = fixture.events[1]!;
    if (started.type !== "execution_started") throw new Error("fixture requires execution_started");

    const reserving = projection.reserveLease({ ...started.payload.lease, phase: "reserving" }, started.occurredAt);
    const active = projection.activateLease(reserving);
    assert.equal(active.phase, "held");
    assert.throws(
      () => projection.renewLease({ ...active, version: active.version - 1 }, "2026-08-11T02:00:00.000Z"),
      /stale/u,
    );
    const renewed = projection.renewLease(active, "2026-08-11T02:00:00.000Z");
    assert.equal(renewed.version, active.version + 1);
    assert.equal(projection.currentLease("task-1", "2026-08-11T02:00:00.000Z")?.phase, "orphaned");
    assert.throws(() => projection.releaseLease(active), /stale/u);

    const takeover = projection.reserveLease(
      {
        ...started.payload.lease,
        executionId: "execution-2",
        phase: "reserving",
        expiresAt: "2026-08-11T03:00:00.000Z",
        version: renewed.version + 1,
      },
      "2026-08-11T02:00:00.000Z",
    );
    assert.equal(takeover.executionId, "execution-2");
  });
});
test("renewed lease survives database rebuild", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const [created, started] = lifecycleFixture().events;
    if (created === undefined || started?.type !== "execution_started") throw new Error("fixture requires start event");
    eventStore.append(taskBundle(created));
    projection.apply(created);
    eventStore.append(taskBundle(started));
    projection.apply(started);
    const renewed = {
      schema: "task-event/v1",
      eventId: "event-renew",
      workspaceRevision: 3,
      opId: "op-renew",
      taskId: started.taskId,
      type: "lease_renewed",
      actor: started.actor,
      source: started.source,
      occurredAt: "2026-08-11T00:02:00.000Z",
      payload: {
        task: started.payload.task,
        execution: started.payload.execution,
        lease: {
          ...started.payload.lease,
          expiresAt: "2026-08-11T02:00:00.000Z",
          version: started.payload.lease.version + 1,
        },
        previousHolder: {
          taskId: started.taskId,
          executionId: started.payload.execution.executionId,
          actor: started.actor,
          source: started.source,
        },
        leaseExpiresAt: "2026-08-11T02:00:00.000Z",
        reason: "same_principal_reconnect",
      },
    } as unknown as TaskEventV1;
    eventStore.append(taskBundle(renewed));
    projection.apply(renewed);
    const beforeLease = projection.currentLease("task-1");
    const beforeIntervals = projection.readLeaseIntervals("task-1");

    projection.close();
    rmSync(projection.path, { force: true });
    const rebuilt = projection.rebuild();

    assert.equal(rebuilt.watermark, 3);
    assert.deepEqual(projection.currentLease("task-1"), beforeLease);
    assert.deepEqual(projection.readLeaseIntervals("task-1"), beforeIntervals);
  });
});
test("a lapsed reservation stops being a lease while a lapsed active lease stays orphaned", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const [created, started] = lifecycleFixture().events;
    if (created === undefined || started?.type !== "execution_started") throw new Error("fixture requires start event");
    eventStore.append(taskBundle(created));
    projection.apply(created);

    // A reservation whose execution was never published: the CAS row is the only trace it ever existed.
    projection.reserveLease(
      {
        ...started.payload.lease,
        executionId: "execution-unpublished",
        phase: "reserving",
        expiresAt: "2026-08-11T01:00:00.000Z",
        version: 0,
      },
      "2026-08-11T00:00:00.000Z",
    );
    // Still inside its TTL it must keep protecting the round against a concurrent claim.
    assert.equal(projection.currentLease("task-1", "2026-08-11T00:30:00.000Z")?.phase, "reserving");
    // Past its TTL it can never be published, so it is not a lease and must not wedge the task.
    assert.equal(projection.currentLease("task-1", "2026-08-11T02:00:00.000Z"), null);
    // The snapshot a daemon reads after the TTL lapsed is what task show and task release act on.
    assert.equal(
      makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T02:00:00.000Z" }).read("task-1").snapshot.lease,
      null,
    );

    // Contrast, holding every other input fixed and varying only the phase: a published lease that
    // lapsed is still a lease, because a real execution stands behind it and release must audit it.
    eventStore.append(taskBundle(started));
    projection.apply(started);
    assert.equal(projection.currentLease("task-1", "2026-08-11T02:00:00.000Z")?.phase, "orphaned");
    assert.equal(
      projection.currentLease("task-1", "2026-08-11T02:00:00.000Z")?.executionId,
      started.payload.execution.executionId,
    );
  });
});
function taskBundle(event: TaskEventV1): CanonicalWriteBundle {
  return { event, plan: taskLifecycleWritePlan(event), blobs: [] };
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Projection Test");
  git(rootDir, "config", "user.email", "projection-test@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
