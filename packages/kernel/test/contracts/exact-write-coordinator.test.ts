// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  createJournaledBatch,
  withExactCommit
} from "../../src/index.ts";

test("exact batch constructor rejects a runtime-empty batch as typed WriteRejected", () => {
  const failure = captureFailure(() => createJournaledBatch(
    [] as unknown as Parameters<typeof createJournaledBatch>[0]
  ));

  assert.deepEqual(failure, {
    _tag: "WriteRejected",
    code: "authority_exact_batch_empty",
    reason: "Authority publication requires a non-empty exact journal batch.",
    retryable: false
  });
});

test("exact batch constructor rejects duplicate operation ids as typed WriteRejected", () => {
  const coordinator = withExactCommit({
    enqueue: (op) => Effect.succeed({
      opId: op.opId,
      entityId: op.entityId,
      accepted: true as const
    }),
    recover: Effect.succeed({ replayedOps: 0 })
  }, (reason, acknowledgements) => Effect.succeed({
    reason,
    opCount: acknowledgements.length,
    committed: true
  }));
  const entry = Effect.runSync(coordinator.enqueue({
    opId: "op-duplicate",
    entityId: "task/task-duplicate",
    kind: "progress_append"
  }));

  const failure = captureFailure(() => createJournaledBatch([entry, entry]));

  assert.equal(failure._tag, "WriteRejected");
  assert.equal(failure.code, "authority_exact_batch_duplicate_operation");
});

function captureFailure(run: () => unknown): {
  readonly _tag?: unknown;
  readonly code?: unknown;
  readonly reason?: unknown;
  readonly retryable?: unknown;
} {
  try {
    run();
  } catch (error) {
    return error as ReturnType<typeof captureFailure>;
  }
  throw new Error("expected exact batch construction to fail");
}
