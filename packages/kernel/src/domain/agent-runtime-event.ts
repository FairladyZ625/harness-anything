import type { AgentRuntimeEventV1 } from "./agent-runtime.ts";
import type { InboxEventPayloads } from "./inbox.ts";
import type { ActorIdentity } from "./write-chain.contract.ts";

/** Runtime ingestion and migration share this aggregate event constructor. */
export function createAgentRuntimeEvent(
  input: Omit<AgentRuntimeEventV1, "schema" | "payload"> & { readonly payload: Readonly<Record<string, unknown>> },
): AgentRuntimeEventV1 {
  return { ...input, schema: "agent-runtime-event/v1", type: input.type } as AgentRuntimeEventV1;
}

/** Construct a canonical `inbox_item_enqueued` event inside the declared runtime-session aggregate owner. */
export function compileInboxEnqueuedEvent(input: {
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly opId: string;
  readonly actor: ActorIdentity;
  readonly source: AgentRuntimeEventV1["source"];
  readonly occurredAt: string;
  readonly payload: InboxEventPayloads["inbox_item_enqueued"];
}): Extract<AgentRuntimeEventV1, { readonly type: "inbox_item_enqueued" }> {
  return {
    schema: "agent-runtime-event/v1",
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    type: "inbox_item_enqueued",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: input.payload,
  };
}

/** Construct a canonical `inbox_item_claimed` event inside the declared runtime-session aggregate owner. */
export function compileInboxClaimedEvent(input: {
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly opId: string;
  readonly actor: ActorIdentity;
  readonly source: AgentRuntimeEventV1["source"];
  readonly occurredAt: string;
  readonly payload: InboxEventPayloads["inbox_item_claimed"];
}): Extract<AgentRuntimeEventV1, { readonly type: "inbox_item_claimed" }> {
  return {
    schema: "agent-runtime-event/v1",
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    type: "inbox_item_claimed",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: input.payload,
  };
}

/** Construct a canonical `inbox_item_completed` event inside the declared runtime-session aggregate owner. */
export function compileInboxCompletedEvent(input: {
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly opId: string;
  readonly actor: ActorIdentity;
  readonly source: AgentRuntimeEventV1["source"];
  readonly occurredAt: string;
  readonly payload: InboxEventPayloads["inbox_item_completed"];
}): Extract<AgentRuntimeEventV1, { readonly type: "inbox_item_completed" }> {
  return {
    schema: "agent-runtime-event/v1",
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    type: "inbox_item_completed",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: input.payload,
  };
}

/** Construct a canonical `inbox_item_failed` event inside the declared runtime-session aggregate owner. */
export function compileInboxFailedEvent(input: {
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly opId: string;
  readonly actor: ActorIdentity;
  readonly source: AgentRuntimeEventV1["source"];
  readonly occurredAt: string;
  readonly payload: InboxEventPayloads["inbox_item_failed"];
}): Extract<AgentRuntimeEventV1, { readonly type: "inbox_item_failed" }> {
  return {
    schema: "agent-runtime-event/v1",
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    type: "inbox_item_failed",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: input.payload,
  };
}
