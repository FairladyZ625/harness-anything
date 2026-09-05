// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { taskProjectionSchemaVersion } from "../../src/projection/projection-schema.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { memoryEventStore, reviewEvents } from "./task-owned-entity-projection.fixtures.ts";

test("task-owned reviews with the same local id remain visible in both task snapshots", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const events = reviewEvents("review-shared", "execution-shared"),
      projection = makeTaskProjection({ rootDir, eventStore: memoryEventStore(events) });
    projection.catchUp();

    assert.equal(projection.readTaskOperation(events[3]!.opId)?.event.type, "review_recorded");
    assert.equal(projection.readTaskOperation(events[7]!.opId)?.event.type, "review_recorded");
    assert.deepEqual(
      projection.read("task-first").snapshot.reviews.map(({ reviewId }) => reviewId),
      ["review-shared"],
    );
    assert.deepEqual(
      projection.read("task-second").snapshot.reviews.map(({ reviewId }) => reviewId),
      ["review-shared"],
    );
    assert.deepEqual(
      projection
        .listEntities("review")
        .filter(({ id }) => id === "review-shared")
        .map(({ ownerId }) => ownerId)
        .sort(),
      ["task-first", "task-second"],
    );
    assert.deepEqual(
      projection
        .listEntities("execution")
        .filter(({ id }) => id === "execution-shared")
        .map(({ ownerId }) => ownerId)
        .sort(),
      ["task-first", "task-second"],
    );
    projection.close();

    const stale = new DatabaseSync(projection.path);
    stale.prepare("DELETE FROM entity_projection WHERE entity_kind = 'review' AND task_id = ?").run("task-first");
    stale
      .prepare("UPDATE projection_meta SET schema_version = ? WHERE singleton = 1")
      .run(taskProjectionSchemaVersion - 1);
    stale.close();

    const rebuilt = makeTaskProjection({ rootDir, eventStore: memoryEventStore(events) });
    rebuilt.catchUp();
    assert.deepEqual(
      rebuilt.read("task-first").snapshot.reviews.map(({ reviewId }) => reviewId),
      ["review-shared"],
    );
    assert.deepEqual(
      rebuilt.read("task-second").snapshot.reviews.map(({ reviewId }) => reviewId),
      ["review-shared"],
    );
    rebuilt.close();
  });
});
