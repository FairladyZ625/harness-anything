// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readRelationCycleWitnessAtCut } from "../src/entity-action-relation.ts";

test("relation cycle admission fails closed when its canonical projection cut is pending", () => {
  const projection = {
    readRelationQuery: () => ({ status: "pending", rows: [], watermark: 4, sourceRevision: 5 }),
  } as never;
  assert.throws(
    () =>
      readRelationCycleWitnessAtCut({
        projection,
        headRevision: 5,
        candidate: {
          relationId: "candidate",
          sourceRef: "task/a",
          targetRef: "task/b",
          relationType: "depends-on",
          direction: "directed",
          state: "active",
        },
      }),
    (error: unknown) => {
      const failure = error as { readonly code?: string; readonly message?: string };
      assert.equal(failure.code, "content_not_ready");
      assert.match(failure.message ?? "", /status pending, watermark 4, source revision 5, write head 5/u);
      return true;
    },
  );
});

test("relation cycle admission rejects a projection source revision ahead of the write head", () => {
  const projection = {
    readRelationQuery: () => ({ status: "ready", rows: [], watermark: 5, sourceRevision: 6 }),
  } as never;
  assert.throws(
    () =>
      readRelationCycleWitnessAtCut({
        projection,
        headRevision: 5,
        candidate: {
          relationId: "candidate",
          sourceRef: "task/a",
          targetRef: "task/b",
          relationType: "depends-on",
          direction: "directed",
          state: "active",
        },
      }),
    (error: unknown) => (error as { readonly code?: string }).code === "content_not_ready",
  );
});
