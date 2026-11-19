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

/** Lifecycle events retire pins for all viewers before the entity can be pinned again. */
export const pinRetirementEventTypes = [
  "decision_accepted",
  "decision_rejected",
  "decision_retired",
  "decision_superseded",
  "entity_deleted",
  "schedule_deleted",
  "task_archived",
  "task_completed",
  "task_deleted",
  "task_superseded",
] as const;

/** Fold a single person's events in reverse revision order. A machine event without a
 * principal lives outside every personal pin set and cannot undo a person's pin. */
export function personalPinsFromNewest(
  events: Iterable<{
    readonly personId: string | null;
    readonly entityRef: string;
    readonly pinnedAt: string;
    readonly pinned: boolean;
  }>,
  personId: string,
): readonly { readonly entityRef: string; readonly pinnedAt: string; readonly pinnedBy: string }[] {
  const seen = new Set<string>();
  const pins: { entityRef: string; pinnedAt: string; pinnedBy: string }[] = [];
  for (const event of events) {
    if (event.personId !== personId || seen.has(event.entityRef)) continue;
    seen.add(event.entityRef);
    if (event.pinned) pins.push({ entityRef: event.entityRef, pinnedAt: event.pinnedAt, pinnedBy: personId });
  }
  return pins.sort(
    (left, right) => right.pinnedAt.localeCompare(left.pinnedAt) || left.entityRef.localeCompare(right.entityRef),
  );
}

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
  return validateEntityPinEventFields(pinEventValidationInput(value), true);
}

function pinEventValidationInput(value: unknown): unknown {
  // Validate the envelope of machine-written history without attributing the event to a member.
  if (
    isRecord(value) &&
    isRecord(value.actor) &&
    isRecord(value.actor.principal) &&
    !Object.hasOwn(value.actor.principal, "personId")
  )
    return {
      ...value,
      actor: { ...value.actor, principal: { ...value.actor.principal, personId: "historical-pin-validation" } },
    };
  return value;
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
