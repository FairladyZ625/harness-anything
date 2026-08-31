import { projectBaseEntityAtCut, requireEntityTypeContract, type BaseEntity } from "./base-entity.ts";
import {
  deriveRelationId,
  isAllowedRelationKindTriple,
  relationDirections,
  relationOrigins,
  relationStates,
  relationStrengths,
  relationTypes,
  type EntityRelationRecord,
} from "./entity-relation.ts";
import { parseEntityRef } from "./entity-ref.ts";
import type { DecisionEventV1 } from "./decision-event.ts";
import { factRef, type FactEventV1 } from "./fact-event.ts";
import type { MigrationImportEventV1 } from "./migration-import-event.ts";
import type { TaskEventV1 } from "./task-lifecycle-event.ts";
import { timestamp } from "./timestamp.ts";
import {
  freezeDeclaredWritePlan,
  hasOnlyFields,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteSource,
} from "./write-chain.contract.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";

export const relationEventTypes = ["relation_created", "relation_retired", "relation_replaced"] as const;
export type RelationEventType = (typeof relationEventTypes)[number];

type RelationCreated = EventEnvelope<
  "relation-event/v1",
  "relation_created",
  ActorIdentity,
  { readonly relation: EntityRelationRecord }
> & { readonly relationId: string };
type RelationRetired = EventEnvelope<
  "relation-event/v1",
  "relation_retired",
  ActorIdentity,
  { readonly reason: string }
> & { readonly relationId: string };
type RelationReplaced = EventEnvelope<
  "relation-event/v1",
  "relation_replaced",
  ActorIdentity,
  { readonly previousRelationId: string; readonly relation: EntityRelationRecord; readonly reason: string }
> & { readonly relationId: string };
export type RelationEventV1 = RelationCreated | RelationRetired | RelationReplaced;
export type RelationInitialEvent =
  | RelationCreated
  | Extract<MigrationImportEventV1, { readonly type: "entity_migrated" }>;

export interface RelationEntity extends BaseEntity<"relation"> {
  readonly source: string;
  readonly target: string;
  readonly type: EntityRelationRecord["type"];
  readonly strength: EntityRelationRecord["strength"];
  readonly direction: EntityRelationRecord["direction"];
  readonly origin: EntityRelationRecord["origin"];
  readonly state: EntityRelationRecord["state"];
  readonly rationale: string;
  readonly replacedBy?: string;
  readonly retirementReason?: string;
}

export function isRelationEvent(event: { readonly schema: string }): event is RelationEventV1 {
  return event.schema === "relation-event/v1";
}

export function relationRecord(entity: RelationEntity): EntityRelationRecord {
  return {
    relation_id: entity.id,
    source: entity.source,
    target: entity.target,
    type: entity.type,
    strength: entity.strength,
    direction: entity.direction,
    origin: entity.origin,
    rationale: entity.rationale,
    state: entity.state,
  };
}

export function reduceRelationEntity(
  current: RelationEntity | null,
  event: RelationEventV1 | MigrationImportEventV1,
): RelationEntity {
  const migrated = event.schema === "migration-import-event/v1" ? event.payload.entity : null;
  if (migrated !== null && migrated.kind !== "relation")
    throw new Error("Relation aggregate requires relation history");
  const relation =
    migrated?.kind === "relation"
      ? migrated.relation
      : event.schema === "relation-event/v1" &&
          (event.type === "relation_created" || event.type === "relation_replaced")
        ? event.payload.relation
        : null;
  const id = migrated?.kind === "relation" ? migrated.relation.relation_id : (event as RelationEventV1).relationId;
  if (current === null && relation === null) throw new Error(`Relation ${id} has no initial history event`);
  if (current !== null && current.id !== id) throw new Error("Relation aggregate identity cannot change");
  if (current !== null && event.schema === "relation-event/v1" && event.type === "relation_created")
    throw new Error(`Relation ${id} already exists`);

  const base = projectBaseEntityAtCut(
    requireEntityTypeContract("relation"),
    {
      kind: "relation",
      id,
      workspaceRevision: event.workspaceRevision,
      occurredAt: event.occurredAt,
      actor: event.actor,
      source: event.source,
      pinned: false,
      disposition: "active",
    },
    current,
  );
  if (event.schema === "relation-event/v1" && event.type === "relation_retired") {
    if (current === null) throw new Error(`Relation ${id} does not exist`);
    return Object.freeze({ ...current, ...base, state: "edge_retired", retirementReason: event.payload.reason });
  }
  if (relation === null) throw new Error(`Relation ${id} has no facet payload`);
  assertRelationRecord(relation);
  return Object.freeze({
    ...base,
    source: relation.source,
    target: relation.target,
    type: relation.type,
    strength: relation.strength,
    direction: relation.direction,
    origin: relation.origin,
    state: relation.state,
    rationale: relation.rationale,
    ...(event.schema === "relation-event/v1" && event.type === "relation_replaced"
      ? { retirementReason: event.payload.reason }
      : {}),
  });
}

export function validateRelationEvent(value: unknown): readonly string[] {
  return validateRelationEventFields(value, true);
}
export function validateCurrentRelationEvent(value: unknown): readonly string[] {
  return validateRelationEventFields(value, false);
}
function validateRelationEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (
    !isRecord(value) ||
    !(allowUnknownFields
      ? [
          "schema",
          "eventId",
          "workspaceRevision",
          "opId",
          "relationId",
          "type",
          "actor",
          "source",
          "occurredAt",
          "payload",
        ].every((field) => Object.hasOwn(value, field))
      : hasOnlyFields(value, [
          "schema",
          "eventId",
          "workspaceRevision",
          "opId",
          "relationId",
          "type",
          "actor",
          "source",
          "occurredAt",
          "payload",
        ])) ||
    value.schema !== "relation-event/v1" ||
    !relationEventTypes.includes(value.type as RelationEventType) ||
    typeof value.relationId !== "string" ||
    !/^rel_[0-9a-f]{16}$/u.test(value.relationId) ||
    !timestamp(value.occurredAt) ||
    validateEventEnvelopeIdentity(value, allowUnknownFields).length > 0 ||
    !isRecord(value.payload)
  )
    return ["relation event envelope is invalid"];
  if (value.type === "relation_retired")
    return hasTextPayload(value.payload, ["reason"], allowUnknownFields)
      ? []
      : ["relation retirement payload is invalid"];
  if (value.type === "relation_created") {
    if (!payloadFields(value.payload, ["relation"], allowUnknownFields) || !isRecord(value.payload.relation))
      return ["relation creation payload is invalid"];
    try {
      assertRelationRecord(value.payload.relation as unknown as EntityRelationRecord);
      return value.payload.relation.relation_id === value.relationId ? [] : ["relation event identity is inconsistent"];
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  }
  if (
    !payloadFields(value.payload, ["previousRelationId", "relation", "reason"], allowUnknownFields) ||
    typeof value.payload.previousRelationId !== "string" ||
    typeof value.payload.reason !== "string" ||
    !value.payload.reason.trim() ||
    !isRecord(value.payload.relation)
  )
    return ["relation replacement payload is invalid"];
  try {
    assertRelationRecord(value.payload.relation as unknown as EntityRelationRecord);
    return value.payload.relation.relation_id === value.relationId
      ? []
      : ["relation replacement identity is inconsistent"];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function relationEventWritePlan(event: RelationEventV1): FrozenWritePlan {
  return freezeDeclaredWritePlan(
    {
      commandType: event.type,
      targets: [
        { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        { kind: "projection_invalidation", projection: "relation/v1", key: event.relationId },
      ],
    },
    relationEventTypes,
  );
}

export function assertRelationEventWritePlan(event: RelationEventV1, plan: FrozenWritePlan | undefined): void {
  const expected = relationEventWritePlan(event);
  if (!plan || JSON.stringify(plan) !== JSON.stringify(expected))
    throw new Error("relation event requires its exact aggregate projection write plan");
}

export function compileRelationCreatedEvent(input: {
  readonly record: EntityRelationRecord;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly opId: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
}): RelationCreated {
  assertRelationRecord(input.record);
  return {
    schema: "relation-event/v1",
    eventId: `event-${input.opId}`,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    relationId: input.record.relation_id,
    type: "relation_created",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: { relation: input.record },
  };
}

export function compileRelationRetiredEvent(input: {
  readonly relationId: string;
  readonly reason: string;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly opId: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
}): RelationRetired {
  const event: RelationRetired = {
    schema: "relation-event/v1",
    eventId: `event-${input.opId}`,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    relationId: input.relationId,
    type: "relation_retired",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: { reason: input.reason },
  };
  const issues = validateCurrentRelationEvent(event);
  if (issues.length) throw new Error(issues.join("; "));
  return event;
}

/** Historical Decision and Fact envelopes embedded relation mutations before
 * Relation became its own aggregate. They remain replay inputs only: callers
 * project these derived events but never persist or expose them as writes. */
export function embeddedRelationEventsForReplay(
  event: DecisionEventV1 | FactEventV1 | TaskEventV1,
): readonly RelationEventV1[] {
  if (event.schema === "fact-event/v1") return factRelationEventsForReplay(event);
  if (event.schema === "task-event/v1") return taskRelationEventsForReplay(event);
  if (event.type === "decision_proposed")
    return event.payload.relations.map((record) => replayCreatedEvent(event, record));
  if (event.type === "decision_related") return [replayCreatedEvent(event, event.payload.relation)];
  if (event.type === "decision_relation_retired")
    return [
      compileRelationRetiredEvent({
        relationId: event.payload.relationId,
        reason: event.payload.reason,
        actor: event.actor,
        source: event.source,
        opId: event.opId,
        occurredAt: event.occurredAt,
        workspaceRevision: event.workspaceRevision,
      }),
    ];
  if (event.type !== "decision_relation_replaced") return [];
  return [
    compileRelationRetiredEvent({
      relationId: event.payload.relationId,
      reason: event.payload.reason,
      actor: event.actor,
      source: event.source,
      opId: event.opId,
      occurredAt: event.occurredAt,
      workspaceRevision: event.workspaceRevision,
    }),
    {
      schema: "relation-event/v1",
      eventId: event.eventId,
      workspaceRevision: event.workspaceRevision,
      opId: event.opId,
      relationId: event.payload.replacement.relation_id,
      type: "relation_replaced",
      actor: event.actor,
      source: event.source,
      occurredAt: event.occurredAt,
      payload: {
        previousRelationId: event.payload.relationId,
        relation: event.payload.replacement,
        reason: event.payload.reason,
      },
    },
  ];
}

function taskRelationEventsForReplay(event: TaskEventV1): readonly RelationEventV1[] {
  if (event.type !== "task_created" && event.type !== "task_relation_added") return [];
  const task = event.payload.task as typeof event.payload.task & {
      readonly relations?: readonly EntityRelationRecord[];
    },
    relationIds = event.type === "task_relation_added" ? new Set(event.payload.mutation.fields) : null;
  return (task.relations ?? [])
    .filter((record) => relationIds === null || relationIds.has(record.relation_id))
    .map((record) => replayCreatedEvent(event, record));
}

function factRelationEventsForReplay(event: FactEventV1): readonly RelationEventV1[] {
  const ownRef = factRef(event.factId),
    records: EntityRelationRecord[] = [];
  if (event.payload.supersedes) {
    const identity = {
      source: ownRef,
      target: event.payload.supersedes.factRef,
      type: "supersedes-fact" as const,
      direction: "directed" as const,
    };
    records.push({
      relation_id: deriveRelationId(identity),
      ...identity,
      strength: "strong",
      origin: "declared",
      state: "active",
      rationale: event.payload.supersedes.rationale,
    });
  }
  if (event.taskId) {
    const identity = {
      source: `task/${event.taskId}`,
      target: ownRef,
      type: "produces" as const,
      direction: "directed" as const,
    };
    records.push({
      relation_id: deriveRelationId(identity),
      ...identity,
      strength: "strong",
      origin: "generated",
      state: "active",
      rationale: "Fact recorded with an explicit task owner.",
    });
  }
  return records.map((record) => replayCreatedEvent(event, record));
}

function replayCreatedEvent(
  event: DecisionEventV1 | FactEventV1 | TaskEventV1,
  record: EntityRelationRecord,
): RelationEventV1 {
  return compileRelationCreatedEvent({
    record,
    actor: event.actor,
    source: event.source,
    opId: event.opId,
    occurredAt: event.occurredAt,
    workspaceRevision: event.workspaceRevision,
  });
}

export function assertRelationRecord(record: EntityRelationRecord): void {
  const source = parseEntityRef(record.source),
    target = parseEntityRef(record.target);
  if (!source || source.externalHarness || !target || target.externalHarness)
    throw new Error("Relation endpoints must be canonical registered Entity refs");
  if (!isAllowedRelationKindTriple(source.kind, record.type, target.kind))
    throw new Error(`Relation type ${record.type} is not writable for ${source.kind}->${target.kind}`);
  if (
    record.relation_id !== deriveRelationId(record) ||
    !relationTypes.includes(record.type) ||
    !relationStrengths.includes(record.strength) ||
    !relationDirections.includes(record.direction) ||
    !relationOrigins.includes(record.origin) ||
    !relationStates.includes(record.state) ||
    !record.rationale.trim()
  )
    throw new Error("Relation facet is invalid or inconsistent with its deterministic identity");
}

function payloadFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  allowUnknown: boolean,
): boolean {
  return allowUnknown ? fields.every((field) => Object.hasOwn(value, field)) : hasOnlyFields(value, fields);
}
function hasTextPayload(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  allowUnknown: boolean,
): boolean {
  return (
    payloadFields(value, fields, allowUnknown) &&
    fields.every((field) => typeof value[field] === "string" && value[field].trim())
  );
}
