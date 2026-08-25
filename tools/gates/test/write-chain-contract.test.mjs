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
  WriteChainContractError,
} from "../../../packages/kernel/src/domain/write-chain.contract.ts";
import {
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  serializeTaskEvent,
} from "../../../packages/kernel/src/domain/task-lifecycle.contract.ts";
import { decideTaskLifecycleWrite } from "../../../packages/kernel/src/domain/task-write-decision.ts";
import { REPLAY_TASK_GRAPH } from "../../../packages/kernel/src/domain/task-graph.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "worker" } };

test("G02 derives a stable opId and digest from one normalized command envelope", () => {
  const input = {
    workspaceId: "workspace-1",
    actor,
    source: "local",
    expectedRevision: 0,
    command: { type: "CreateReplayTask", taskId: "task-1", title: "Replay task" },
  };
  const first = normalizeCommandEnvelope(input);
  const reordered = normalizeCommandEnvelope({
    ...input,
    command: { title: "Replay task", taskId: "task-1", type: "CreateReplayTask" },
  });

  assert.equal(first.opId, reordered.opId);
  assert.equal(first.commandDigest, reordered.commandDigest);
  assert.match(first.opId, /^op_[0-9a-f]{64}$/u);
  assert.match(first.commandDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(
    { source: first.source, expectedRevision: first.expectedRevision },
    { source: "local", expectedRevision: 0 },
  );
  assert.notEqual(first.commandDigest, normalizeCommandEnvelope({ ...input, source: "remote_direct" }).commandDigest);
  const revisionInput = { ...input, command: { type: "SubmitExecution", taskId: "task-1" } };
  assert.notEqual(
    normalizeCommandEnvelope(revisionInput).commandDigest,
    normalizeCommandEnvelope({ ...revisionInput, expectedRevision: 1 }).commandDigest,
  );
  assert.equal(Object.isFrozen(first), true);
  assert.match(
    validateNormalizedCommandEnvelope(first, {
      ...input,
      command: { ...input.command, title: "different" },
    }).join("\n"),
    /digest/u,
  );
});

test("G03 rejects an unsafe target before freezing the write plan", () => {
  assert.throws(
    () =>
      freezeDeclaredWritePlan(
        {
          commandType: "CreateReplayTask",
          targets: [
            { kind: "event_file", path: "../events/op-1.json", operation: "create" },
            { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
            { kind: "projection_invalidation", projection: "task-lifecycle/v1", key: "task-1" },
          ],
        },
        ["CreateReplayTask"],
      ),
    (error) => error instanceof WriteChainContractError && error.code === "invalid_write_plan",
  );
});

test("G03 derives exact local WAL declarations from canonical targets", () => {
  const plan = freezeDeclaredWritePlan(
    {
      commandType: "CreateReplayTask",
      targets: [
        { kind: "event_file", path: "harness/events/op-1.json", operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        { kind: "projection_invalidation", projection: "task-lifecycle/v1", key: "task-1" },
        { kind: "content_blob", sha256: "a".repeat(64), size: 4, mediaType: "text/plain" },
      ],
    },
    ["CreateReplayTask"],
  );
  assert.deepEqual(
    plan.targets.filter((target) => target.kind === "local_wal_file"),
    [
      { kind: "local_wal_file", path: ".harness/wal/seg-000000.log", operation: "append" },
      { kind: "local_wal_file", path: ".harness/wal/head.json", operation: "replace" },
      { kind: "local_wal_file", path: `.harness/wal/objects/${"a".repeat(64)}`, operation: "replace" },
    ],
  );
  assert.throws(
    () =>
      freezeDeclaredWritePlan(
        {
          commandType: "CreateReplayTask",
          targets: [
            ...plan.targets,
            { kind: "local_wal_file", path: `.harness/wal/objects/${"b".repeat(64)}`, operation: "replace" },
          ],
        },
        ["CreateReplayTask"],
      ),
    /local WAL targets must exactly derive/u,
  );
});

test("G02 rejects invalid or payload-reported command sources", () => {
  const binding = { workspaceId: "workspace-1", actor, expectedRevision: 0 };
  assert.throws(
    () => normalizeCommandEnvelope({ ...binding, source: "peer_env", command: { type: "CreateReplayTask" } }),
    WriteChainContractError,
  );
  assert.throws(
    () =>
      normalizeCommandEnvelope({
        ...binding,
        source: "local",
        command: {
          type: "CreateReplayTask",
          source: "remote_direct",
        },
      }),
    WriteChainContractError,
  );
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
    payload: { task: { title: "Replay task", taskId: "task-1" } },
  };
  const bytes = serializeEventEnvelope(event);
  const reorderedBytes = serializeEventEnvelope({
    payload: event.payload,
    occurredAt: event.occurredAt,
    actor,
    source: event.source,
    type: event.type,
    taskId: event.taskId,
    opId: event.opId,
    workspaceRevision: 1,
    eventId: event.eventId,
    schema: event.schema,
  });
  assert.equal(bytes, reorderedBytes);
  assert.match(bytes, /"source":"local"/u);
  assert.throws(() => serializeEventEnvelope({ ...event, source: "peer_env" }), WriteChainContractError);
  assert.throws(
    () =>
      serializeEventEnvelope({
        ...event,
        actor: {
          principal: { kind: "agent", personId: "person-owner" },
          executor: null,
        },
      }),
    WriteChainContractError,
  );
  assert.equal(
    serializeEventHead({ revision: 1, opId: "op_1", eventDigest: "sha256:" + "a".repeat(64) }),
    '{"eventDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","opId":"op_1","revision":1}\n',
  );
});

test("G02/G07 expose one four-state receipt and bounded recovery contract", async () => {
  const contract = await import("../../../packages/kernel/src/domain/write-chain.contract.ts");
  assert.deepEqual(contract.writeReceiptOutcomes, ["applied", "pending", "no_changes", "indeterminate", "op_rejected"]);
  assert.deepEqual(contract.RECOVERY_BUDGET, { deadline: 100, maxItems: 64, retry: 1 });
  assert.equal(Object.isFrozen(contract.RECOVERY_BUDGET), true);
  const recovery = nextRecoveryBatch(Array.from({ length: 10_000 }, (_, index) => index));
  assert.equal(recovery.items.length, 64);
  assert.deepEqual(
    recovery.items,
    Array.from({ length: 64 }, (_, index) => index),
  );
  assert.deepEqual(
    { deferred: recovery.deferred, nextCursor: recovery.nextCursor },
    { deferred: 9_936, nextCursor: 64 },
  );
  assert.deepEqual(
    createWriteReceipt({
      outcome: "applied",
      opId: "op_1",
      revision: 1,
      evidence: "event:op_1",
      visibility: "center",
      proof: { committedRevision: 1, appliedCut: 1, durable: true, canonicalVisible: true, worktreeVisible: null },
    }),
    {
      authorizationDecision: null,
      delta: { fact: [], decision: [], task: [] },
      outcome: "applied",
      opId: "op_1",
      revision: 1,
      evidence: "event:op_1",
      visibility: "center",
      proof: { committedRevision: 1, appliedCut: 1, durable: true, canonicalVisible: true, worktreeVisible: null },
    },
  );
  assert.throws(
    () =>
      createWriteReceipt({
        outcome: "applied",
        opId: "op_1",
        revision: 1,
        evidence: "event:op_1",
        visibility: "center",
        proof: { committedRevision: 1, appliedCut: 1, durable: true, canonicalVisible: true, worktreeVisible: null },
        leaseCredential: "removed",
      }),
    WriteChainContractError,
  );
});

test("G08 recovery cursor is monotonic, visits once, reports exhausted budgets, drains, and escalates exhausted retry", () => {
  const budget = { deadline: 100, maxItems: 2, retry: 1 };
  for (const invalid of [
    { ...budget, deadline: -1 },
    { ...budget, maxItems: -1 },
    { ...budget, retry: -1 },
  ]) {
    assert.throws(() => nextRecoveryBatch([0, 1], 0, invalid), WriteChainContractError);
  }
  const first = nextRecoveryBatch([0, 1, 2, 3, 4], 0, budget);
  const second = nextRecoveryBatch([0, 1, 2, 3, 4], first.nextCursor, budget);
  const third = nextRecoveryBatch([0, 1, 2, 3, 4], second.nextCursor, budget);
  assert.deepEqual([first.nextCursor, second.nextCursor, third.nextCursor], [2, 4, 5]);
  assert.deepEqual([...first.items, ...second.items, ...third.items], [0, 1, 2, 3, 4]);
  assert.deepEqual([first.deferred, first.state, third.deferred, third.state], [3, "exhausted", 0, "drained"]);
  assert.deepEqual(nextRecoveryBatch([0, 1], 0, budget, { elapsed: 100, attempt: 0 }), {
    items: [],
    deferred: 2,
    nextCursor: 0,
    state: "exhausted",
  });
  assert.deepEqual(nextRecoveryBatch([0, 1], 0, budget, { elapsed: 0, attempt: 2 }), {
    items: [],
    deferred: 2,
    nextCursor: 0,
    state: "failed",
  });
});

test("G02/G03 task decision rejects stale writers, conflicting opIds, and unsafe targets before publication", () => {
  const activeWriter = { workspaceId: "workspace-1", generation: 2, ownerId: "daemon-a" };
  const writerToken = issueWriterGenerationToken(activeWriter);
  const command = {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "workspace-1", actor, source: "local", expectedRevision: 0 },
      {
        type: "CreateReplayTask",
        taskId: "task-1",
        title: "Replay task",
        taskClass: "standard",
        graph: REPLAY_TASK_GRAPH,
        completionGateIds: [],
        presetSnapshotDigest: null,
      },
    ),
    eventId: "event-1",
    workspaceRevision: 1,
    occurredAt: "2026-08-11T00:00:00.000Z",
  };
  const proof = { taskIdUnique: true, actorBinding: actor };
  const decide = (overrides = {}) =>
    decideTaskLifecycleWrite({
      snapshot: emptyTaskLifecycleSnapshot(),
      command,
      proof,
      activeWriter,
      writerToken,
      ...overrides,
    });

  const legal = decide();
  assert.equal(legal.accepted, true);
  assert.equal(legal.receipt.outcome, "indeterminate");
  assert.equal(legal.accepted && serializeTaskEvent(legal.event), legal.accepted && serializeTaskEvent(decide().event));

  const stale = decide({ writerToken: issueWriterGenerationToken({ ...activeWriter, generation: 1 }) });
  assert.deepEqual(
    [stale.accepted, stale.receipt.outcome, stale.receipt.code],
    [false, "op_rejected", "writer_rejected"],
  );

  const conflict = decide({
    existingOperation: {
      opId: command.opId,
      commandDigest: `sha256:${"0".repeat(64)}`,
      event: legal.event,
      receipt: legal.receipt,
    },
  });
  assert.deepEqual(
    [conflict.accepted, conflict.receipt.outcome, conflict.receipt.code],
    [false, "op_rejected", "operation_conflict"],
  );

  const sourceDrift = decide({
    command: { ...command, source: "remote_direct" },
    existingOperation: {
      opId: command.opId,
      commandDigest: command.commandDigest,
      event: legal.event,
      receipt: legal.receipt,
    },
  });
  assert.deepEqual(
    [sourceDrift.accepted, sourceDrift.receipt.outcome, sourceDrift.receipt.code],
    [false, "op_rejected", "invalid_schema"],
  );

  const unsafe = {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "workspace-1", actor, source: "local", expectedRevision: 0 },
      {
        type: "CreateReplayTask",
        taskId: "../escape",
        title: "Unsafe",
        taskClass: "standard",
        graph: REPLAY_TASK_GRAPH,
        completionGateIds: [],
        presetSnapshotDigest: null,
      },
    ),
    eventId: "event-unsafe",
    workspaceRevision: 1,
    occurredAt: "2026-08-11T00:00:00.000Z",
  };
  const invalidTarget = decide({ command: unsafe });
  assert.deepEqual(
    [invalidTarget.accepted, invalidTarget.receipt.outcome, invalidTarget.receipt.code],
    [false, "op_rejected", "invalid_write_plan"],
  );
});

test("G03 returns an immutable event with stable canonical bytes", () => {
  const activeWriter = { workspaceId: "workspace-1", generation: 2, ownerId: "daemon-a" };
  const command = {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "workspace-1", actor, source: "local", expectedRevision: 0 },
      {
        type: "CreateReplayTask",
        taskId: "task-1",
        title: "Replay task",
        taskClass: "standard",
        graph: REPLAY_TASK_GRAPH,
        completionGateIds: [],
        presetSnapshotDigest: null,
      },
    ),
    eventId: "event-1",
    workspaceRevision: 1,
    occurredAt: "2026-08-11T00:00:00.000Z",
  };
  const decision = decideTaskLifecycleWrite({
    snapshot: emptyTaskLifecycleSnapshot(),
    command,
    proof: { taskIdUnique: true, actorBinding: actor },
    activeWriter,
    writerToken: issueWriterGenerationToken(activeWriter),
  });
  assert.equal(decision.accepted, true);
  if (!decision.accepted) return;
  const before = serializeTaskEvent(decision.event);
  assert.equal(Object.isFrozen(decision.event), true);
  assert.equal(Object.isFrozen(decision.event.payload), true);
  assert.equal(Object.isFrozen(decision.event.payload.task), true);
  assert.throws(() => {
    decision.event.payload.task.title = "mutated";
  }, TypeError);
  assert.equal(serializeTaskEvent(decision.event), before);
});

test("G03 rejects a second writer and a token from an old generation", () => {
  const active = { workspaceId: "workspace-1", generation: 2, ownerId: "daemon-a" };
  const current = issueWriterGenerationToken(active);
  assert.doesNotThrow(() => assertCurrentWriter(active, current, "workspace-1"));

  for (const token of [
    issueWriterGenerationToken({ ...active, generation: 1 }),
    issueWriterGenerationToken({ ...active, ownerId: "daemon-b" }),
  ]) {
    assert.throws(
      () => assertCurrentWriter(active, token, "workspace-1"),
      (error) => error instanceof WriteChainContractError && error.code === "writer_rejected",
    );
  }
});
