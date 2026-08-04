// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  createExactWriteScope,
  createJournaledBatch,
  type JournalRecordWitnessV1,
  type WriteCoordinator,
  type WriteOp
} from "@harness-anything/kernel";
import { makeDeferredAuthorityCoordinator } from "../../src/runtime/authority-write-coordinator.ts";

test("deferred authority commitExact publishes only records in its opaque batch", () => {
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
    makeDurableCoordinator: () => durable,
    exactWriteScope: createExactWriteScope()
  });

  const entry = Effect.runSync(deferred.enqueue(authorityWrite("op-current")));
  const report = Effect.runSync(deferred.commitExact("explicit", createJournaledBatch([entry])));

  assert.equal(report.opCount, 1);
  assert.equal(report.publicationMode, "exact-batch");
  assert.equal(exactFlushes, 1);
  assert.equal(broadFlushes, 0);
});

test("deferred authority commitExact fails closed when an accepted op has no exact journal witness", () => {
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
    makeDurableCoordinator: () => durable,
    exactWriteScope: createExactWriteScope()
  });

  const entry = Effect.runSync(deferred.enqueue(authorityWrite("op-already-watermarked")));
  const result = Effect.runSync(Effect.either(
    deferred.commitExact("explicit", createJournaledBatch([entry]))
  ));

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

test("one exact scope commits entries from distinct attributed coordinators as one batch", () => {
  const scope = createExactWriteScope();
  const durableAcknowledgements: JournalRecordWitnessV1[] = [];
  let exactFlushes = 0;
  let settled = 0;
  const durable: WriteCoordinator = {
    enqueue: (op) => Effect.sync(() => {
      const journalWitness = {
        schema: "write-journal-record-witness/v1" as const,
        opId: op.opId,
        recordDigest: `digest:${op.opId}`
      };
      durableAcknowledgements.push(journalWitness);
      return { opId: op.opId, entityId: op.entityId, accepted: true as const, journalWitness };
    }),
    flush: () => Effect.die("broad flush must remain unreachable"),
    flushExactJournalRecords: (reason, witnesses) => Effect.sync(() => {
      exactFlushes += 1;
      assert.deepEqual(witnesses, durableAcknowledgements);
      return { reason, opCount: witnesses.length, committed: true };
    }),
    recover: Effect.succeed({ replayedOps: 0 })
  };
  const makeDeferred = () => makeDeferredAuthorityCoordinator({
    beginProjectionWrite: () => ({ settle: () => { settled += 1; } }),
    makeDurableCoordinator: () => durable,
    exactWriteScope: scope
  });
  const first = makeDeferred();
  const second = makeDeferred();
  const firstEntry = Effect.runSync(first.enqueue(authorityWrite("op-first")));
  const secondEntry = Effect.runSync(second.enqueue(authorityWrite("op-second")));

  const report = Effect.runSync(first.commitExact(
    "explicit",
    createJournaledBatch([firstEntry, secondEntry])
  ));

  assert.equal(report.opCount, 2);
  assert.equal(exactFlushes, 1);
  assert.equal(settled, 2);
});

test("an exact batch cannot cross authority scope ownership", () => {
  let durableCoordinatorRequests = 0;
  const makeDeferred = () => makeDeferredAuthorityCoordinator({
    beginProjectionWrite: () => ({ settle: () => undefined }),
    makeDurableCoordinator: () => {
      durableCoordinatorRequests += 1;
      throw new Error("foreign batch must fail before durable publication");
    },
    exactWriteScope: createExactWriteScope()
  });
  const first = makeDeferred();
  const second = makeDeferred();
  const firstEntry = Effect.runSync(first.enqueue(authorityWrite("op-first")));
  const secondEntry = Effect.runSync(second.enqueue(authorityWrite("op-second")));

  const result = Effect.runSync(Effect.either(first.commitExact(
    "explicit",
    createJournaledBatch([firstEntry, secondEntry])
  )));

  assert.equal(result._tag, "Left");
  if (result._tag === "Left") {
    assert.equal(result.left._tag, "WriteRejected");
    assert.equal(
      result.left._tag === "WriteRejected" ? result.left.code : undefined,
      "authority_exact_batch_owner_mismatch"
    );
  }
  assert.equal(durableCoordinatorRequests, 0);
});

function authorityWrite(opId: string): WriteOp {
  return {
    opId,
    entityId: "task:task-current",
    kind: "doc_write",
    payload: { path: "progress.md", body: "current" }
  };
}
