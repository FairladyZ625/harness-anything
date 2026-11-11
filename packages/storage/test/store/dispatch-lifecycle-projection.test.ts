// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runtimeEventContentClaims } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { history, snapshot, requested, started, outcome, runtimeEvent } from "./dispatch-lifecycle.fixtures.ts";
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
    assert.throws(
      () =>
        projection.readDispatchLifecycle({
          by: "dispatch",
          dispatchIds: Array.from({ length: 101 }, (_, index) => `dispatch-${index}`),
        }),
      /at most 100 ids/u,
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
