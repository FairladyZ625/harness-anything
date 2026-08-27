import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { serializeEntityJsonSchema } from "./entity-json-schema.ts";
import { ENTITY_DOCUMENT_POLICY_ID } from "./entity-kind-registry.ts";
import type { EntityDeclarationClaim } from "./entity-event.ts";
import { timestamp } from "./timestamp.ts";
import {
  SCHEDULE_DEFINITION_V1_SCHEMA,
  scheduleDefinition,
  scheduleDeletionEventTypes,
  scheduleDefinitionEventTypes,
  scheduleEventTypes,
  scheduleMissedReasons,
  validateScheduleDefinitionV1,
  validateScheduleV1,
  type ScheduleDeletionEventType,
  type ScheduleDefinitionEventType,
  type ScheduleEventType,
  type ScheduleMissedReason,
  type ScheduleRunEventType,
  type ScheduleV1,
} from "./schedule.ts";
import {
  freezeDeclaredWritePlan,
  hasContractFields,
  isFrozenWritePlan,
  isNonEmptyString,
  isRecord,
  serializeEventEnvelope,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteSource,
  type WriteTarget,
} from "./write-chain.contract.ts";

export interface ScheduleMissedEvidenceV1 {
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly reason: ScheduleMissedReason;
}

interface ScheduleEntityIdentity {
  readonly kind: "schedule";
  readonly id: string;
}

export type ScheduleDefinitionEventV1 = EventEnvelope<
  "schedule-event/v1",
  ScheduleDefinitionEventType,
  ActorIdentity,
  { readonly schedule: ScheduleV1; readonly declarationDocumentClaim: EntityDeclarationClaim }
> & { readonly entity: ScheduleEntityIdentity };

export interface ScheduleDocumentRetirementV1 {
  readonly path: string;
  readonly baseBlobSha256: string;
}

export type ScheduleDeletedEventV1 = EventEnvelope<
  "schedule-event/v1",
  ScheduleDeletionEventType,
  ActorIdentity,
  {
    readonly schedule: ScheduleV1;
    readonly declarationDocumentRetirement: ScheduleDocumentRetirementV1;
    readonly reason?: string;
  }
> & { readonly entity: ScheduleEntityIdentity };

export type ScheduleRunEventV1 = EventEnvelope<
  "schedule-event/v1",
  ScheduleRunEventType,
  ActorIdentity,
  { readonly schedule: ScheduleV1; readonly missed?: ScheduleMissedEvidenceV1 }
> & { readonly entity: ScheduleEntityIdentity };

export type ScheduleEventV1 = ScheduleDefinitionEventV1 | ScheduleDeletedEventV1 | ScheduleRunEventV1;

export interface ScheduleDefinitionEventBundle {
  readonly event: ScheduleDefinitionEventV1;
  readonly plan: FrozenWritePlan<ScheduleDefinitionEventType>;
  readonly blobs: readonly [
    { readonly sha256: string; readonly size: number; readonly mediaType: "application/json"; readonly body: string },
  ];
}

export interface ScheduleRunEventBundle {
  readonly event: ScheduleRunEventV1;
  readonly plan: FrozenWritePlan<ScheduleRunEventType>;
  readonly blobs: readonly [];
}

export interface ScheduleDeletedEventBundle {
  readonly event: ScheduleDeletedEventV1;
  readonly plan: FrozenWritePlan<ScheduleDeletionEventType>;
  readonly blobs: readonly [];
}

interface ScheduleEventInput<T extends ScheduleEventType> {
  readonly type: T;
  readonly schedule: ScheduleV1;
  readonly eventId: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
}

export function compileScheduleDefinitionEvent(
  input: ScheduleEventInput<ScheduleDefinitionEventType>,
): ScheduleDefinitionEventBundle {
  const body = serializeEntityJsonSchema(
      SCHEDULE_DEFINITION_V1_SCHEMA,
      scheduleDefinition(input.schedule),
      "schedule definition",
    ),
    claim: EntityDeclarationClaim = {
      path: normalizeRelativeDocumentPath(`schedules/${input.schedule.scheduleId}.json`),
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: "application/json",
      policyId: ENTITY_DOCUMENT_POLICY_ID,
    },
    event: ScheduleDefinitionEventV1 = {
      schema: "schedule-event/v1",
      eventId: input.eventId,
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      entity: { kind: "schedule", id: input.schedule.scheduleId },
      type: input.type,
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: { schedule: input.schedule, declarationDocumentClaim: claim },
    };
  const errors = validateCurrentScheduleEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return {
    event,
    plan: scheduleEventWritePlan(event),
    blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body }],
  };
}

export function compileScheduleDeletedEvent(
  input: ScheduleEventInput<ScheduleDeletionEventType> & {
    readonly baseBlobSha256: string;
    readonly reason?: string;
  },
): ScheduleDeletedEventBundle {
  const retirement: ScheduleDocumentRetirementV1 = {
      path: normalizeRelativeDocumentPath(`schedules/${input.schedule.scheduleId}.json`),
      baseBlobSha256: input.baseBlobSha256,
    },
    event: ScheduleDeletedEventV1 = {
      schema: "schedule-event/v1",
      eventId: input.eventId,
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      entity: { kind: "schedule", id: input.schedule.scheduleId },
      type: input.type,
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: {
        schedule: input.schedule,
        declarationDocumentRetirement: retirement,
        ...(input.reason === undefined ? {} : { reason: input.reason.trim() }),
      },
    };
  const errors = validateCurrentScheduleEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return { event, plan: scheduleEventWritePlan(event), blobs: [] };
}

export function compileScheduleRunEvent(
  input: ScheduleEventInput<ScheduleRunEventType> & { readonly missed?: ScheduleMissedEvidenceV1 },
): ScheduleRunEventBundle {
  const event: ScheduleRunEventV1 = {
    schema: "schedule-event/v1",
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    entity: { kind: "schedule", id: input.schedule.scheduleId },
    type: input.type,
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: { schedule: input.schedule, ...(input.missed === undefined ? {} : { missed: input.missed }) },
  };
  const errors = validateCurrentScheduleEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return { event, plan: scheduleEventWritePlan(event), blobs: [] };
}

export function validateScheduleEvent(value: unknown): readonly string[] {
  return validateScheduleEventFields(value, true);
}

export function validateCurrentScheduleEvent(value: unknown): readonly string[] {
  return validateScheduleEventFields(value, false);
}

function validateScheduleEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  const envelopeFields = [
    "schema",
    "eventId",
    "workspaceRevision",
    "opId",
    "entity",
    "type",
    "actor",
    "source",
    "occurredAt",
    "payload",
  ];
  if (
    !isRecord(value) ||
    !hasContractFields(value, envelopeFields, allowUnknownFields) ||
    value.schema !== "schedule-event/v1" ||
    !scheduleEventTypes.includes(value.type as ScheduleEventType) ||
    !isRecord(value.entity) ||
    !hasContractFields(value.entity, ["kind", "id"], allowUnknownFields) ||
    value.entity.kind !== "schedule" ||
    !isNonEmptyString(value.entity.id) ||
    !isRecord(value.payload)
  )
    return ["schedule event envelope or entity identity is invalid"];
  const payload = value.payload,
    definitionEvent = scheduleDefinitionEventTypes.includes(value.type as ScheduleDefinitionEventType),
    deletionEvent = scheduleDeletionEventTypes.includes(value.type as ScheduleDeletionEventType),
    payloadFields = definitionEvent
      ? ["schedule", "declarationDocumentClaim"]
      : deletionEvent
        ? ["schedule", "declarationDocumentRetirement"]
        : ["schedule"],
    optionalPayloadFields = value.type === "schedule_occurrences_missed" ? ["missed"] : deletionEvent ? ["reason"] : [];
  if (
    !payloadFields.every((field) => Object.hasOwn(payload, field)) ||
    (!allowUnknownFields &&
      !Object.keys(payload).every((field) => payloadFields.includes(field) || optionalPayloadFields.includes(field))) ||
    validateScheduleV1(payload.schedule, allowUnknownFields).length > 0 ||
    !isRecord(payload.schedule) ||
    payload.schedule.scheduleId !== value.entity.id
  )
    return ["schedule event payload snapshot is invalid"];
  if (definitionEvent) {
    if (!validDefinitionClaim(payload.declarationDocumentClaim, value.entity.id, allowUnknownFields))
      return ["schedule definition claim is invalid"];
    if (
      (value.type === "schedule_enabled" && payload.schedule.state !== "armed") ||
      (value.type === "schedule_disabled" && payload.schedule.state !== "paused")
    )
      return ["schedule definition event state is invalid"];
  } else if (deletionEvent) {
    if (!validDeletion(payload, value.entity.id, allowUnknownFields)) return ["schedule deletion evidence is invalid"];
  } else if (!validRunEventState(value.type as ScheduleRunEventType, payload, allowUnknownFields)) {
    return ["schedule run evidence is invalid"];
  }
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length
    ? ["schedule event envelope identity is invalid"]
    : [];
}

export function isScheduleEvent(event: { readonly schema: string }): event is ScheduleEventV1 {
  return event.schema === "schedule-event/v1";
}

export function serializeScheduleEvent(event: ScheduleEventV1): string {
  const errors = validateCurrentScheduleEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return serializeEventEnvelope(event);
}

export function scheduleEventWritePlan<T extends ScheduleEventV1>(event: T): FrozenWritePlan<T["type"]> {
  const claim = isDefinitionEvent(event) ? event.payload.declarationDocumentClaim : null,
    retirement = isDeletionEvent(event) ? event.payload.declarationDocumentRetirement : null,
    targets: WriteTarget[] = [
      { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
      { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
      ...(claim === null
        ? []
        : [
            {
              kind: "authored_file" as const,
              path: claim.path,
              operation: "replace" as const,
              sha256: claim.sha256,
              size: claim.size,
              mediaType: claim.mediaType,
            },
            {
              kind: "content_blob" as const,
              sha256: claim.sha256,
              size: claim.size,
              mediaType: claim.mediaType,
            },
            { kind: "projection_invalidation" as const, projection: "document/v1", key: claim.path },
          ]),
      ...(retirement === null
        ? []
        : [
            {
              kind: "authored_file_delete" as const,
              path: retirement.path,
              operation: "delete" as const,
              baseSha256: retirement.baseBlobSha256,
            },
            { kind: "projection_invalidation" as const, projection: "document/v1", key: retirement.path },
          ]),
      {
        kind: "projection_invalidation",
        projection: "entity/v1",
        key: `schedule/${event.entity.id}`,
      },
    ];
  return freezeDeclaredWritePlan({ commandType: event.type, targets }, scheduleEventTypes);
}

export function assertScheduleEventInputs(
  event: ScheduleEventV1,
  plan: FrozenWritePlan | undefined,
  blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[],
): void {
  assertScheduleEventWritePlan(event, plan);
  if (!isDefinitionEvent(event)) {
    if (blobs.length !== 0) throw new Error("schedule deletion or run event cannot carry definition content");
    return;
  }
  const claim = event.payload.declarationDocumentClaim,
    blob = blobs.find((candidate) => candidate.sha256 === claim.sha256);
  if (!blob || blob.size !== claim.size || blob.mediaType !== claim.mediaType || sha256Text(blob.body) !== claim.sha256)
    throw new Error("schedule definition blob must be exact");
  let value: unknown;
  try {
    value = JSON.parse(blob.body);
  } catch {
    throw new Error("schedule definition blob must be JSON");
  }
  if (
    validateScheduleDefinitionV1(value).length > 0 ||
    stableStringify(value) !== stableStringify(scheduleDefinition(event.payload.schedule))
  )
    throw new Error("schedule definition blob must contain only the exact definition facet");
}

export function assertScheduleEventWritePlan(event: ScheduleEventV1, plan: FrozenWritePlan | undefined): void {
  const shape = (value: FrozenWritePlan) =>
    stableStringify({ commandType: value.commandType, targets: value.targets.map(stableStringify).sort() });
  if (!plan || !isFrozenWritePlan(plan) || shape(plan) !== shape(scheduleEventWritePlan(event)))
    throw new Error("schedule write plan must exactly declare event, definition, content, and projection targets");
}

function isDefinitionEvent(event: ScheduleEventV1): event is ScheduleDefinitionEventV1 {
  return scheduleDefinitionEventTypes.includes(event.type as ScheduleDefinitionEventType);
}

function isDeletionEvent(event: ScheduleEventV1): event is ScheduleDeletedEventV1 {
  return scheduleDeletionEventTypes.includes(event.type as ScheduleDeletionEventType);
}

function validDefinitionClaim(value: unknown, scheduleId: string, allowUnknownFields: boolean): boolean {
  return (
    isRecord(value) &&
    hasContractFields(value, ["path", "sha256", "size", "mediaType", "policyId"], allowUnknownFields) &&
    value.path === `schedules/${scheduleId}.json` &&
    /^[0-9a-f]{64}$/u.test(String(value.sha256)) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0 &&
    value.mediaType === "application/json" &&
    value.policyId === ENTITY_DOCUMENT_POLICY_ID
  );
}

function validDeletion(
  payload: Readonly<Record<string, unknown>>,
  scheduleId: string,
  allowUnknownFields: boolean,
): boolean {
  const retirement = payload.declarationDocumentRetirement;
  return (
    isRecord(retirement) &&
    hasContractFields(retirement, ["path", "baseBlobSha256"], allowUnknownFields) &&
    retirement.path === `schedules/${scheduleId}.json` &&
    /^[0-9a-f]{64}$/u.test(String(retirement.baseBlobSha256)) &&
    (payload.reason === undefined || isNonEmptyString(payload.reason))
  );
}

function validRunEventState(
  type: ScheduleRunEventType,
  payload: Readonly<Record<string, unknown>>,
  allowUnknownFields: boolean,
): boolean {
  const schedule = payload.schedule as ScheduleV1;
  if (type === "schedule_occurrence_claimed") return schedule.status.activeRun !== null;
  if (type === "schedule_occurrence_dispatched")
    return (
      schedule.status.activeRun?.dispatchId !== undefined && schedule.status.activeRun.runtimeSessionId !== undefined
    );
  if (type === "schedule_dispatch_failed")
    return schedule.status.activeRun === null && schedule.status.lastRun?.outcome === "failed";
  if (type === "schedule_run_settled") return schedule.status.activeRun === null && schedule.status.lastRun !== null;
  const missed = payload.missed;
  return (
    isRecord(missed) &&
    hasContractFields(missed, ["from", "to", "count", "reason"], allowUnknownFields) &&
    timestamp(missed.from) &&
    timestamp(missed.to) &&
    Date.parse(missed.from) <= Date.parse(missed.to) &&
    Number.isSafeInteger(missed.count) &&
    Number(missed.count) > 0 &&
    scheduleMissedReasons.includes(missed.reason as ScheduleMissedReason) &&
    schedule.status.lastMissedAt === missed.to &&
    schedule.status.lastMissedReason === missed.reason &&
    schedule.status.missedCount >= Number(missed.count) &&
    schedule.status.automaticEvaluatedThrough === missed.to
  );
}
