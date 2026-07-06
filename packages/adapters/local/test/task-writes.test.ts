import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { taskEntityId } from "../../../kernel/src/index.ts";
import type { WriteCoordinator, WriteOp } from "../../../kernel/src/index.ts";
import { writeSupersedeTaskDocuments } from "../src/task-writes.ts";

test("supersede document writes use the explicit operation task id", () => {
  const enqueued: WriteOp[] = [];
  const coordinator: WriteCoordinator = {
    enqueue: (op) => Effect.sync(() => {
      enqueued.push(op);
      return { opId: op.opId, entityId: op.entityId, accepted: true };
    }),
    flush: () => Effect.succeed({ reason: "explicit", opCount: enqueued.length, committed: true }),
    recover: Effect.succeed({ replayedOps: 0 })
  };

  Effect.runSync(writeSupersedeTaskDocuments(coordinator, stableHash, "task-old", [
    { taskId: "task-new", path: "INDEX.md", body: "replacement" }
  ]));

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.entityId, taskEntityId("task-old"));
  assert.equal(enqueued[0]?.kind, "package_supersede");
});

function stableHash(value: unknown): string {
  return JSON.stringify(value);
}
