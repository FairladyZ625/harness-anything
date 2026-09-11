// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCurrentWriter,
  freezeDeclaredWritePlan,
  issueWriterGenerationToken,
  nextRecoveryBatch,
  normalizeCommandEnvelope,
  normalizeContentAddressedInputs,
  serializeEventEnvelope,
  serializeEventHead,
  validateNormalizedCommandEnvelope,
  WriteChainContractError,
} from "../../../packages/kernel/src/domain/write-chain.contract.ts";

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

test("G03 keys authored targets by path even when their content is identical", () => {
  const sha256 = "a".repeat(64);
  const plan = freezeDeclaredWritePlan(
    {
      commandType: "DocSyncSubmit",
      targets: [
        { kind: "event_file", path: "harness/events/op-1.json", operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        { kind: "projection_invalidation", projection: "document/v1", key: "context/one.md" },
        {
          kind: "authored_file",
          path: "context/one.md",
          operation: "replace",
          sha256,
          size: 4,
          mediaType: "text/plain",
        },
        {
          kind: "authored_file",
          path: "context/two.md",
          operation: "replace",
          sha256,
          size: 4,
          mediaType: "text/plain",
        },
      ],
    },
    ["DocSyncSubmit"],
  );

  assert.deepEqual(
    plan.targets.filter((target) => target.kind === "authored_file").map((target) => target.path),
    ["context/one.md", "context/two.md"],
  );
});

test("G03 still rejects two authored writes to the same path", () => {
  const authored = {
    kind: "authored_file",
    path: "context/one.md",
    operation: "replace",
    sha256: "a".repeat(64),
    size: 4,
    mediaType: "text/plain",
  };
  assert.throws(
    () =>
      freezeDeclaredWritePlan(
        {
          commandType: "DocSyncSubmit",
          targets: [
            { kind: "event_file", path: "harness/events/op-1.json", operation: "create" },
            { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
            { kind: "projection_invalidation", projection: "document/v1", key: "context/one.md" },
            authored,
            authored,
          ],
        },
        ["DocSyncSubmit"],
      ),
    /duplicate write target: authored_file:context\/one\.md/u,
  );
});

test("G03 folds identical content targets by SHA and rejects conflicting ones", () => {
  const content = { kind: "content_blob", sha256: "a".repeat(64), size: 4, mediaType: "text/plain" };
  const plan = freezeDeclaredWritePlan(
    {
      commandType: "DocSyncSubmit",
      targets: [
        { kind: "event_file", path: "harness/events/op-1.json", operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        { kind: "projection_invalidation", projection: "document/v1", key: "context/one.md" },
        content,
        { ...content },
      ],
    },
    ["DocSyncSubmit"],
  );

  assert.equal(plan.targets.filter((target) => target.kind === "content_blob").length, 1);
  assert.throws(
    () =>
      freezeDeclaredWritePlan(
        {
          commandType: "DocSyncSubmit",
          targets: [...plan.targets, { ...content, mediaType: "application/octet-stream" }],
        },
        ["DocSyncSubmit"],
      ),
    /conflicting content-addressed write target/u,
  );
});

test("G03 folds identical blob inputs and rejects conflicting bodies for one SHA", () => {
  const blob = {
    sha256: "a".repeat(64),
    size: 4,
    mediaType: "text/plain",
    body: "left",
  };
  assert.deepEqual(normalizeContentAddressedInputs([blob, { ...blob }]), [blob]);
  assert.throws(
    () => normalizeContentAddressedInputs([blob, { ...blob, body: "rght" }]),
    /conflicting size, media type, or body/u,
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
