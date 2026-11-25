// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  reduceRuntimeSession,
  validateCurrentAgentRuntimeEvent,
  type AgentRuntimeEventV1,
} from "../src/domain/agent-runtime.ts";
import {
  evaluateInboxConsumption,
  inboxDedupeKey,
  inboxQueueCursor,
  reduceInboxItem,
  type InboxEvent,
  type InboxEventPayloads,
  type InboxEventType,
  type InboxItem,
} from "../src/domain/inbox.ts";
import { privateRuntimeEventTypes } from "../src/domain/runtime-public-query.ts";

const ACTOR = { principal: { personId: "person-inbox" }, executor: null } as const;

function inboxEvent<T extends InboxEventType>(
  revision: number,
  type: T,
  payload: InboxEventPayloads[T],
): Extract<InboxEvent, { readonly type: T }> {
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-inbox-${revision}`,
    workspaceRevision: revision,
    opId: `op-inbox-${revision}`,
    actor: ACTOR,
    source: "local",
    occurredAt: `2026-11-18T00:00:${String(revision).padStart(2, "0")}.000Z`,
    type,
    payload,
  } as unknown as Extract<InboxEvent, { readonly type: T }>;
}

const rulingKey = inboxDedupeKey({ source: "ruling_resolved", sourceRef: "dispatch/dispatch_a", sourceEpoch: 3 });

function enqueued(revision: number, overrides: Partial<InboxEventPayloads["inbox_item_enqueued"]> = {}) {
  return inboxEvent(revision, "inbox_item_enqueued", {
    inboxId: "task:task_a",
    itemId: `item-${revision}`,
    source: "ruling_resolved",
    sourceRef: "dispatch/dispatch_a",
    sourceEpoch: 3,
    dedupeKey: rulingKey,
    admission: "dispatchable",
    taskId: "task_a",
    agentId: "terra",
    summary: "Ruling answered: proceed",
    enqueuedAt: "2026-11-18T00:00:01.000Z",
    ...overrides,
  });
}

function claimed(revision: number, claimId: string, claimedAt: string, leaseUntil: string, itemId = "item-1") {
  return inboxEvent(revision, "inbox_item_claimed", {
    inboxId: "task:task_a",
    itemId,
    claimId,
    claimedAt,
    leaseUntil,
  });
}

function applied(current: InboxItem | null, event: InboxEvent): InboxItem {
  const step = reduceInboxItem(current, event);
  assert.equal(step.kind, "applied", JSON.stringify(step));
  return (step as { item: InboxItem }).item;
}

test("inbox events are admitted by the live runtime validator and stay out of session and public activity", () => {
  const events: readonly InboxEvent[] = [
    enqueued(1),
    claimed(2, "claim-1", "2026-11-18T00:00:02.000Z", "2026-11-18T00:01:02.000Z"),
    inboxEvent(3, "inbox_item_completed", {
      inboxId: "task:task_a",
      itemId: "item-1",
      claimId: "claim-1",
      dispatchId: "dispatch_b",
      completedAt: "2026-11-18T00:00:03.000Z",
    }),
    inboxEvent(4, "inbox_item_failed", {
      inboxId: "task:task_a",
      itemId: "item-1",
      claimId: "claim-1",
      reasonCode: "runtime_spawn_failed",
      failedAt: "2026-11-18T00:00:04.000Z",
    }),
    inboxEvent(5, "inbox_item_dropped_stale", {
      inboxId: "task:task_a",
      itemId: "item-1",
      claimId: null,
      reasonCode: "source_epoch_superseded",
      observedSourceEpoch: 4,
      droppedAt: "2026-11-18T00:00:05.000Z",
    }),
  ];
  for (const event of events) {
    assert.deepEqual(validateCurrentAgentRuntimeEvent(event), [], event.type);
    // The session reducer ignores Inbox events instead of demanding a runtimeSessionId.
    assert.equal(reduceRuntimeSession(null, event as AgentRuntimeEventV1), null);
    assert.ok((privateRuntimeEventTypes as readonly string[]).includes(event.type));
  }
});

test("inbox payload contract rejects unknown fields, mismatched targets, and unbounded identities", () => {
  const extra = { ...enqueued(1), payload: { ...enqueued(1).payload, data: { answer: "yes" } } };
  assert.notDeepEqual(validateCurrentAgentRuntimeEvent(extra), []);
  assert.notDeepEqual(validateCurrentAgentRuntimeEvent(enqueued(1, { taskId: "task_other" })), []);
  assert.notDeepEqual(validateCurrentAgentRuntimeEvent(enqueued(1, { inboxId: "queue:task_a" })), []);
  assert.notDeepEqual(validateCurrentAgentRuntimeEvent(enqueued(1, { sourceEpoch: -1 })), []);
  assert.notDeepEqual(validateCurrentAgentRuntimeEvent(enqueued(1, { dedupeKey: "x".repeat(513) })), []);
  assert.notDeepEqual(validateCurrentAgentRuntimeEvent(enqueued(1, { consumerKind: "other" as never })), []);
  assert.notDeepEqual(validateCurrentAgentRuntimeEvent(enqueued(1, { minRevision: -1 })), []);
  assert.notDeepEqual(
    validateCurrentAgentRuntimeEvent(enqueued(1, { requiredBlobSha256s: Array(17).fill("a".repeat(64)) })),
    [],
  );
  assert.notDeepEqual(validateCurrentAgentRuntimeEvent(enqueued(1, { requiredBlobSha256s: ["A".repeat(64)] })), []);
  assert.notDeepEqual(
    validateCurrentAgentRuntimeEvent(claimed(2, "claim-1", "2026-11-18T00:01:00.000Z", "2026-11-18T00:00:59.000Z")),
    [],
    "a claim lease must end after it starts",
  );
});

test("authorized channel messages use the interactive person Inbox while external ingress stays quarantined", () => {
  const channelMessage = enqueued(1, {
    inboxId: "person:person_alice",
    itemId: "channel-1",
    source: "channel_message",
    sourceRef: "channel:gui:env-1",
    dedupeKey: "channel:gui:key-1",
    admission: "dispatchable",
    consumerKind: "interactive_watch",
    taskId: null,
    agentId: null,
    summary: "GUI message",
  });
  assert.deepEqual(validateCurrentAgentRuntimeEvent(channelMessage), []);
  assert.notDeepEqual(
    validateCurrentAgentRuntimeEvent(
      inboxEvent(2, "inbox_item_enqueued", {
        ...channelMessage.payload,
        admission: "quarantined_external",
        consumerKind: "quarantined_external",
      }),
    ),
    [],
  );
});

test("person Inbox supports peer envelopes without task binding and normalizes causal routing fields", () => {
  const peer = enqueued(12, {
    inboxId: "person:owner",
    itemId: "peer-request",
    source: "peer_request",
    sourceRef: "person:sender/request-1",
    dedupeKey: "peer-request-1",
    admission: "dispatchable",
    consumerKind: "interactive_watch",
    taskId: null,
    agentId: null,
    senderPersonId: "person-payload-claim",
    workId: "work-a2a",
    lane: "owner-review",
    correlationId: "corr-request-1",
    requiredBlobSha256s: ["a".repeat(64)],
  });
  assert.deepEqual(validateCurrentAgentRuntimeEvent(peer), []);
  const item = applied(null, peer);
  assert.equal(
    item.senderPersonId,
    "person-inbox",
    "the event envelope is authoritative over optional payload metadata",
  );
  assert.equal(item.taskId, null);
  assert.equal(item.agentId, null);
  assert.equal(item.workId, "work-a2a");
  assert.equal(item.lane, "owner-review");
  assert.equal(item.correlationId, "corr-request-1");
  assert.equal(item.minRevision, 12);
  assert.deepEqual(item.requiredBlobSha256s, ["a".repeat(64)]);
  assert.equal(item.consumerKind, "interactive_watch");

  const ordinary = applied(null, enqueued(13));
  assert.equal(ordinary.minRevision, 13);
  assert.deepEqual(ordinary.requiredBlobSha256s, []);
  assert.equal(ordinary.workId, null);
  assert.equal(ordinary.senderPersonId, "person-inbox");
  assert.equal(ordinary.consumerKind, "unattended_dispatch");
  assert.notDeepEqual(
    validateCurrentAgentRuntimeEvent(enqueued(14, { source: "peer_reply", admission: "dispatchable" })),
    [],
    "peer traffic must choose its interactive watch consumer explicitly",
  );
});

test("R4 gate: external ingress is admitted only as quarantined_external and never claimable", () => {
  assert.notDeepEqual(
    validateCurrentAgentRuntimeEvent(enqueued(1, { source: "external_ingress", admission: "dispatchable" })),
    [],
  );
  assert.notDeepEqual(validateCurrentAgentRuntimeEvent(enqueued(1, { admission: "quarantined_external" })), []);
  const external = enqueued(1, { source: "external_ingress", admission: "quarantined_external", dedupeKey: "hook-1" });
  assert.deepEqual(validateCurrentAgentRuntimeEvent(external), []);
  const item = applied(null, external);
  assert.equal(item.status, "quarantined_external");
  assert.deepEqual(
    reduceInboxItem(item, claimed(2, "claim-1", "2026-11-18T00:00:02.000Z", "2026-11-18T00:01:00.000Z")),
    {
      kind: "ignored",
      reason: "item_quarantined",
    },
  );
  assert.deepEqual(
    evaluateInboxConsumption(item, { currentSourceEpoch: 3, targetTerminal: false }, "2026-11-18T00:00:03.000Z"),
    {
      kind: "wait",
      reason: "quarantined",
      wakeAt: null,
    },
  );
});

test("(a) a repeated dedupeKey is idempotent: the fold ignores it, even after the item settles", () => {
  const first = applied(null, enqueued(1));
  assert.equal(first.status, "pending");
  assert.equal(first.enqueuedRevision, 1);
  // A crash-retried source command re-appends the same wakeup under a new item id.
  assert.deepEqual(reduceInboxItem(first, enqueued(2, { itemId: "item-retry" })), {
    kind: "ignored",
    reason: "duplicate_dedupe_key",
  });
  assert.deepEqual(reduceInboxItem(first, enqueued(2)), { kind: "ignored", reason: "duplicate_dedupe_key" });
  assert.deepEqual(reduceInboxItem(first, enqueued(1)), { kind: "ignored", reason: "duplicate_item_id" });
  // Even after the item settles, the same source occurrence never re-enters.
  const done = applied(
    applied(first, claimed(2, "claim-1", "2026-11-18T00:00:02.000Z", "2026-11-18T00:01:02.000Z")),
    inboxEvent(3, "inbox_item_completed", {
      inboxId: "task:task_a",
      itemId: "item-1",
      claimId: "claim-1",
      dispatchId: "dispatch_b",
      completedAt: "2026-11-18T00:00:03.000Z",
    }),
  );
  assert.equal(done.status, "completed");
  assert.deepEqual(reduceInboxItem(done, enqueued(4, { itemId: "item-late" })), {
    kind: "ignored",
    reason: "duplicate_dedupe_key",
  });
  assert.notEqual(
    inboxDedupeKey({ source: "ruling_resolved", sourceRef: "dispatch/dispatch_a", sourceEpoch: 4 }),
    rulingKey,
    "a newer source epoch is a different wakeup",
  );
});

test("(b) a superseded sourceEpoch is dropped as dropped_stale with an auditable reason", () => {
  const item = applied(null, enqueued(1));
  const verdict = evaluateInboxConsumption(
    item,
    { currentSourceEpoch: 4, targetTerminal: false },
    "2026-11-18T00:00:02.000Z",
  );
  assert.deepEqual(verdict, {
    kind: "drop_stale",
    reasonCode: "source_epoch_superseded",
    observedSourceEpoch: 4,
    claimId: null,
  });
  const dropped = applied(
    item,
    inboxEvent(2, "inbox_item_dropped_stale", {
      inboxId: "task:task_a",
      itemId: "item-1",
      claimId: null,
      reasonCode: "source_epoch_superseded",
      observedSourceEpoch: 4,
      droppedAt: "2026-11-18T00:00:02.000Z",
    }),
  );
  assert.equal(dropped.status, "dropped_stale");
  assert.equal(dropped.settlementReason, "source_epoch_superseded");
  assert.equal(dropped.observedSourceEpoch, 4);
  assert.deepEqual(
    reduceInboxItem(dropped, claimed(3, "claim-1", "2026-11-18T00:00:03.000Z", "2026-11-18T00:01:00.000Z")),
    {
      kind: "ignored",
      reason: "item_terminal",
    },
  );
  // A terminal target or a retired source is stale too; a lagging source view waits rather than drops.
  assert.equal(
    evaluateInboxConsumption(item, { currentSourceEpoch: 3, targetTerminal: true }, "2026-11-18T00:00:02.000Z").kind,
    "drop_stale",
  );
  assert.deepEqual(
    evaluateInboxConsumption(item, { currentSourceEpoch: null, targetTerminal: false }, "2026-11-18T00:00:02.000Z"),
    { kind: "drop_stale", reasonCode: "source_retired", observedSourceEpoch: null, claimId: null },
  );
  assert.deepEqual(
    evaluateInboxConsumption(item, { currentSourceEpoch: 2, targetTerminal: false }, "2026-11-18T00:00:02.000Z"),
    { kind: "wait", reason: "source_epoch_ahead", wakeAt: null },
  );
  assert.deepEqual(
    evaluateInboxConsumption(item, { currentSourceEpoch: 3, targetTerminal: false }, "2026-11-18T00:00:02.000Z"),
    { kind: "claim" },
  );
});

test("claims are fenced by lease and claim id; settlement needs the live claim", () => {
  const pending = applied(null, enqueued(1)),
    first = applied(pending, claimed(2, "claim-1", "2026-11-18T00:00:02.000Z", "2026-11-18T00:01:02.000Z"));
  assert.equal(first.status, "claimed");
  assert.equal(first.claimCount, 1);
  assert.deepEqual(
    reduceInboxItem(first, claimed(3, "claim-2", "2026-11-18T00:00:30.000Z", "2026-11-18T00:01:30.000Z")),
    {
      kind: "ignored",
      reason: "claim_active",
    },
  );
  assert.deepEqual(
    evaluateInboxConsumption(first, { currentSourceEpoch: 9, targetTerminal: true }, "2026-11-18T00:00:30.000Z"),
    { kind: "wait", reason: "claim_active", wakeAt: "2026-11-18T00:01:02.000Z" },
    "an unexpired claim is never dropped by another consumer",
  );
  // The lease expires (consumer crashed): another consumer reclaims and the old claim can no longer settle.
  const second = applied(first, claimed(3, "claim-2", "2026-11-18T00:01:02.000Z", "2026-11-18T00:02:02.000Z"));
  assert.equal(second.claimId, "claim-2");
  assert.equal(second.claimCount, 2);
  const lateCompletion = inboxEvent(4, "inbox_item_completed", {
    inboxId: "task:task_a",
    itemId: "item-1",
    claimId: "claim-1",
    dispatchId: "dispatch_old",
    completedAt: "2026-11-18T00:01:10.000Z",
  });
  assert.deepEqual(reduceInboxItem(second, lateCompletion), { kind: "ignored", reason: "claim_mismatch" });
  assert.deepEqual(reduceInboxItem(pending, lateCompletion), { kind: "ignored", reason: "item_not_claimed" });
  const failed = applied(
    second,
    inboxEvent(5, "inbox_item_failed", {
      inboxId: "task:task_a",
      itemId: "item-1",
      claimId: "claim-2",
      reasonCode: "unattended_permission_unsupported",
      failedAt: "2026-11-18T00:01:20.000Z",
    }),
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.settlementReason, "unattended_permission_unsupported");
  assert.equal(failed.leaseUntil, null);
  // An expired claim can be dropped stale only under its own claim id.
  const expired = evaluateInboxConsumption(
    second,
    { currentSourceEpoch: 4, targetTerminal: false },
    "2026-11-18T00:03:00.000Z",
  );
  assert.deepEqual(expired, {
    kind: "drop_stale",
    reasonCode: "source_epoch_superseded",
    observedSourceEpoch: 4,
    claimId: "claim-2",
  });
  assert.equal(
    reduceInboxItem(
      second,
      inboxEvent(6, "inbox_item_dropped_stale", {
        inboxId: "task:task_a",
        itemId: "item-1",
        claimId: null,
        reasonCode: "source_epoch_superseded",
        observedSourceEpoch: 4,
        droppedAt: "2026-11-18T00:03:00.000Z",
      }),
    ).kind,
    "ignored",
  );
  assert.deepEqual(reduceInboxItem(null, lateCompletion), { kind: "ignored", reason: "item_missing" });
});

test("queue cursors are numeric revisions and malformed cursors fail closed", () => {
  assert.equal(inboxQueueCursor(undefined), 0);
  assert.equal(inboxQueueCursor("42"), 42);
  assert.throws(() => inboxQueueCursor("-1"), /cursor is invalid/u);
  assert.throws(() => inboxQueueCursor("1; DROP TABLE inbox_item"), /cursor is invalid/u);
});
