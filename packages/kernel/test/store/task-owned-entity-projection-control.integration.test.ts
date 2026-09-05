// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { memoryEventStore, reviewEvents } from "./task-owned-entity-projection.fixtures.ts";

test("reviews with distinct ids retain the existing projection behavior", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const events = reviewEvents("review-second"),
      projection = makeTaskProjection({ rootDir, eventStore: memoryEventStore(events) });
    projection.catchUp();

    assert.deepEqual(
      projection.read("task-first").snapshot.reviews.map(({ reviewId }) => reviewId),
      ["review-shared"],
    );
    assert.deepEqual(
      projection.read("task-second").snapshot.reviews.map(({ reviewId }) => reviewId),
      ["review-second"],
    );
    projection.close();
  });
});
