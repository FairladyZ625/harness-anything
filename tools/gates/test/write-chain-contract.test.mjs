// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCurrentWriter,
  createWriteReceipt,
  freezeDeclaredWritePlan,
  issueWriterGenerationToken,
  nextRecoveryBatch,
  normalizeCommandEnvelope,
  serializeEventEnvelope,
  serializeEventHead,
  validateNormalizedCommandEnvelope,
  WriteChainContractError
} from "../../../packages/kernel/src/domain/write-chain.contract.ts";
import { emptyTaskLifecycleSnapshot, normalizeTaskLifecycleCommand, serializeTaskEvent } from "../../../packages/kernel/src/domain/task-lifecycle.contract.ts";
import { decideTaskLifecycleWrite } from "../../../packages/kernel/src/domain/task-write-decision.ts";
import { REPLAY_TASK_GRAPH } from "../../../packages/kernel/src/domain/task-graph.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "worker" } };

test("G02 derives a stable opId and digest from one normalized command envelope", () => {
  const input = {
    workspaceId: "workspace-1",
    actor,
    source: "local",
    expectedRevision: 0,
    command: { type: "CreateReplayTask", taskId: "task-1", title: "Replay task" }
  };
  const first = normalizeCommandEnvelope(input);
  const reordered = normalizeCommandEnvelope({
    ...input,
    command: { title: "Replay task", taskId: "task-1", type: "CreateReplayTask" }
  });

  assert.equal(first.opId, reordered.opId);
  assert.equal(first.commandDigest, reordered.commandDigest);
  assert.match(first.opId, /^op_[0-9a-f]{64}$/u);
  assert.match(first.commandDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual({ source: first.source, expectedRevision: first.expectedRevision }, { source: "local", expectedRevision: 0 });
  assert.notEqual(first.commandDigest, normalizeCommandEnvelope({ ...input, source: "remote_direct" }).commandDigest);
  const revisionInput = { ...input, command: { type: "SubmitExecution", taskId: "task-1" } };
  assert.notEqual(normalizeCommandEnvelope(revisionInput).commandDigest,
    normalizeCommandEnvelope({ ...revisionInput, expectedRevision: 1 }).commandDigest);
  assert.equal(Object.isFrozen(first), true);
  assert.match(validateNormalizedCommandEnvelope(first, {
    ...input, command: { ...input.command, title: "different" }
  }).join("\n"), /digest/u);
});

test("G03 rejects an unsafe target before freezing the write plan", () => {
  assert.throws(() => freezeDeclaredWritePlan({
    commandType: "CreateReplayTask",
    targets: [
      { kind: "event_stream", stream: "../task-events.ndjson", operation: "append" },
      { kind: "projection_invalidation", projection: "task-lifecycle/v1", taskId: "task-1" }
    ]
  }, ["CreateReplayTask"]), (error) => error instanceof WriteChainContractError && error.code === "invalid_write_plan");
});

test("G02 rejects invalid or payload-reported command sources", () => {
  const binding = { workspaceId: "workspace-1", actor, expectedRevision: 0 };
  assert.throws(() => normalizeCommandEnvelope({ ...binding, source: "peer_env", command: { type: "CreateReplayTask" } }), WriteChainContractError);
  assert.throws(() => normalizeCommandEnvelope({ ...binding, source: "local", command: {
    type: "CreateReplayTask", source: "remote_direct"
  } }), WriteChainContractError);
});

test("G02 freezes deterministic event bytes and a committed head shape", () => {
  const event = {
    schema: "task-event/v1",
    eventId: "event-1",
    workspaceRevision: 1,
    opId: "op_1",
    taskId: "task-1",
    type: "task_created",
    actor,
    source: "local",
    occurredAt: "2026-08-11T00:00:00.000Z",
    payload: { task: { title: "Replay task", taskId: "task-1" } }
  };
  const bytes = serializeEventEnvelope(event);
  const reorderedBytes = serializeEventEnvelope({ payload: event.payload, occurredAt: event.occurredAt,
    actor, source: event.source, type: event.type, taskId: event.taskId, opId: event.opId, workspaceRevision: 1,
    eventId: event.eventId, schema: event.schema });
  assert.equal(bytes, reorderedBytes);
  assert.match(bytes, /"source":"local"/u);
  assert.throws(() => serializeEventEnvelope({ ...event, source: "peer_env" }), WriteChainContractError);
  assert.throws(() => serializeEventEnvelope({ ...event, actor: {
    principal: { kind: "agent", personId: "person-owner" }, executor: null
  } }), WriteChainContractError);
  assert.equal(serializeEventHead({ revision: 1, opId: "op_1", eventDigest: "sha256:" + "a".repeat(64) }),
    '{"eventDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","opId":"op_1","revision":1}\n');
});

test("G02/G07 expose one four-state receipt and bounded recovery contract", async () => {
  const contract = await import("../../../packages/kernel/src/domain/write-chain.contract.ts");
  assert.deepEqual(contract.writeReceiptOutcomes, ["applied", "pending", "indeterminate", "rejected"]);
  assert.deepEqual(contract.RECOVERY_BUDGET, { deadline: 100, maxItems: 64, retry: 1 });
  assert.equal(Object.isFrozen(contract.RECOVERY_BUDGET), true);
  const recovery = nextRecoveryBatch(Array.from({ length: 10_000 }, (_, index) => index));
  assert.equal(recovery.items.length, 64);
  assert.deepEqual(recovery.items, Array.from({ length: 64 }, (_, index) => index));
  assert.deepEqual({ deferred: recovery.deferred, nextCursor: recovery.nextCursor }, { deferred: 9_936, nextCursor: 64 });
  assert.deepEqual(createWriteReceipt({
    outcome: "applied", opId: "op_1", revision: 1, evidence: "event:op_1", visibility: "center",
    proof: { committedRevision: 1, appliedCut: 1 }
  }), { outcome: "applied", opId: "op_1", revision: 1, evidence: "event:op_1", visibility: "center",
    proof: { committedRevision: 1, appliedCut: 1 } });
  assert.throws(() => createWriteReceipt({
    outcome: "applied", opId: "op_1", revision: 1, evidence: "event:op_1", visibility: "center",
    proof: { committedRevision: 1, appliedCut: 1 }, leaseCredential: "removed"
  }), WriteChainContractError);
});

test("G02/G03 task decision rejects stale writers, conflicting opIds, and unsafe targets before publication", () => {
  const activeWriter = { workspaceId: "workspace-1", generation: 2, ownerId: "daemon-a" };
  const writerToken = issueWriterGenerationToken(activeWriter);
  const command = { ...normalizeTaskLifecycleCommand({ workspaceId: "workspace-1", actor, source: "local", expectedRevision: 0 }, {
    type: "CreateReplayTask", taskId: "task-1", title: "Replay task", graph: REPLAY_TASK_GRAPH, completionGateIds: []
  }), eventId: "event-1", workspaceRevision: 1, occurredAt: "2026-08-11T00:00:00.000Z" };
  const proof = { taskIdUnique: true, actorBinding: actor };
  const decide = (overrides = {}) => decideTaskLifecycleWrite({
    snapshot: emptyTaskLifecycleSnapshot(), command, proof, activeWriter, writerToken, ...overrides
  });

  const legal = decide();
  assert.equal(legal.accepted, true);
  assert.equal(legal.receipt.outcome, "indeterminate");
  assert.equal(legal.accepted && serializeTaskEvent(legal.event), legal.accepted && serializeTaskEvent(decide().event));

  const stale = decide({ writerToken: issueWriterGenerationToken({ ...activeWriter, generation: 1 }) });
  assert.deepEqual([stale.accepted, stale.receipt.outcome, stale.receipt.code], [false, "rejected", "writer_rejected"]);

  const conflict = decide({ existingOperation: { opId: command.opId, commandDigest: `sha256:${"0".repeat(64)}`,
    event: legal.event, receipt: legal.receipt } });
  assert.deepEqual([conflict.accepted, conflict.receipt.outcome, conflict.receipt.code], [false, "rejected", "operation_conflict"]);

  const unsafe = { ...normalizeTaskLifecycleCommand({ workspaceId: "workspace-1", actor, source: "local", expectedRevision: 0 }, {
    type: "CreateReplayTask", taskId: "../escape", title: "Unsafe", graph: REPLAY_TASK_GRAPH, completionGateIds: []
  }), eventId: "event-unsafe", workspaceRevision: 1, occurredAt: "2026-08-11T00:00:00.000Z" };
  const invalidTarget = decide({ command: unsafe });
  assert.deepEqual([invalidTarget.accepted, invalidTarget.receipt.outcome, invalidTarget.receipt.code], [false, "rejected", "invalid_write_plan"]);
});

test("G03 rejects a second writer and a token from an old generation", () => {
  const active = { workspaceId: "workspace-1", generation: 2, ownerId: "daemon-a" };
  const current = issueWriterGenerationToken(active);
  assert.doesNotThrow(() => assertCurrentWriter(active, current, "workspace-1"));

  for (const token of [
    issueWriterGenerationToken({ ...active, generation: 1 }),
    issueWriterGenerationToken({ ...active, ownerId: "daemon-b" })
  ]) {
    assert.throws(
      () => assertCurrentWriter(active, token, "workspace-1"),
      (error) => error instanceof WriteChainContractError && error.code === "writer_rejected"
    );
  }
});
