import type { EntityDocumentJsonSchema, EntityJsonObjectSchema } from "./entity-json-schema.ts";
import { validateEntityJsonSchema } from "./entity-json-schema.ts";
import { ENTITY_ID_PATTERN } from "./entity-ref.ts";
import { validateActorIdentity, type ActorIdentity } from "./actor-identity.ts";
import { timestamp } from "./timestamp.ts";
import { hasContractFields, isNonEmptyString, isRecord } from "./write-chain.contract.ts";

export const scheduleStates = ["armed", "paused"] as const;
export const scheduleMissedReasons = ["scheduler_unavailable", "single_flight"] as const;
export const scheduleRunOutcomes = ["succeeded", "failed", "unknown", "cancelled"] as const;
export const scheduleDefinitionEventTypes = [
  "schedule_created",
  "schedule_updated",
  "schedule_enabled",
  "schedule_disabled",
] as const;
export const scheduleDeletionEventTypes = ["schedule_deleted"] as const;
export const scheduleRunEventTypes = [
  "schedule_occurrence_claimed",
  "schedule_occurrence_dispatched",
  "schedule_occurrences_missed",
  "schedule_dispatch_failed",
  "schedule_run_settled",
] as const;
export const scheduleEventTypes = [
  ...scheduleDefinitionEventTypes,
  ...scheduleDeletionEventTypes,
  ...scheduleRunEventTypes,
] as const;
export type ScheduleState = (typeof scheduleStates)[number];
export type ScheduleMissedReason = (typeof scheduleMissedReasons)[number];
export type ScheduleRunOutcome = (typeof scheduleRunOutcomes)[number];
export type ScheduleDefinitionEventType = (typeof scheduleDefinitionEventTypes)[number];
export type ScheduleDeletionEventType = (typeof scheduleDeletionEventTypes)[number];
export type ScheduleRunEventType = (typeof scheduleRunEventTypes)[number];
export type ScheduleEventType = (typeof scheduleEventTypes)[number];

export type ScheduleTriggerV1 = { readonly kind: "interval"; readonly everyMs: number; readonly anchorAt: string };

export interface ScheduleTargetV1 {
  readonly kind: "agent";
  readonly agentId: string;
  readonly runtimeInstanceId: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly cwd?: string;
}

export interface ScheduleDefinitionV1 {
  readonly schema: "schedule/v1";
  readonly scheduleId: string;
  readonly name: string;
  readonly state: ScheduleState;
  readonly spec: {
    readonly trigger: ScheduleTriggerV1;
    readonly target: ScheduleTargetV1;
    readonly mission: string;
  };
  readonly createdAt: string;
  readonly createdBy: ActorIdentity;
  readonly updatedAt: string;
}

export interface ScheduleActiveRunV1 {
  readonly occurrenceId: string;
  readonly kind: "scheduled" | "manual";
  readonly scheduledFor: string;
  readonly claimedAt: string;
  readonly nodeId: string;
  readonly assignmentId: string | null;
  readonly claimFence: string;
  readonly attemptIndex: number;
  readonly dispatchId?: string;
  readonly runtimeSessionId?: string;
}

export interface ScheduleLastRunV1 {
  readonly occurrenceId: string;
  readonly scheduledFor: string;
  readonly endedAt: string;
  readonly outcome: ScheduleRunOutcome;
  readonly nodeId: string;
  readonly assignmentId: string | null;
  readonly claimFence: string;
  readonly attemptIndex: number;
  readonly dispatchId?: string;
  readonly runtimeSessionId?: string;
  readonly detail?: string;
}

export interface ScheduleRunViewV1 {
  readonly automaticEvaluatedThrough: string;
  readonly activeRun: ScheduleActiveRunV1 | null;
  readonly lastRun: ScheduleLastRunV1 | null;
  readonly missedCount: number;
  readonly lastMissedAt: string | null;
  readonly lastMissedReason: ScheduleMissedReason | null;
}

export type ScheduleV1 = ScheduleDefinitionV1 & { readonly status: ScheduleRunViewV1 };

const triggerSchema: EntityJsonObjectSchema = {
  type: "object",
  properties: {
    kind: { type: "string", const: "interval" },
    everyMs: { type: "integer", minimum: 60_000 },
    anchorAt: { type: "string", minLength: 1 },
  },
  required: ["kind"],
  additionalProperties: false,
};
const targetSchema: EntityJsonObjectSchema = {
  type: "object",
  properties: {
    kind: { type: "string", const: "agent" },
    agentId: { type: "string", pattern: ENTITY_ID_PATTERN, minLength: 1 },
    runtimeInstanceId: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    reasoningEffort: { type: "string", minLength: 1 },
    cwd: { type: "string", minLength: 1 },
  },
  required: ["kind", "agentId", "runtimeInstanceId"],
  additionalProperties: false,
};
const definitionProperties = {
  schema: { type: "string", const: "schedule/v1" },
  scheduleId: { type: "string", pattern: ENTITY_ID_PATTERN, minLength: 1 },
  name: { type: "string", minLength: 1 },
  state: { type: "string", enum: scheduleStates },
  spec: {
    type: "object",
    properties: {
      trigger: triggerSchema,
      target: targetSchema,
      mission: { type: "string", minLength: 1 },
    },
    required: ["trigger", "target", "mission"],
    additionalProperties: false,
  },
  createdAt: { type: "string", minLength: 1 },
  createdBy: { type: "object", properties: {}, required: [], additionalProperties: true },
  updatedAt: { type: "string", minLength: 1 },
} as const;
const definitionFields = ["schema", "scheduleId", "name", "state", "spec", "createdAt", "createdBy", "updatedAt"];

export const SCHEDULE_DEFINITION_V1_SCHEMA: EntityDocumentJsonSchema<ScheduleDefinitionV1> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "ScheduleDefinition/v1",
  type: "object",
  properties: definitionProperties,
  required: definitionFields,
  additionalProperties: false,
};

export const SCHEDULE_V1_SCHEMA: EntityDocumentJsonSchema<ScheduleV1> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "Schedule/v1",
  type: "object",
  properties: {
    ...definitionProperties,
    status: {
      type: "object",
      properties: {
        automaticEvaluatedThrough: { type: "string", minLength: 1 },
        activeRun: { type: "object", properties: {}, required: [], additionalProperties: true, "x-nullable": true },
        lastRun: { type: "object", properties: {}, required: [], additionalProperties: true, "x-nullable": true },
        missedCount: { type: "integer", minimum: 0 },
        lastMissedAt: { type: "string", minLength: 1, "x-nullable": true },
        lastMissedReason: { type: "string", enum: scheduleMissedReasons, "x-nullable": true },
      },
      required: [
        "automaticEvaluatedThrough",
        "activeRun",
        "lastRun",
        "missedCount",
        "lastMissedAt",
        "lastMissedReason",
      ],
      additionalProperties: false,
    },
  },
  required: [...definitionFields, "status"],
  additionalProperties: false,
};

export function createScheduleV1(input: {
  readonly scheduleId: string;
  readonly name: string;
  readonly state?: ScheduleState;
  readonly spec: ScheduleDefinitionV1["spec"];
  readonly actor: ActorIdentity;
  readonly occurredAt: string;
}): ScheduleV1 {
  const definition: ScheduleDefinitionV1 = {
    schema: "schedule/v1",
    scheduleId: input.scheduleId,
    name: input.name.trim(),
    state: input.state ?? "armed",
    spec: { ...input.spec, mission: input.spec.mission.trim() },
    createdAt: input.occurredAt,
    createdBy: input.actor,
    updatedAt: input.occurredAt,
  };
  const schedule: ScheduleV1 = {
    ...definition,
    status: {
      automaticEvaluatedThrough: input.occurredAt,
      activeRun: null,
      lastRun: null,
      missedCount: 0,
      lastMissedAt: null,
      lastMissedReason: null,
    },
  };
  const errors = validateScheduleV1(schedule);
  if (errors.length) throw new Error(errors.join("; "));
  return schedule;
}

export function updateScheduleV1(input: {
  readonly schedule: ScheduleV1;
  readonly name: string;
  readonly spec: ScheduleDefinitionV1["spec"];
  readonly occurredAt: string;
}): ScheduleV1 {
  const schedule: ScheduleV1 = {
    ...input.schedule,
    name: input.name.trim(),
    spec: { ...input.spec, mission: input.spec.mission.trim() },
    updatedAt: input.occurredAt,
  };
  const errors = validateScheduleV1(schedule);
  if (errors.length) throw new Error(errors.join("; "));
  return schedule;
}

export function scheduleDefinition(schedule: ScheduleV1): ScheduleDefinitionV1 {
  return {
    schema: schedule.schema,
    scheduleId: schedule.scheduleId,
    name: schedule.name,
    state: schedule.state,
    spec: schedule.spec,
    createdAt: schedule.createdAt,
    createdBy: schedule.createdBy,
    updatedAt: schedule.updatedAt,
  };
}

export function validateScheduleDefinitionV1(value: unknown, allowUnknownFields = false): readonly string[] {
  if (!isRecord(value)) return ["schedule definition is not an object"];
  const structural = allowUnknownFields
    ? []
    : validateEntityJsonSchema(SCHEDULE_DEFINITION_V1_SCHEMA, value, "schedule");
  if (structural.length) return structural;
  if (!hasContractFields(value, definitionFields, allowUnknownFields) || value.schema !== "schedule/v1")
    return ["schedule definition fields are invalid"];
  if (
    typeof value.scheduleId !== "string" ||
    !new RegExp(ENTITY_ID_PATTERN, "u").test(value.scheduleId) ||
    !isNonEmptyString(value.name) ||
    !scheduleStates.includes(value.state as ScheduleState) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    validateActorIdentity(value.createdBy, allowUnknownFields).length > 0 ||
    !validSpec(value.spec, allowUnknownFields)
  )
    return ["schedule definition is invalid"];
  return [];
}

export function validateScheduleV1(value: unknown, allowUnknownFields = false): readonly string[] {
  if (!isRecord(value)) return ["schedule is not an object"];
  const structural = allowUnknownFields ? [] : validateEntityJsonSchema(SCHEDULE_V1_SCHEMA, value, "schedule");
  if (structural.length) return structural;
  const definition = Object.fromEntries(definitionFields.map((field) => [field, value[field]]));
  if (
    validateScheduleDefinitionV1(definition, allowUnknownFields).length ||
    !validRunView(value.status, allowUnknownFields)
  )
    return ["schedule definition or run view is invalid"];
  return [];
}

export function nextScheduleOccurrence(trigger: ScheduleTriggerV1, after: string): string {
  if (!timestamp(after) || !validTrigger(trigger, false)) throw new Error("schedule trigger or cursor is invalid");
  const anchor = Date.parse(trigger.anchorAt),
    cursor = Date.parse(after),
    steps = Math.max(1, Math.floor((cursor - anchor) / trigger.everyMs) + 1);
  return new Date(anchor + steps * trigger.everyMs).toISOString();
}

function validSpec(value: unknown, allowUnknownFields: boolean): boolean {
  return (
    isRecord(value) &&
    hasContractFields(value, ["trigger", "target", "mission"], allowUnknownFields) &&
    validTrigger(value.trigger, allowUnknownFields) &&
    validTarget(value.target, allowUnknownFields) &&
    isNonEmptyString(value.mission)
  );
}

function validTrigger(value: unknown, allowUnknownFields: boolean): value is ScheduleTriggerV1 {
  return (
    isRecord(value) &&
    hasContractFields(value, ["kind", "everyMs", "anchorAt"], allowUnknownFields) &&
    value.kind === "interval" &&
    Number.isSafeInteger(value.everyMs) &&
    Number(value.everyMs) >= 60_000 &&
    timestamp(value.anchorAt)
  );
}

function validTarget(value: unknown, allowUnknownFields: boolean): value is ScheduleTargetV1 {
  if (!isRecord(value)) return false;
  const optional = ["model", "reasoningEffort", "cwd"],
    required = ["kind", "agentId", "runtimeInstanceId"];
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    (allowUnknownFields || Object.keys(value).every((field) => required.includes(field) || optional.includes(field))) &&
    value.kind === "agent" &&
    typeof value.agentId === "string" &&
    new RegExp(ENTITY_ID_PATTERN, "u").test(value.agentId) &&
    isNonEmptyString(value.runtimeInstanceId) &&
    optional.every((field) => value[field] === undefined || isNonEmptyString(value[field]))
  );
}

function validRunView(value: unknown, allowUnknownFields: boolean): value is ScheduleRunViewV1 {
  if (
    !isRecord(value) ||
    !hasContractFields(
      value,
      ["automaticEvaluatedThrough", "activeRun", "lastRun", "missedCount", "lastMissedAt", "lastMissedReason"],
      allowUnknownFields,
    ) ||
    !timestamp(value.automaticEvaluatedThrough) ||
    !Number.isSafeInteger(value.missedCount) ||
    Number(value.missedCount) < 0 ||
    (value.lastMissedAt !== null && !timestamp(value.lastMissedAt)) ||
    (value.lastMissedReason !== null && !scheduleMissedReasons.includes(value.lastMissedReason as ScheduleMissedReason))
  )
    return false;
  return (
    (value.activeRun === null || validActiveRun(value.activeRun, allowUnknownFields)) &&
    (value.lastRun === null || validLastRun(value.lastRun, allowUnknownFields))
  );
}

function validActiveRun(value: unknown, allowUnknownFields: boolean): value is ScheduleActiveRunV1 {
  if (!isRecord(value)) return false;
  const required = [
      "occurrenceId",
      "kind",
      "scheduledFor",
      "claimedAt",
      "nodeId",
      "assignmentId",
      "claimFence",
      "attemptIndex",
    ],
    optional = ["dispatchId", "runtimeSessionId"];
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    (allowUnknownFields || Object.keys(value).every((field) => required.includes(field) || optional.includes(field))) &&
    isNonEmptyString(value.occurrenceId) &&
    (value.kind === "scheduled" || value.kind === "manual") &&
    timestamp(value.scheduledFor) &&
    timestamp(value.claimedAt) &&
    isNonEmptyString(value.nodeId) &&
    (value.assignmentId === null || isNonEmptyString(value.assignmentId)) &&
    isNonEmptyString(value.claimFence) &&
    Number.isSafeInteger(value.attemptIndex) &&
    Number(value.attemptIndex) >= 0 &&
    optional.every((field) => value[field] === undefined || isNonEmptyString(value[field]))
  );
}

function validLastRun(value: unknown, allowUnknownFields: boolean): value is ScheduleLastRunV1 {
  if (!isRecord(value)) return false;
  const required = [
      "occurrenceId",
      "scheduledFor",
      "endedAt",
      "outcome",
      "nodeId",
      "assignmentId",
      "claimFence",
      "attemptIndex",
    ],
    optional = ["dispatchId", "runtimeSessionId", "detail"];
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    (allowUnknownFields || Object.keys(value).every((field) => required.includes(field) || optional.includes(field))) &&
    isNonEmptyString(value.occurrenceId) &&
    timestamp(value.scheduledFor) &&
    timestamp(value.endedAt) &&
    scheduleRunOutcomes.includes(value.outcome as ScheduleRunOutcome) &&
    isNonEmptyString(value.nodeId) &&
    (value.assignmentId === null || isNonEmptyString(value.assignmentId)) &&
    isNonEmptyString(value.claimFence) &&
    Number.isSafeInteger(value.attemptIndex) &&
    Number(value.attemptIndex) >= 0 &&
    optional.every((field) => value[field] === undefined || isNonEmptyString(value[field]))
  );
}
