import type {
  InboxEvent,
  InboxEventPayloads,
  InboxEventType,
  InboxQuery,
} from "@harness-anything/kernel/internal/domain/inbox.ts";
import { canonicalEventWritePlan } from "../../src/store/task-event-store.ts";

const ACTOR = { principal: { personId: "person-inbox" }, executor: null } as const;

export function inboxEvent<T extends InboxEventType>(
  revision: number,
  type: T,
  payload: InboxEventPayloads[T],
): Extract<InboxEvent, { readonly type: T }> {
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-inbox-${String(revision).padStart(5, "0")}`,
    workspaceRevision: revision,
    opId: `op-inbox-${String(revision).padStart(5, "0")}`,
    actor: ACTOR,
    source: "local",
    occurredAt: `2026-11-18T00:00:${String(revision).padStart(2, "0")}.000Z`,
    type,
    payload,
  } as unknown as Extract<InboxEvent, { readonly type: T }>;
}

export function inboxBundle(event: InboxEvent) {
  return { event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] };
}

function enqueue(
  revision: number,
  input: {
    readonly inboxId: string;
    readonly itemId: string;
    readonly source: InboxEventPayloads["inbox_item_enqueued"]["source"];
    readonly sourceEpoch: number;
    readonly dedupeKey: string;
    readonly taskId?: string | null;
    readonly agentId?: string | null;
  },
) {
  return inboxEvent(revision, "inbox_item_enqueued", {
    inboxId: input.inboxId,
    itemId: input.itemId,
    source: input.source,
    sourceRef: `source/${input.itemId}`,
    sourceEpoch: input.sourceEpoch,
    dedupeKey: input.dedupeKey,
    admission: input.source === "external_ingress" ? "quarantined_external" : "dispatchable",
    taskId: input.taskId === undefined ? input.inboxId.slice("task:".length) : input.taskId,
    agentId: input.agentId ?? null,
    summary: `wakeup ${input.itemId}`,
    enqueuedAt: `2026-11-18T00:00:${String(revision).padStart(2, "0")}.000Z`,
  });
}

/**
 * Nine accepted events covering every transition plus an ignored duplicate. Final state:
 * pending queue [item-a2 @6, item-c1 @9]; quarantined [item-x1 @4]; item-a1 completed; item-b1 dropped_stale.
 */
export function inboxScenario(): readonly InboxEvent[] {
  return [
    enqueue(1, {
      inboxId: "task:task_a",
      itemId: "item-a1",
      source: "ruling_resolved",
      sourceEpoch: 3,
      dedupeKey: "k-a1",
    }),
    enqueue(2, { inboxId: "task:task_b", itemId: "item-b1", source: "timer_fired", sourceEpoch: 1, dedupeKey: "k-b1" }),
    enqueue(3, {
      inboxId: "task:task_a",
      itemId: "item-a1-retry",
      source: "ruling_resolved",
      sourceEpoch: 3,
      dedupeKey: "k-a1",
    }),
    enqueue(4, {
      inboxId: "agent:watcher",
      itemId: "item-x1",
      source: "external_ingress",
      sourceEpoch: 0,
      dedupeKey: "k-x1",
      taskId: null,
      agentId: "watcher",
    }),
    inboxEvent(5, "inbox_item_claimed", {
      inboxId: "task:task_a",
      itemId: "item-a1",
      claimId: "claim-a1",
      claimedAt: "2026-11-18T00:00:05.000Z",
      leaseUntil: "2026-11-18T00:01:05.000Z",
    }),
    enqueue(6, {
      inboxId: "task:task_a",
      itemId: "item-a2",
      source: "ruling_resolved",
      sourceEpoch: 4,
      dedupeKey: "k-a2",
    }),
    inboxEvent(7, "inbox_item_completed", {
      inboxId: "task:task_a",
      itemId: "item-a1",
      claimId: "claim-a1",
      dispatchId: "dispatch_a1",
      completedAt: "2026-11-18T00:00:07.000Z",
    }),
    inboxEvent(8, "inbox_item_dropped_stale", {
      inboxId: "task:task_b",
      itemId: "item-b1",
      claimId: null,
      reasonCode: "source_retired",
      observedSourceEpoch: null,
      droppedAt: "2026-11-18T00:00:08.000Z",
    }),
    enqueue(9, { inboxId: "task:task_c", itemId: "item-c1", source: "timer_fired", sourceEpoch: 2, dedupeKey: "k-c1" }),
  ];
}

/** Every read shape the host wiring consumes; backends must answer each one identically. */
export const inboxParityQueries: readonly InboxQuery[] = [
  { by: "queue", status: "pending" },
  { by: "queue", status: "pending", limit: 1 },
  { by: "queue", status: "pending", limit: 1, cursor: "6" },
  { by: "queue", status: "pending", inboxId: "task:task_a" },
  { by: "queue", status: "claimed" },
  { by: "queue", status: "quarantined_external" },
  { by: "item", inboxId: "task:task_a", itemId: "item-a1" },
  { by: "item", inboxId: "task:task_a", itemId: "item-a1-retry" },
  { by: "item", inboxId: "task:task_b", itemId: "item-b1" },
  { by: "dedupe", inboxId: "task:task_a", dedupeKey: "k-a1" },
  { by: "dedupe", inboxId: "task:task_a", dedupeKey: "k-missing" },
];
