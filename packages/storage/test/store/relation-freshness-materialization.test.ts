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
      );
    apply(taskCreated(1, "task_source"));
    const hot = taskCreated(2, "task_hot");
    apply(hot);
    apply(taskCreated(3, "task_cold"));
    let revision = 3;
    for (const record of [...hotTargeted, hotPresence, ...cold]) apply(created(++revision, record));
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
    // revisits its two edges and nothing anchored on the hot target.
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
