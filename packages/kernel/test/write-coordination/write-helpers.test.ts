import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { taskEntityId } from "../../src/domain/index.ts";
import type { WriteCoordinator, WriteOp } from "../../src/ports/index.ts";
import { stablePayloadHash, writeCoordinatedPayload } from "../../src/write-coordination/write-helpers.ts";

test("coordinated payload op ids include entity and kind identity", () => {
  const enqueued: WriteOp[] = [];
  const coordinator: WriteCoordinator = {
    enqueue: (op) => Effect.sync(() => {
      enqueued.push(op);
      return { opId: op.opId, entityId: op.entityId, accepted: true };
    }),
    flush: () => Effect.succeed({ reason: "explicit", opCount: enqueued.length, committed: true }),
    recover: Effect.succeed({ replayedOps: 0 })
  };
  const payload = { path: "progress.md", body: "same payload" };

  Effect.runSync(writeCoordinatedPayload(coordinator, stablePayloadHash, {
    opIdPrefix: "fixed",
    entityId: taskEntityId("task-a"),
    kind: "progress_append",
    payload
  }, { flush: false }));
  Effect.runSync(writeCoordinatedPayload(coordinator, stablePayloadHash, {
    opIdPrefix: "fixed",
    entityId: taskEntityId("task-b"),
    kind: "progress_append",
    payload
  }, { flush: false }));
  Effect.runSync(writeCoordinatedPayload(coordinator, stablePayloadHash, {
    opIdPrefix: "fixed",
    entityId: taskEntityId("task-a"),
    kind: "doc_write",
    payload
  }, { flush: false }));

  assert.equal(new Set(enqueued.map((op) => op.opId)).size, 3);
});
