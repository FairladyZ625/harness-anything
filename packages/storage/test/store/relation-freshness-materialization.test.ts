// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { RelationEventV1 } from "@harness-anything/kernel/internal/domain/relation-event.ts";
import type { TaskEventV1 } from "@harness-anything/kernel/internal/domain/task-lifecycle-event.ts";
import type { TaskV2 } from "@harness-anything/kernel/internal/domain/task.ts";
import type { EntityRelationRecord } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { refreshDirtyRelationFreshness } from "../../src/projection/relation-freshness-maintenance.ts";
import { withTempStore } from "./helpers.ts";
import { actor, projectionFixture, relation, taskCreated } from "./relation-graph-projection.fixtures.ts";

function created(revision: number, record: EntityRelationRecord): RelationEventV1 {
  const { strength: _strength, ...rest } = record;
  return {
    schema: "relation-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    relationId: record.relation_id,
    type: "relation_created",
    actor,
    source: "local",
    occurredAt: "2026-11-06T00:00:00.000Z",
    payload: { relation: { ...rest, targetObservedVersion: null } },
  } as RelationEventV1;
}

function transitioned(revision: number, task: TaskV2, status: TaskV2["status"]): TaskEventV1 {
  return {
    schema: "task-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    taskId: task.taskId,
    type: "task_transitioned",
    actor,
    source: "local",
    occurredAt: "2026-11-06T00:00:00.000Z",
    payload: {
      task: { ...task, status },
      mutation: { command: "transition", reason: "fixture advance", fields: ["status"] },
      documentClaims: [],
    },
  } as TaskEventV1;
}

test("relation freshness is stored at the write cut and recomputed only for the changed endpoint's relations", () => {
  withTempStore((rootDir) => {
    const fixture = projectionFixture(rootDir),
      apply = (event: TaskEventV1 | RelationEventV1) => {
        fixture.appendEvent(event);
        fixture.projection.apply(event);
      },
      hotTargeted = (["relates", "blocks", "implements", "supports"] as const).map((type) =>
        relation({ source: "task/task_source", target: "task/task_hot", type }),
      ),
      hotPresence = relation({ source: "task/task_source", target: "task/task_hot", type: "depends-on" }),
      cold = (["relates", "blocks"] as const).map((type) =>
        relation({ source: "task/task_source", target: "task/task_cold", type }),
      ),
      // A legal sibling id sharing the cold task's prefix is a different endpoint.
      sibling = (["relates", "blocks", "implements"] as const).map((type) =>
        relation({ source: "task/task_source", target: "task/task_cold-backup", type }),
      );
    apply(taskCreated(1, "task_source"));
    const hot = taskCreated(2, "task_hot");
    apply(hot);
    apply(taskCreated(3, "task_cold"));
    apply(taskCreated(4, "task_cold-backup"));
    let revision = 4;
    for (const record of [...hotTargeted, hotPresence, ...cold, ...sibling]) apply(created(++revision, record));
    const freshnessOf = () =>
      new Map(fixture.projection.readRelationQuery({}).rows.map((row) => [row.relationId, row.freshness]));
    assert.deepEqual(new Set(freshnessOf().values()), new Set(["current"]));

    // The hot target advances: target-anchored edges go suspect, the presence-anchored
    // depends-on stays current, and edges of the untouched cold target keep their value.
    apply(transitioned(revision + 1, hot.payload.task, "active"));
    const after = freshnessOf();
    for (const record of hotTargeted) assert.equal(after.get(record.relation_id), "suspect");
    assert.equal(after.get(hotPresence.relation_id), "current");
    for (const record of cold) assert.equal(after.get(record.relation_id), "current");

    // The freshness filter is a stored-column predicate and pages over exactly the suspect set.
    const suspectIds = hotTargeted.map(({ relation_id }) => relation_id).sort(),
      first = fixture.projection.readRelationQuery({ freshness: "suspect", limit: 3 });
    assert.deepEqual(
      first.rows.map((row) => row.relationId),
      suspectIds.slice(0, 3),
    );
    const second = fixture.projection.readRelationQuery({
      freshness: "suspect",
      limit: 3,
      cursor: first.page!.nextCursor!,
    });
    assert.deepEqual(
      second.rows.map((row) => row.relationId),
      suspectIds.slice(3),
    );
    assert.equal(second.page!.nextCursor, null);
    const path = fixture.projection.path;
    fixture.projection.close();

    // Recompute locates relations through the endpoint indexes: a change to the cold target
    // revisits its two edges, nothing anchored on the hot target, and none of the edges of the
    // `task/task_cold-backup` sibling that shares its prefix.
    const db = new DatabaseSync(path);
    try {
      assert.equal(refreshDirtyRelationFreshness(db), 0);
      db.prepare("UPDATE task_snapshot SET workspace_revision = workspace_revision + 100 WHERE task_id = ?").run(
        "task_cold",
      );
      assert.equal(refreshDirtyRelationFreshness(db), cold.length);
      const stored = new Map(
        (
          db.prepare("SELECT relation_id, freshness FROM relation_edge").all() as {
            relation_id: string;
            freshness: string;
          }[]
        ).map((row) => [row.relation_id, row.freshness]),
      );
      for (const record of cold) assert.equal(stored.get(record.relation_id), "suspect");
      assert.equal(stored.get(hotPresence.relation_id), "current");
      // A non-version column change does not mark the endpoint.
      db.prepare("UPDATE task_snapshot SET updated_at = updated_at WHERE task_id = ?").run("task_hot");
      assert.equal(refreshDirtyRelationFreshness(db), 0);
    } finally {
      db.close();
    }
  });
});

test("a restarted writer settles freshness a previous build left missing or behind before serving reads", () => {
  withTempStore((rootDir) => {
    const fixture = projectionFixture(rootDir),
      apply = (event: TaskEventV1 | RelationEventV1) => {
        fixture.appendEvent(event);
        fixture.projection.apply(event);
      },
      // More edges than one settle page, so the backlog drains across several committed pages.
      bulk = Array.from({ length: 600 }, (_, index) =>
        relation({ source: `task/task_bulk_${index}`, target: "task/task_hot", type: "relates" }),
      ),
      cold = relation({ source: "task/task_source", target: "task/task_cold", type: "relates" });
    apply(taskCreated(1, "task_hot"));
    apply(taskCreated(2, "task_cold"));
    let revision = 2;
    for (const record of [...bulk, cold]) apply(created(++revision, record));
    const path = fixture.projection.path;
    fixture.projection.close();

    // A previous build writes without maintaining the column: rows it rewrites lose their stored
    // value, and its endpoint writes still fire the persisted triggers into the dirty table.
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE relation_edge SET freshness = NULL, current_target_version = NULL WHERE target_ref = ?").run(
        "task/task_hot",
      );
      db.prepare("UPDATE task_snapshot SET workspace_revision = workspace_revision + 1000 WHERE task_id = ?").run(
        "task_cold",
      );
      for (let index = 0; index < 600; index += 1)
        db.prepare("INSERT OR IGNORE INTO relation_freshness_dirty(ref) VALUES (?)").run(`task/task_gone_${index}`);
      assert.equal(
        Number((db.prepare("SELECT count(*) AS n FROM relation_freshness_dirty").get() as { n: number }).n),
        601,
      );
    } finally {
      db.close();
    }

    const reopened = fixture.reopen();
    try {
      const rows = new Map(reopened.readRelationQuery({}).rows.map((row) => [row.relationId, row.freshness]));
      for (const record of bulk) assert.equal(rows.get(record.relation_id), "current");
      assert.equal(rows.get(cold.relation_id), "suspect", "the previous build's endpoint change is applied");
      assert.equal(reopened.readRelationQuery({ freshness: "suspect" }).rows.length, 1);
    } finally {
      reopened.close();
    }
    const settled = new DatabaseSync(path);
    try {
      assert.deepEqual(
        {
          ...settled
            .prepare(
              "SELECT (SELECT count(*) FROM relation_freshness_dirty) AS dirty, " +
                "(SELECT count(*) FROM relation_edge WHERE freshness IS NULL) AS missing",
            )
            .get(),
        },
        { dirty: 0, missing: 0 },
      );
    } finally {
      settled.close();
    }
  });
});
