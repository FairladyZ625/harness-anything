// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { makeOfflineCompletionChain } from "../src/store/offline-completion-chain.ts";
import {
  serializePersistedCanonicalEvent,
  parseCanonicalEvent,
  validateCurrentCanonicalEvent,
} from "../src/domain/doc-sync-canonical-events.ts";
import {
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
  validateTransition,
  normalizeTaskLifecycleCommand,
} from "../src/domain/task-lifecycle.contract.ts";
import { taskCompletionNext } from "../src/domain/completion-readiness.ts";
import { validateSubmissionV1 } from "../src/domain/execution.ts";
import type { CanonicalEventV1 } from "../src/domain/doc-sync-types.ts";
import type { TaskEventV1 } from "../src/domain/task-lifecycle-event.ts";

import { digest, actor, stamp, history } from "./store/completion-history.fixtures.ts";

function convert() {
  const mapper = makeOfflineCompletionChain({
    generation: 2,
    snapshots: new Map(),
    missingSnapshots: new Set([digest]),
    readContent: () => null,
  });
  return history().map((event) => mapper.convert(event));
}

test("missing snapshot is an explicit replayable gap, preserving acceptance without creating bytes or pass", () => {
  const converted = convert();
  assert.equal(converted.flatMap((value) => value.blobs).length, 0);
  const replay = () =>
    converted.reduce(
      (snapshot, value) =>
        reduceTaskEvent(snapshot, parseCanonicalEvent(serializePersistedCanonicalEvent(value.event)) as TaskEventV1),
      emptyTaskLifecycleSnapshot(),
    );
  const cold = replay();
  assert.deepEqual(replay(), cold);
  assert.equal(cold.task?.status, "done");
  assert.equal(cold.executions[0]?.state, "accepted");
  assert.equal(cold.task?.presetSnapshotDigest, digest);
  assert.deepEqual(cold.task?.presetSnapshotGap, {
    reason: "snapshot-bytes-unavailable",
    sourceGeneration: 2,
    sourceRevision: 1,
  });
  assert.deepEqual(cold.gateWitnesses, []);
  const next = taskCompletionNext(cold, {
    closeout: "ready",
    closeoutPath: "closeout.md",
    eligibleDirtyPaths: [],
    producesFactCount: 1,
    projectionStatus: "ready",
  });
  assert.match(next.blocker!.next.reason, /Historical snapshot gap/);
  assert.match(next.blocker!.next.reason, /cannot satisfy completion/);
  assert.ok(validateCurrentCanonicalEvent(converted.at(-1)!.event).length);
  assert.ok(validateSubmissionV1(cold.executions[0]!.submission).length);
});

test("a new submission cannot use a historical task gap even with a current contract", () => {
  const converted = convert().slice(0, 3);
  const snapshot = converted.reduce(
    (state, value) => reduceTaskEvent(state, value.event as TaskEventV1),
    emptyTaskLifecycleSnapshot(),
  );
  const historical = snapshot.executions[0]!.submission!;
  const { historicalAcceptance: _accepted, ...currentContract } = historical.completionContract;
  const command = {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "repo", actor: actor as never, source: "local", expectedRevision: 3 },
      {
        type: "SubmitExecution",
        taskId: "task-history",
        executionId: "execution-history",
        amend: true,
        submission: { ...historical, completionContract: { ...currentContract, gates: [] } },
      },
    ),
    workspaceRevision: 4,
    eventId: "new-event",
    occurredAt: stamp,
  };
  const issues = validateTransition(snapshot, command, {
    actorBinding: actor,
    executionId: "execution-history",
  } as never);
  assert.ok(issues.some((issue) => issue.message.includes("Historical snapshot bytes are unavailable")));
});

test("a missing source not inventoried as a gap stops conversion", () => {
  const mapper = makeOfflineCompletionChain({
    generation: 2,
    snapshots: new Map(),
    missingSnapshots: new Set(),
    readContent: () => null,
  });
  assert.throws(() => mapper.convert(history()[0]!), /no accepted content claim or inventoried historical gap/);
});

test("a historical receipt outside the first submission requirements remains acceptance history only", () => {
  const source = history();
  for (const event of source) (event.payload as { task: { completionGateIds: string[] } }).task.completionGateIds = [];
  const submitted = source[2] as Extract<TaskEventV1, { type: "execution_submitted" }>;
  const witness = {
    schema: "completion-gate-witness/v1",
    witnessId: "witness-old",
    receiptId: "op-witness",
    checkerId: "standard",
    gateId: "ci",
    result: "pass",
    taskId: "task-history",
    executionId: "execution-history",
    commitSha: "b".repeat(40),
    iteration: 0,
    actor,
    source: "local",
    verifiedAt: stamp,
  };
  const accepted = { ...source[3], workspaceRevision: 5 };
  source.splice(
    3,
    1,
    {
      ...submitted,
      type: "completion_gate_verified",
      workspaceRevision: 4,
      eventId: "event-witness",
      opId: "op-witness",
      payload: { task: submitted.payload.task, execution: submitted.payload.execution, witness, documentClaims: [] },
    } as unknown as CanonicalEventV1,
    accepted as CanonicalEventV1,
  );
  const mapper = makeOfflineCompletionChain({
    generation: 2,
    snapshots: new Map(),
    missingSnapshots: new Set([digest]),
    readContent: () => null,
  });
  const converted = source.map((event) => mapper.convert(event).event);
  const replayed = converted.reduce(
    (state, event) =>
      reduceTaskEvent(state, parseCanonicalEvent(serializePersistedCanonicalEvent(event)) as TaskEventV1),
    emptyTaskLifecycleSnapshot(),
  );
  const receipt = replayed.gateWitnesses[0]!;
  assert.equal(receipt.schema, "completion-gate-acceptance/v1");
  assert.equal(receipt.receiptId, witness.receiptId);
  assert.equal(receipt.result, "pass");
  assert.equal(receipt.subjects, undefined);
  assert.ok(validateCurrentCanonicalEvent(converted[3]).length);
  const wrong = structuredClone(converted[3]) as unknown as {
    payload: { witness: { historicalAcceptance: { submissionDigest: string } } };
  };
  wrong.payload.witness.historicalAcceptance.submissionDigest = `sha256:${"f".repeat(64)}`;
  const before = converted
    .slice(0, 3)
    .reduce((state, event) => reduceTaskEvent(state, event as TaskEventV1), emptyTaskLifecycleSnapshot());
  assert.throws(() => reduceTaskEvent(before, wrong as unknown as TaskEventV1), /not bound to the execution cut/);
});
