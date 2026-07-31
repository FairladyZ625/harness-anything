// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import type {
  JournalRecordWitnessV1,
  WriteCoordinator,
  WriteOp
} from "@harness-anything/kernel";
import { makeDeferredAuthorityCoordinator } from "../../src/runtime/authority-write-coordinator.ts";

test("deferred authority flush publishes only records enqueued by that authority batch", () => {
  const witnesses: JournalRecordWitnessV1[] = [];
  let broadFlushes = 0;
  let exactFlushes = 0;
  const durable: WriteCoordinator = {
    enqueue: (op) => Effect.sync(() => {
      const journalWitness = {
        schema: "write-journal-record-witness/v1" as const,
        opId: op.opId,
        recordDigest: `digest:${op.opId}`
      };
      witnesses.push(journalWitness);
      return { opId: op.opId, entityId: op.entityId, accepted: true as const, journalWitness };
    }),
    flush: (reason) => Effect.sync(() => {
      broadFlushes += 1;
      return { reason, opCount: 2, committed: true };
    }),
    flushExactJournalRecords: (reason, selected) => Effect.sync(() => {
      exactFlushes += 1;
      assert.deepEqual(selected, witnesses);
      return { reason, opCount: selected.length, committed: true };
    }),
    recover: Effect.succeed({ replayedOps: 0 })
  };
  const deferred = makeDeferredAuthorityCoordinator({
    beginProjectionWrite: () => ({ settle: () => undefined }),
    makeDurableCoordinator: () => durable
  });

  Effect.runSync(deferred.enqueue(authorityWrite("op-current")));
  const report = Effect.runSync(deferred.flush("explicit"));

  assert.equal(report.opCount, 1);
  assert.equal(report.publicationMode, "exact-batch");
  assert.equal(exactFlushes, 1);
  assert.equal(broadFlushes, 0);
});

test("deferred authority flush fails closed when an accepted op has no exact journal witness", () => {
  let broadFlushes = 0;
  let exactFlushes = 0;
  const durable: WriteCoordinator = {
    enqueue: (op) => Effect.succeed({
      opId: op.opId,
      entityId: op.entityId,
      accepted: true as const
    }),
    flush: (reason) => Effect.sync(() => {
      broadFlushes += 1;
      return { reason, opCount: 1, committed: true };
    }),
    flushExactJournalRecords: (reason, selected) => Effect.sync(() => {
      exactFlushes += 1;
      return { reason, opCount: selected.length, committed: true };
    }),
    recover: Effect.succeed({ replayedOps: 0 })
  };
  const deferred = makeDeferredAuthorityCoordinator({
    beginProjectionWrite: () => ({ settle: () => undefined }),
    makeDurableCoordinator: () => durable
  });

  Effect.runSync(deferred.enqueue(authorityWrite("op-already-watermarked")));
  const result = Effect.runSync(Effect.either(deferred.flush("explicit")));

  assert.equal(result._tag, "Left");
  if (result._tag === "Left") {
    assert.equal(result.left._tag, "WriteRejected");
    assert.equal(
      result.left._tag === "WriteRejected" ? result.left.code : undefined,
      "authority_exact_journal_witness_required"
    );
  }
  assert.equal(exactFlushes, 0);
  assert.equal(broadFlushes, 0);
});

function authorityWrite(opId: string): WriteOp {
  return {
    opId,
    entityId: "task:task-current",
    kind: "doc_write",
    payload: { path: "progress.md", body: "current" }
  };
}
