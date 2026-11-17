// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { validateCurrentAgentRuntimeEvent, type AgentRuntimeEventV1 } from "../src/domain/agent-runtime.ts";
import {
  evaluateRuntimeInboxBatch,
  reduceRuntimeInbox,
  resolveSessionContinuationMode,
  type RuntimeInboxInput,
} from "../src/domain/index.ts";

const ACTOR = { principal: { personId: "person-inbox" }, executor: null } as const;

function inboxEvent<T extends RuntimeInboxInput["type"]>(
  revision: number,
  type: T,
  payload: Extract<AgentRuntimeEventV1, { readonly type: T }>["payload"],
): Extract<RuntimeInboxInput, { readonly type: T }> {
  const event = {
    schema: "agent-runtime-event/v1",
    eventId: `event-inbox-${revision}`,
    workspaceRevision: revision,
    opId: `op-inbox-${revision}`,
    actor: ACTOR,
    source: "local" as const,
    occurredAt: `2026-11-17T00:00:${String(revision).padStart(2, "0")}.000Z`,
    type,
    payload,
  } as Extract<RuntimeInboxInput, { readonly type: T }>;
  assert.deepEqual(validateCurrentAgentRuntimeEvent(event), []);
  return event;
}

test("reduceRuntimeInbox enforces dedupeKey idempotency, monotonic claimFence, and settlements", () => {
  const e1 = inboxEvent(1, "runtime_inbox_enqueued", {
      inboxId: "task:task-1",
      itemId: "item-1",
      source: "ruling_resolved",
      dedupeKey: "ruling:dispatch_a",
      coalesceWindowMs: 1000,
      midRunPolicy: "defer_next_run",
      taskId: "task-1",
      dispatchId: "dispatch_000000000000000000000001",
      squadRunId: null,
      agentId: "terra",
      summary: "Answer 1",
      data: { answer: "yes" },
      contextRef: null,
      enqueuedAt: "2026-11-17T00:00:01.000Z",
    }),
    dup = inboxEvent(2, "runtime_inbox_enqueued", {
      ...e1.payload,
      itemId: "item-2",
    });

  const s1 = reduceRuntimeInbox(null, e1);
  assert.equal(s1.kind, "applied");
  if (s1.kind !== "applied") return;

  assert.deepEqual(reduceRuntimeInbox(s1.group, dup), { kind: "ignored", reason: "duplicate_dedupe_key" });

  const c1 = inboxEvent(3, "runtime_inbox_claimed", {
      inboxId: "task:task-1",
      itemIds: ["item-1"],
      claimFence: 1,
      claimedByDispatchId: null,
      claimedAt: "2026-11-17T00:00:03.000Z",
      leaseUntil: "2026-11-17T00:01:03.000Z",
    }),
    s2 = reduceRuntimeInbox(s1.group, c1);
  assert.equal(s2.kind, "applied");
  if (s2.kind !== "applied") return;

  assert.deepEqual(
    reduceRuntimeInbox(
      s2.group,
      inboxEvent(4, "runtime_inbox_claimed", {
        ...c1.payload,
        claimFence: 1,
        claimedAt: "2026-11-17T00:02:00.000Z",
        leaseUntil: "2026-11-17T00:03:00.000Z",
      }),
    ),
    { kind: "ignored", reason: "stale_claim_fence" },
  );

  assert.deepEqual(
    reduceRuntimeInbox(
      s2.group,
      inboxEvent(4, "runtime_inbox_claimed", {
        ...c1.payload,
        claimFence: 2,
        claimedAt: "2026-11-17T00:00:30.000Z",
        leaseUntil: "2026-11-17T00:01:30.000Z",
      }),
    ),
    { kind: "ignored", reason: "active_claim_unexpired" },
  );

  const rel = reduceRuntimeInbox(
    s2.group,
    inboxEvent(5, "runtime_inbox_settled", {
      inboxId: "task:task-1",
      itemIds: ["item-1"],
      claimFence: 1,
      settlement: "released",
      settledByDispatchId: null,
      reason: "task_blocked",
      settledAt: "2026-11-17T00:00:05.000Z",
    }),
  );
  assert.equal(rel.kind, "applied");
  if (rel.kind !== "applied") return;
  assert.equal(rel.group.activeClaim, null);
  assert.equal(rel.group.items[0]?.status, "pending");

  const c2 = reduceRuntimeInbox(
    rel.group,
    inboxEvent(6, "runtime_inbox_claimed", {
      inboxId: "task:task-1",
      itemIds: ["item-1"],
      claimFence: 2,
      claimedByDispatchId: null,
      claimedAt: "2026-11-17T00:00:06.000Z",
      leaseUntil: "2026-11-17T00:01:06.000Z",
    }),
  );
  assert.equal(c2.kind, "applied");
  if (c2.kind !== "applied") return;

  const done = reduceRuntimeInbox(
    c2.group,
    inboxEvent(7, "runtime_inbox_settled", {
      inboxId: "task:task-1",
      itemIds: ["item-1"],
      claimFence: 2,
      settlement: "consumed",
      settledByDispatchId: "dispatch_000000000000000000000002",
      reason: "resumed_provider_session",
      settledAt: "2026-11-17T00:00:07.000Z",
    }),
  );
  assert.equal(done.kind, "applied");
  if (done.kind !== "applied") return;
  assert.equal(done.group.items[0]?.status, "consumed");
  assert.equal(done.group.activeClaim, null);
});

test("evaluateRuntimeInboxBatch enforces midRunPolicy, proven_stopped, coalesce window, and lease expiry", () => {
  const s1 = reduceRuntimeInbox(
    null,
    inboxEvent(1, "runtime_inbox_enqueued", {
      inboxId: "task:task-2",
      itemId: "item-1",
      source: "timer_fired",
      dedupeKey: "timer:1",
      coalesceWindowMs: 5000,
      midRunPolicy: "defer_next_run",
      taskId: "task-2",
      dispatchId: null,
      squadRunId: null,
      agentId: null,
      summary: "Timer wakeup",
      data: {},
      enqueuedAt: "2026-11-17T00:00:00.000Z",
    }),
  );
  assert.equal(s1.kind, "applied");
  if (s1.kind !== "applied") return;

  assert.deepEqual(
    evaluateRuntimeInboxBatch(s1.group, {
      now: "2026-11-17T00:00:02.000Z",
      hasRunningAttempt: true,
      priorStopProof: "proven_stopped",
    }),
    { ready: false, reason: "deferred_mid_run", wakeAt: null },
  );

  assert.deepEqual(
    evaluateRuntimeInboxBatch(s1.group, {
      now: "2026-11-17T00:00:02.000Z",
      hasRunningAttempt: false,
      priorStopProof: "unproven",
    }),
    { ready: false, reason: "awaiting_proven_stopped", wakeAt: null },
  );

  assert.deepEqual(
    evaluateRuntimeInboxBatch(s1.group, {
      now: "2026-11-17T00:00:02.000Z",
      hasRunningAttempt: false,
      priorStopProof: "proven_stopped",
    }),
    { ready: false, reason: "coalescing", wakeAt: "2026-11-17T00:00:05.000Z" },
  );

  const ready = evaluateRuntimeInboxBatch(s1.group, {
    now: "2026-11-17T00:00:05.000Z",
    hasRunningAttempt: false,
    priorStopProof: "proven_stopped",
  });
  assert.equal(ready.ready, true);
  if (ready.ready) assert.equal(ready.nextClaimFence, 1);
});

test("resolveSessionContinuationMode enforces (employeeId, taskId, dispatchLineage) continuation rules", () => {
  const base = {
    requestedAgentId: "terra",
    previousAgentId: "terra",
    taskId: "task-1",
    previousTaskId: "task-1",
    lineageMatches: true,
    providerSessionId: "prov-1",
    runtimeSupportsResume: true,
    previousTerminalKind: "awaiting_ruling" as const,
    hasHandoffPacket: false,
  };
  assert.deepEqual(resolveSessionContinuationMode(base), {
    mode: "continue",
    allowProviderResume: true,
    blockedWithoutHandoff: false,
    reason: "same_employee_clean_continuation",
  });

  assert.deepEqual(resolveSessionContinuationMode({ ...base, requestedAgentId: "hydrogen" }), {
    mode: "handoff",
    allowProviderResume: false,
    blockedWithoutHandoff: true,
    reason: "employee_switched_requires_handoff_packet",
  });

  assert.deepEqual(resolveSessionContinuationMode({ ...base, requestedAgentId: "hydrogen", hasHandoffPacket: true }), {
    mode: "handoff",
    allowProviderResume: false,
    blockedWithoutHandoff: false,
    reason: "employee_switched_with_handoff",
  });

  assert.deepEqual(resolveSessionContinuationMode({ ...base, requestedAgentId: null }), {
    mode: "handoff",
    allowProviderResume: false,
    blockedWithoutHandoff: true,
    reason: "employee_switched_requires_handoff_packet",
  });

  assert.deepEqual(resolveSessionContinuationMode({ ...base, previousAgentId: null, requestedAgentId: "hydrogen" }), {
    mode: "handoff",
    allowProviderResume: false,
    blockedWithoutHandoff: true,
    reason: "employee_switched_requires_handoff_packet",
  });

  assert.deepEqual(resolveSessionContinuationMode({ ...base, previousAgentId: null, requestedAgentId: null }), {
    mode: "continue",
    allowProviderResume: true,
    blockedWithoutHandoff: false,
    reason: "same_employee_clean_continuation",
  });

  for (const terminal of ["cancelled", "stalled", "unreachable"] as const)
    assert.deepEqual(resolveSessionContinuationMode({ ...base, previousTerminalKind: terminal }), {
      mode: "fresh",
      allowProviderResume: false,
      blockedWithoutHandoff: false,
      reason: "unclean_prior_terminal",
    });

  const degraded = {
    schema: "agent-runtime-event/v1",
    eventId: "event-degraded-1",
    workspaceRevision: 10,
    opId: "op-degraded-1",
    actor: ACTOR,
    source: "local" as const,
    occurredAt: "2026-11-17T00:00:10.000Z",
    type: "runtime_session_resume_degraded" as const,
    payload: {
      runtimeSessionId: "runtime_a",
      dispatchId: "dispatch_000000000000000000000001",
      sourceDispatchId: null,
      providerSessionId: "prov-1",
      taskId: "task-1",
      agentId: "terra",
      degradedTo: "fresh" as const,
      reasonCode: "unclean_prior_terminal",
      reason: "Cancelled prior session started fresh.",
      observedAt: "2026-11-17T00:00:10.000Z",
    },
  };
  assert.deepEqual(validateCurrentAgentRuntimeEvent(degraded), []);
});
