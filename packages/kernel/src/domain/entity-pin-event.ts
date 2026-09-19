import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { parseEntityRef } from "./entity-ref.ts";
import {
  freezeDeclaredWritePlan,
  hasContractFields,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteSource,
} from "./write-chain.contract.ts";

export type EntityPinEventV1 = EventEnvelope<
  "entity-pin-event/v1",
  "entity_pinned" | "entity_unpinned",
  ActorIdentity,
  { readonly entityRef: string }
>;

export function compileEntityPinEvent(input: {
  readonly entityRef: string;
  readonly pinned: boolean;
  readonly eventId: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
}): { readonly event: EntityPinEventV1; readonly plan: FrozenWritePlan; readonly blobs: readonly [] } {
  const event: EntityPinEventV1 = {
    schema: "entity-pin-event/v1",
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    type: input.pinned ? "entity_pinned" : "entity_unpinned",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: { entityRef: input.entityRef },
  };
  const errors = validateCurrentEntityPinEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return {
    event,
    plan: freezeDeclaredWritePlan(
      {
        commandType: event.type,
        targets: [
          { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
          { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
          { kind: "projection_invalidation", projection: "entity-pin/v1", key: input.entityRef },
        ],
      },
      [event.type],
    ),
    blobs: [],
  };
}

export function validateEntityPinEvent(value: unknown): readonly string[] {
  return validateEntityPinEventFields(value, true);
}
export function validateCurrentEntityPinEvent(value: unknown): readonly string[] {
  return validateEntityPinEventFields(value, false);
}
function validateEntityPinEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (
    !isRecord(value) ||
    !hasContractFields(
      value,
      ["schema", "eventId", "workspaceRevision", "opId", "type", "actor", "source", "occurredAt", "payload"],
      allowUnknownFields,
    ) ||
    value.schema !== "entity-pin-event/v1" ||
    !["entity_pinned", "entity_unpinned"].includes(String(value.type)) ||
    !isRecord(value.payload) ||
    !hasContractFields(value.payload, ["entityRef"], allowUnknownFields) ||
    typeof value.payload.entityRef !== "string" ||
    parseEntityRef(value.payload.entityRef) === null
  )
    return ["entity pin event envelope or payload is invalid"];
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length
    ? ["entity pin event envelope identity is invalid"]
    : [];
}
export function isEntityPinEvent(event: { readonly schema: string }): event is EntityPinEventV1 {
  return event.schema === "entity-pin-event/v1";
}
