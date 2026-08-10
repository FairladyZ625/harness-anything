// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { taskEntityId } from "../../src/domain/index.ts";
import type { IndeterminateFlushReport, WriteCoordinator, WriteOp } from "../../src/ports/index.ts";
import { isIndeterminateFlushControlOutcome, stablePayloadHash, writeCoordinatedPayload } from "../../src/index.ts";

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

test("coordinated payload stops later steps with the original indeterminate report", () => {
  const report = {
    status: "indeterminate",
    reason: "explicit",
    opCount: 1,
    operationIds: ["op-indeterminate"],
    cause: {
      kind: "foreign-committer",
      detail: "global lock remained foreign through the visible retry budget",
      lockHolder: {
        lockPath: "/repo/.harness/locks/global.lock",
        status: "missing",
        detail: "lock disappeared after budget exhaustion"
      }
    }
  } satisfies IndeterminateFlushReport;
  const coordinator: WriteCoordinator = {
    enqueue: (op) => Effect.succeed({ opId: op.opId, entityId: op.entityId, accepted: true }),
    flush: () => Effect.succeed(report),
    recover: Effect.succeed({ replayedOps: 0 })
  };
  let laterStepRan = false;

  const result = Effect.runSync(Effect.either(writeCoordinatedPayload(coordinator, stablePayloadHash, {
    opIdPrefix: "fixed",
    entityId: taskEntityId("task-indeterminate"),
    kind: "doc_write",
    payload: { path: "task_plan.md", body: "pending\n" }
  }).pipe(Effect.tap(() => Effect.sync(() => { laterStepRan = true; })))));

  assert.equal(result._tag, "Left");
  if (result._tag !== "Left") assert.fail("expected the indeterminate control outcome");
  assert.equal(isIndeterminateFlushControlOutcome(result.left), true);
  if (!isIndeterminateFlushControlOutcome(result.left)) assert.fail("expected a typed indeterminate control outcome");
  assert.equal(result.left.report, report);
  assert.doesNotMatch(JSON.stringify(result.left), /WriteRejected|JournalUnavailable/u);
  assert.equal(laterStepRan, false);
});
