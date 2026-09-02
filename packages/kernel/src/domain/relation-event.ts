import { projectBaseEntityAtCut, requireEntityTypeContract, type BaseEntity } from "./base-entity.ts";
import {
  assertGovernedRelationRecord,
  deriveRelationId,
  isAllowedRelationKindTriple,
  relationStrengthForType,
  relationDirections,
  relationOrigins,
  relationStates,
  relationStrengths,
  relationTypes,
  type EntityRelationRecord,
  type GovernedRelationRegistryWitness,
} from "./entity-relation.ts";
import type { EntityVersion } from "./entity-freshness.ts";
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

export const relationEventTypes = [
  "relation_created",
  "relation_retired",
  "relation_replaced",
  "relation_reconfirmed",
] as const;
export type RelationEventType = (typeof relationEventTypes)[number];

export type RelationEventRecord = Omit<EntityRelationRecord, "strength"> & {
  readonly targetObservedVersion: EntityVersion | null;
};

type RelationCreated = EventEnvelope<
  "relation-event/v1",
  "relation_created",
  ActorIdentity,
  { readonly relation: RelationEventRecord }
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
  { readonly previousRelationId: string; readonly relation: RelationEventRecord; readonly reason: string }
> & { readonly relationId: string };
type RelationReconfirmed = EventEnvelope<
  "relation-event/v1",
  "relation_reconfirmed",
  ActorIdentity,
  {
    readonly priorTargetVersion: EntityVersion | null;
    readonly targetObservedVersion: EntityVersion;
    readonly rationale: string;
  }
> & { readonly relationId: string };
export type RelationEventV1 = RelationCreated | RelationRetired | RelationReplaced | RelationReconfirmed;
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
  readonly targetObservedVersion: EntityVersion | null;
  readonly replacedBy?: string;
  readonly retirementReason?: string;
  readonly reconfirmationRationale?: string;
}

export function isRelationEvent(event: { readonly schema: string }): event is RelationEventV1 {
  return event.schema === "relation-event/v1";
}

export function relationRecord(entity: RelationEntity): EntityRelationRecord & {
  readonly targetObservedVersion: EntityVersion | null;
} {
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
    targetObservedVersion: entity.targetObservedVersion,
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
      ? eventRecord(migrated.relation)
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
    return Object.freeze({ ...current, ...base, state: "retired", retirementReason: event.payload.reason });
  }
  if (event.schema === "relation-event/v1" && event.type === "relation_reconfirmed") {
    if (current === null) throw new Error(`Relation ${id} does not exist`);
    if (current.targetObservedVersion !== event.payload.priorTargetVersion)
      throw new Error(`Relation ${id} reconfirmation prior target version does not match its history`);
    return Object.freeze({
      ...current,
      ...base,
      targetObservedVersion: event.payload.targetObservedVersion,
      reconfirmationRationale: event.payload.rationale,
    });
  }
  if (relation === null) throw new Error(`Relation ${id} has no facet payload`);
  assertRelationEventRecord(relation, false, migrated?.kind === "relation" ? migrated.registry : undefined);
  return Object.freeze({
    ...base,
    source: relation.source,
    target: relation.target,
    type: relation.type,
    strength: relationStrengthForType(relation.type),
    direction: relation.direction,
    origin: relation.origin,
    state: relation.state,
    rationale: relation.rationale,
    targetObservedVersion: relation.targetObservedVersion ?? null,
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
  if (value.type === "relation_reconfirmed")
    return validReconfirmationPayload(value.payload, allowUnknownFields)
      ? []
      : ["relation reconfirmation payload is invalid"];
  if (value.type === "relation_created") {
    if (!payloadFields(value.payload, ["relation"], allowUnknownFields) || !isRecord(value.payload.relation))
      return ["relation creation payload is invalid"];
    try {
      assertRelationEventRecord(value.payload.relation, allowUnknownFields);
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
    assertRelationEventRecord(value.payload.relation, allowUnknownFields);
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
  readonly record: RelationEventRecord;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly opId: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
}): RelationCreated {
  assertRelationEventRecord(input.record);
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

export function compileRelationReconfirmedEvent(input: {
  readonly relationId: string;
  readonly priorTargetVersion: EntityVersion | null;
  readonly targetObservedVersion: EntityVersion;
  readonly rationale: string;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly opId: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
}): RelationReconfirmed {
  const event: RelationReconfirmed = {
    schema: "relation-event/v1",
    eventId: `event-${input.opId}`,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    relationId: input.relationId,
    type: "relation_reconfirmed",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: {
      priorTargetVersion: input.priorTargetVersion,
      targetObservedVersion: input.targetObservedVersion,
      rationale: input.rationale,
    },
  };
  const issues = validateCurrentRelationEvent(event);
  if (issues.length) throw new Error(issues.join("; "));
  return event;
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
        relation: eventRecord(event.payload.replacement),
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
    record: eventRecord(record),
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
    record.strength !== relationStrengthForType(record.type) ||
    !relationDirections.includes(record.direction) ||
    !relationOrigins.includes(record.origin) ||
    !relationStates.includes(record.state) ||
    !record.rationale.trim()
  )
    throw new Error("Relation facet is invalid or inconsistent with its deterministic identity");
}

function assertRelationEventRecord(
  record: unknown,
  allowHistoricalFields = false,
  registry?: GovernedRelationRegistryWitness,
): asserts record is RelationEventRecord {
  if (!isRecord(record)) throw new Error("Relation facet is invalid or inconsistent with its deterministic identity");
  const fields = [
    "relation_id",
    "source",
    "target",
    "type",
    "direction",
    "origin",
    "rationale",
    "state",
    "targetObservedVersion",
  ];
  const historicalFields = fields.filter((field) => field !== "targetObservedVersion");
  if (
    !(allowHistoricalFields
      ? historicalFields.every((field) => Object.hasOwn(record, field))
      : hasOnlyFields(record, fields))
  )
    throw new Error("Relation facet fields are invalid");
  const targetObservedVersion = record.targetObservedVersion;
  if (registry)
    assertGovernedRelationRecord(
      {
        ...(record as unknown as EntityRelationRecord),
        strength: relationStrengthForType(record.type as EntityRelationRecord["type"]),
      },
      registry,
    );
  else {
    const source = parseEntityRef(String(record.source)),
      target = parseEntityRef(String(record.target));
    if (!source || source.externalHarness || !target || target.externalHarness)
      throw new Error("Relation endpoints must be canonical registered Entity refs");
    if (!isAllowedRelationKindTriple(source.kind, record.type as EntityRelationRecord["type"], target.kind))
      throw new Error(`Relation type ${String(record.type)} is not writable for ${source.kind}->${target.kind}`);
  }
  if (
    record.relation_id !== deriveRelationId(record as unknown as EntityRelationRecord) ||
    !relationTypes.includes(record.type as EntityRelationRecord["type"]) ||
    !relationDirections.includes(record.direction as EntityRelationRecord["direction"]) ||
    !relationOrigins.includes(record.origin as EntityRelationRecord["origin"]) ||
    !relationStates.includes(record.state as EntityRelationRecord["state"]) ||
    (targetObservedVersion !== undefined &&
      targetObservedVersion !== null &&
      typeof targetObservedVersion !== "string" &&
      !Number.isSafeInteger(targetObservedVersion)) ||
    typeof record.rationale !== "string" ||
    !record.rationale.trim()
  )
    throw new Error("Relation facet is invalid or inconsistent with its deterministic identity");
}

function eventRecord(record: EntityRelationRecord): RelationEventRecord {
  return {
    relation_id: record.relation_id,
    source: record.source,
    target: record.target,
    type: record.type,
    direction: record.direction,
    origin: record.origin,
    rationale: record.rationale,
    state: record.state,
    targetObservedVersion:
      "targetObservedVersion" in record
        ? ((record as EntityRelationRecord & { readonly targetObservedVersion: EntityVersion | null })
            .targetObservedVersion ?? null)
        : null,
  };
}

function validReconfirmationPayload(payload: Readonly<Record<string, unknown>>, allowUnknownFields: boolean): boolean {
  const fields = ["priorTargetVersion", "targetObservedVersion", "rationale"],
    validVersion = (value: unknown): boolean => typeof value === "string" || Number.isSafeInteger(value);
  return (
    payloadFields(payload, fields, allowUnknownFields) &&
    (payload.priorTargetVersion === null || validVersion(payload.priorTargetVersion)) &&
    validVersion(payload.targetObservedVersion) &&
    typeof payload.rationale === "string" &&
    Boolean(payload.rationale.trim())
  );
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
