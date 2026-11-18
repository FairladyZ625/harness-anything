// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runtimeEventContentClaims } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import {
  history,
  snapshot,
  requested,
  started,
  outcome,
  runtimeEvent,
  appendTaskTerminalLifecycleHistory,
} from "./dispatch-lifecycle.fixtures.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { readDispatchLifecycleRows } from "../../src/projection/dispatch-lifecycle-projection.ts";
import { canonicalEventWritePlan, makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

function initRepo(rootDir: string): void {
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Lifecycle Test"],
    ["config", "user.email", "lifecycle@example.invalid"],
    ["commit", "--allow-empty", "-qm", "base"],
  ])
    execFileSync("git", ["-C", rootDir, ...args]);
}

test("the lifecycle read model folds accepted runtime events and equals every rebuild path", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "dispatch-lifecycle", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    for (const event of history()) {
      store.append({
        event,
        plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
        blobs: runtimeEventContentClaims(event).map((claim) => ({ ...claim, body: "" })),
      });
      projection.apply(event);
    }
    const online = snapshot(projection),
      onlineDigest = projection.readStateDigest();
    assert.equal(online.active.status, "ready");
    assert.ok(online.active.status === "ready");
    const agy = online.active.rows.find(({ attempt }) => attempt.dispatchId === "dispatch-a2")!;
    assert.equal(agy.attempt.kindId, "agy");
    assert.equal(agy.policy.processAlive, true);
    assert.equal(agy.policy.canSteer, false);
    assert.deepEqual(
      online.active.rows.map((row) => [
        row.attemptGroupId,
        row.groupPhase,
        row.attempt.dispatchId,
        row.policy.capacityDisposition,
      ]),
      [
        ["dispatch-a", "running", "dispatch-a2", "busy"],
        ["dispatch-b", "running", "dispatch-b", "recovering"],
      ],
    );
    assert.ok(online.points.status === "ready");
    assert.deepEqual(
      online.points.rows.map((row) => [row.attempt.dispatchId, row.attempt.phase, row.groupPhase]).sort(),
      [
        ["dispatch-a", "closed", "running"],
        ["dispatch-c", "closed", "closed"],
      ],
    );
    assert.ok(online.session.status === "ready");
    assert.equal(online.session.rows[0]?.attempt.process, "unknown");
    const projectionPath = projection.path;
    projection.close();

    // A cache written before the lifecycle tables existed, or advanced by an older binary.
    const db = new DatabaseSync(projectionPath);
    db.exec(
      "DROP TABLE dispatch_lifecycle_group; DROP TABLE dispatch_lifecycle_attempt; DROP TABLE dispatch_lifecycle_task_lease; DROP TABLE dispatch_lifecycle_cursor;",
    );
    db.close();
    const reopened = makeTaskProjection({ rootDir, eventStore: store, projectionPath });
    assert.deepEqual(snapshot(reopened), online);
    assert.equal(reopened.readStateDigest(), onlineDigest);

    // A cache folded by the previous lifecycle model (no execution column, no model version): a
    // reader sees it pending, never an empty ready page, and reopening refolds it.
    reopened.close();
    const previousModel = new DatabaseSync(projectionPath);
    previousModel.exec(`
      DROP TABLE dispatch_lifecycle_group; DROP TABLE dispatch_lifecycle_attempt;
      DROP TABLE dispatch_lifecycle_task_lease; DROP TABLE dispatch_lifecycle_cursor;
      CREATE TABLE dispatch_lifecycle_group (attempt_group_id TEXT PRIMARY KEY, phase TEXT NOT NULL,
        current_instance_id TEXT NOT NULL, revision INTEGER NOT NULL, group_json TEXT NOT NULL);
      CREATE TABLE dispatch_lifecycle_attempt (runtime_session_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL,
        attempt_group_id TEXT NOT NULL);
      CREATE TABLE dispatch_lifecycle_cursor (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL);
      INSERT INTO dispatch_lifecycle_cursor VALUES (1, 999);`);
    assert.equal(
      readDispatchLifecycleRows(previousModel, { by: "active", limit: 10 }, { watermark: 13, sourceRevision: 13 })
        .status,
      "pending",
    );
    previousModel.close();
    const refolded = makeTaskProjection({ rootDir, eventStore: store, projectionPath });
    assert.deepEqual(snapshot(refolded), online);
    assert.equal(refolded.readStateDigest(), onlineDigest);
    refolded.close();

    // Rewinding the fold cursor replays already folded events: the reducer accepts each once.
    const rewound = new DatabaseSync(projectionPath);
    rewound.exec("UPDATE dispatch_lifecycle_cursor SET revision = 0");
    rewound.close();
    const replayed = makeTaskProjection({ rootDir, eventStore: store, projectionPath });
    assert.deepEqual(snapshot(replayed), online);
    assert.equal(replayed.readStateDigest(), onlineDigest);

    // A cold rebuild from the event store reaches the same rows.
    replayed.rebuild();
    assert.deepEqual(snapshot(replayed), online);
    assert.equal(replayed.readStateDigest(), onlineDigest);
    replayed.close();
    await store.drain();
  });
});

test("a v7 lifecycle cache refolds owner abandonment without claiming a physical stop", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "dispatch-owner-abandonment", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store }),
      admitted = requested("abandoned-dispatch", "abandoned-session"),
      running = started("abandoned-session"),
      terminal = outcome("abandoned-session", "unknown");
    assert.ok(terminal.type === "runtime_session_outcome_observed");
    const events = [
      admitted,
      running,
      { ...terminal, payload: { ...terminal.payload, reasonCode: "ruling_resolved" } },
    ];
    for (const [index, input] of events.entries()) {
      const revision = index + 1;
      const event = {
        ...input,
        eventId: `event-lifecycle-${revision}`,
        opId: `op-lifecycle-${revision}`,
        workspaceRevision: revision,
      };
      store.append({
        event,
        plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
        blobs: runtimeEventContentClaims(event).map((claim) => ({ ...claim, body: "" })),
      });
      projection.apply(event);
    }
    const query = { by: "session" as const, runtimeSessionId: "abandoned-session" },
      online = projection.readDispatchLifecycle(query),
      projectionPath = projection.path;
    assert.ok(online.status === "ready");
    assert.equal(online.rows[0]?.groupPhase, "closed");
    assert.equal(online.rows[0]?.attempt.stopProof, "unproven");
    projection.close();
    // Cache rows captured by folding these events with origin/main bc4c1891fe (model v7).
    const db = new DatabaseSync(projectionPath);
    db.exec(`
      DELETE FROM dispatch_lifecycle_cursor;
      INSERT INTO dispatch_lifecycle_cursor VALUES (1, 3, 7);
      DELETE FROM dispatch_lifecycle_attempt;
      INSERT INTO dispatch_lifecycle_attempt VALUES ('abandoned-session', 'abandoned-dispatch', 'abandoned-dispatch');
      DELETE FROM dispatch_lifecycle_group;
    `);
    db.prepare(
      `
      INSERT INTO dispatch_lifecycle_group
        (attempt_group_id, phase, current_instance_id, current_execution_id, current_task_id, revision, group_json)
      VALUES ('abandoned-dispatch', 'closed', 'codex-fixture', NULL, NULL, 3, ?)
    `,
    ).run(
      JSON.stringify({
        attemptGroupId: "abandoned-dispatch",
        phase: "closed",
        currentDispatchId: "abandoned-dispatch",
        attempts: [
          {
            dispatchId: "abandoned-dispatch",
            runtimeSessionId: "abandoned-session",
            instanceId: "codex-fixture",
            kindId: "codex",
            fence: { owner: "node:node-a", verified: true, token: 1, epoch: 1 },
            reservation: {
              reservationId: "codex-fixture/abandoned-dispatch",
              instanceId: "codex-fixture",
              owner: "node:node-a",
            },
            task: null,
            workspaceRef: null,
            phase: "closed",
            process: "alive",
            stopProof: "proven_stopped",
            outcome: "unknown",
            admittedRevision: 1,
            eventIds: ["event-lifecycle-1", "event-lifecycle-2", "event-lifecycle-3"],
          },
        ],
        successor: { admissible: true, dueAt: null },
        ruling: null,
        delivery: { status: "unregistered", targetRef: null, targetDigest: null, registeredRevision: null },
        revision: 3,
      }),
    );
    db.close();
    const reopened = makeTaskProjection({ rootDir, eventStore: store, projectionPath });
    assert.deepEqual(reopened.readDispatchLifecycle(query), online);
    reopened.close();
    await store.drain();
  });
});

test("active pages are bounded and point reads cap their key count", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "dispatch-lifecycle-page", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    for (const event of history()) {
      store.append({
        event,
        plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
        blobs: runtimeEventContentClaims(event).map((claim) => ({ ...claim, body: "" })),
      });
      projection.apply(event);
    }
    const first = projection.readDispatchLifecycle({ by: "active", limit: 1 });
    assert.ok(first.status === "ready");
    assert.deepEqual(
      first.rows.map((row) => row.attemptGroupId),
      ["dispatch-a"],
    );
    assert.equal(first.nextCursor, "dispatch-a");
    const second = projection.readDispatchLifecycle({ by: "active", limit: 1, cursor: first.nextCursor! });
    assert.ok(second.status === "ready");
    assert.deepEqual([second.rows.map((row) => row.attemptGroupId), second.nextCursor], [["dispatch-b"], null]);
    const dispatchIds = Array.from({ length: 101 }, (_, index) => `dispatch-${index}`);
    dispatchIds.push("dispatch-a", "dispatch-c");
    assert.throws(
      () =>
        projection.readDispatchLifecycle({
          by: "dispatch",
          dispatchIds,
        }),
      /at most 100 ids/u,
    );
    assert.deepEqual(
      projection.readDispatchLifecycle({ by: "dispatch-batch", dispatchIds }),
      projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: ["dispatch-a", "dispatch-c"] }),
    );
    projection.close();
    await store.drain();
  });
});

test("accepted fallback schedule and exhaustion survive reopen and cold rebuild without a spool", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "fallback-lifecycle", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore: store });
    const append = (event: ReturnType<typeof requested>) => {
      const accepted = { ...event, workspaceRevision: (store.readHead()?.revision ?? 0) + 1 };
      store.append({
        event: accepted,
        plan: canonicalEventWritePlan(accepted, "agent-runtime/v1", accepted.opId),
        blobs: runtimeEventContentClaims(accepted).map((claim) => ({ ...claim, body: "" })),
      });
      projection.apply(accepted);
    };
    const plan = { notBeforeAt: "2099-01-01T00:00:00.000Z", nextProvider: { instance: "codex-fixture" } };
    append(requested("d-fallback", "s-fallback"));
    append(started("s-fallback"));
    append(runtimeEvent("runtime_session_exited", { runtimeSessionId: "s-fallback" }));
    append(
      outcome("s-fallback", "failed", {
        classification: "provider_fault",
        reason: "fault",
        fallbackState: "scheduled",
        fallbackSchedule: plan,
      }),
    );
    const query = { by: "group", attemptGroupId: "d-fallback" } as const;
    const scheduled = projection.readDispatchLifecycle(query);
    assert.ok(scheduled.status === "ready");
    assert.equal(scheduled.rows[0]?.policy.groupSettled, false);
    assert.deepEqual(scheduled.rows[0]?.successor.schedule, plan);
    projection.rebuild();
    assert.deepEqual(projection.readDispatchLifecycle(query), scheduled);
    append(
      outcome("s-fallback", "failed", {
        classification: "provider_fault",
        reason: "fault",
        fallbackState: "exhausted",
      }),
    );
    const exhausted = projection.readDispatchLifecycle(query);
    assert.ok(exhausted.status === "ready");
    assert.equal(exhausted.rows[0]?.policy.groupSettled, true);
    assert.equal(exhausted.rows[0]?.policy.fallbackPending, false);
    projection.rebuild();
    assert.deepEqual(projection.readDispatchLifecycle(query), exhausted);
    projection.close();
    const reopened = makeTaskProjection({ rootDir, eventStore: store });
    assert.deepEqual(reopened.readDispatchLifecycle(query), exhausted);
    reopened.close();
    await store.drain();
  });
});

test("terminal task events and execution retirements close historical groups via bounded task index and v5 upgrade refold", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "dispatch-lifecycle-terminal", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    appendTaskTerminalLifecycleHistory(store, (event) => projection.apply(event));

    const active = projection.readDispatchLifecycle({ by: "active", limit: 20 });
    assert.ok(active.status === "ready");
    assert.deepEqual(
      active.rows.map((row) => [row.attemptGroupId, row.groupPhase, row.attempt.phase, row.attempt.stopProof]),
      [
        ["d-live", "running", "running", "unproven"],
        ["d-nonterm", "waiting_backoff", "closed", "proven_stopped"],
      ],
    );

    const closed = projection.readDispatchLifecycle({
      by: "dispatch",
      dispatchIds: ["d-done", "d-cancel", "d-supersede", "d-retire", "d-replace"],
    });
    assert.ok(closed.status === "ready");
    assert.deepEqual(
      closed.rows.map((row) => [row.attemptGroupId, row.groupPhase, row.ruling, row.successor.admissible]),
      [
        ["d-cancel", "closed", null, false],
        ["d-done", "closed", null, false],
        ["d-replace", "closed", null, false],
        ["d-retire", "closed", null, false],
        ["d-supersede", "closed", null, false],
      ],
    );

    const projectionPath = projection.path;
    projection.close();

    // Verify bounded partial task index and v5 (pre-current_task_id, version=5) upgrade refold.
    const inspectDb = new DatabaseSync(projectionPath);
    const plan = inspectDb
      .prepare(
        "EXPLAIN QUERY PLAN SELECT attempt_group_id FROM dispatch_lifecycle_group WHERE phase <> 'closed' AND current_task_id = ? ORDER BY attempt_group_id",
      )
      .all("task-nonterm") as Array<{ detail: string }>;
    assert.ok(
      plan.some((row) => row.detail.includes("dispatch_lifecycle_active_task")),
      `expected dispatch_lifecycle_active_task index usage, got ${JSON.stringify(plan)}`,
    );
    const indexedTasks = (
      inspectDb
        .prepare(
          "SELECT attempt_group_id, current_task_id FROM dispatch_lifecycle_group WHERE phase <> 'closed' ORDER BY attempt_group_id",
        )
        .all() as Array<{ attempt_group_id: string; current_task_id: string | null }>
    ).map((row) => ({ ...row }));
    assert.deepEqual(indexedTasks, [
      { attempt_group_id: "d-live", current_task_id: "task-live" },
      { attempt_group_id: "d-nonterm", current_task_id: "task-nonterm" },
    ]);

    inspectDb.exec(`
      DROP TABLE dispatch_lifecycle_group; DROP TABLE dispatch_lifecycle_attempt;
      DROP TABLE dispatch_lifecycle_task_lease; DROP TABLE dispatch_lifecycle_cursor;
      CREATE TABLE dispatch_lifecycle_group (attempt_group_id TEXT PRIMARY KEY, phase TEXT NOT NULL,
        current_instance_id TEXT NOT NULL, current_execution_id TEXT, revision INTEGER NOT NULL, group_json TEXT NOT NULL);
      CREATE TABLE dispatch_lifecycle_attempt (runtime_session_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL,
        attempt_group_id TEXT NOT NULL);
      CREATE TABLE dispatch_lifecycle_task_lease (task_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE dispatch_lifecycle_cursor (singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        revision INTEGER NOT NULL, model_version INTEGER NOT NULL);
      INSERT INTO dispatch_lifecycle_group VALUES ('d-cancel', 'awaiting_ruling', 'codex-fixture', 'exec-cancel', 999, '{}');
      INSERT INTO dispatch_lifecycle_cursor VALUES (1, 999, 5);`);
    assert.equal(
      readDispatchLifecycleRows(inspectDb, { by: "active", limit: 10 }, { watermark: 999, sourceRevision: 999 }).status,
      "pending",
    );
    inspectDb.close();

    const upgraded = makeTaskProjection({ rootDir, eventStore: store, projectionPath });
    assert.deepEqual(upgraded.readDispatchLifecycle({ by: "active", limit: 20 }), active);
    assert.deepEqual(
      upgraded.readDispatchLifecycle({
        by: "dispatch",
        dispatchIds: ["d-done", "d-cancel", "d-supersede", "d-retire", "d-replace"],
      }),
      closed,
    );
    upgraded.close();
    await store.drain();
  });
});
