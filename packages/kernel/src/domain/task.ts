import type { LifecycleBinding } from "./lifecycle-binding.js";
import { validateRelationRecordsForHost, type EntityRelationRecord } from "./entity-relation.ts";
import { validateTaskGraph } from "./task-graph.ts";
import type { TaskGraphV1, TaskNodeId } from "./task-graph.ts";
import { isNonEmptyString, isRecord, validateActorIdentity } from "./write-chain.contract.ts";
import { validateSessionProvenance, type SessionProvenanceV1 } from "./agent-runtime.ts";
export {
  canonicalizeWriteValue as canonicalizeContractValue,
  hasOnlyFields,
  isNonEmptyString,
  isRecord,
} from "./write-chain.contract.ts";

export type TaskId = string;
export type EngineId = string;
export type ExternalRef = string;
export type IsoTimestamp = string;
export type Sha256Fingerprint = `sha256:${string}`;

export interface TaskIdentity {
  readonly id: TaskId;
  readonly title: string;
}

export interface Task {
  readonly id: TaskId;
  readonly title: string;
  readonly lifecycle: LifecycleBinding;
  readonly parent?: TaskId;
}

export function createTaskIdentity(id: TaskId, title: string): TaskIdentity {
  return { id, title };
}

export const replayTaskStatuses = ["planned", "active", "blocked", "in_review", "done", "cancelled"] as const;
export type ReplayTaskStatus = (typeof replayTaskStatuses)[number];
export const taskClasses = ["standard", "milestone", "epic", "long_running"] as const;
export type TaskClass = (typeof taskClasses)[number];
export interface ActorAxes {
  readonly principal: { readonly personId: string };
  readonly executor: { readonly kind: "agent"; readonly id: string } | null;
}
export type TaskPackageDisposition = "active" | "archived" | "tombstoned";
export interface TaskMetadataV1 {
  readonly idempotencyKey: string | null;
  readonly parentTaskId: string | null;
  readonly workKind: "feat" | "fix" | "refactor" | "docs" | "test" | "chore" | null;
  readonly riskTier: "low" | "medium" | "high" | null;
  readonly urgency: "low" | "medium" | "high" | null;
  readonly verticalId: string;
  readonly presetId: string;
  readonly profileId: string;
  readonly moduleKey: string | null;
  readonly slug: string;
  readonly surfaces: readonly string[];
  readonly fromLegacyId: string | null;
}
export interface TaskV1 {
  readonly schema: "task/v1";
  readonly taskId: string;
  readonly title: string;
  readonly taskClass: TaskClass;
  readonly status: ReplayTaskStatus;
  readonly graph: TaskGraphV1;
  readonly currentNode: TaskNodeId;
  readonly iteration: 0 | 1;
  readonly createdBy: ActorAxes;
  readonly completionGateIds: readonly string[];
  readonly presetSnapshotDigest: `sha256:${string}` | null;
  readonly provenance?: readonly SessionProvenanceV1[];
  readonly pinned?: boolean;
  readonly metadata?: TaskMetadataV1;
  readonly relations?: readonly EntityRelationRecord[];
  readonly packageDisposition?: TaskPackageDisposition;
  readonly supersededBy?: string | null;
  readonly contractVersion?: number;
}
export interface ContractValidationIssue {
  readonly code: string;
  readonly message: string;
}
export const TASK_V1_SCHEMA = Object.freeze({
  id: "Task/v1",
  required: Object.freeze([
    "schema",
    "taskId",
    "title",
    "taskClass",
    "status",
    "graph",
    "currentNode",
    "iteration",
    "createdBy",
    "completionGateIds",
    "presetSnapshotDigest",
  ]),
  statuses: replayTaskStatuses,
  taskClasses,
});
export function validateActorAxes(value: unknown, allowUnknownFields = false): readonly ContractValidationIssue[] {
  return validateActorIdentity(value, allowUnknownFields).map((message) => ({ code: "invalid_actor", message }));
}
export function validateTaskV1(value: unknown, allowUnknownFields = false): readonly ContractValidationIssue[] {
  const fields = TASK_V1_SCHEMA.required,
    allowed = [
      ...fields,
      "provenance",
      "pinned",
      "metadata",
      "relations",
      "packageDisposition",
      "supersededBy",
      "contractVersion",
    ];
  if (
    !isRecord(value) ||
    fields.some((field) => !(field in value)) ||
    (!allowUnknownFields && Object.keys(value).some((field) => !allowed.includes(field)))
  )
    return [{ code: "invalid_task", message: "Task/v1 fields are incomplete or unknown" }];
  const issues: ContractValidationIssue[] = [];
  if (value.schema !== "task/v1") issues.push({ code: "invalid_schema", message: "Task must use task/v1" });
  if (!isNonEmptyString(value.taskId) || !isNonEmptyString(value.title))
    issues.push({ code: "invalid_task", message: "taskId and title are required" });
  if (!(taskClasses as readonly unknown[]).includes(value.taskClass))
    issues.push({ code: "invalid_task", message: "invalid taskClass" });
  if (!(replayTaskStatuses as readonly unknown[]).includes(value.status))
    issues.push({ code: "invalid_task", message: "invalid Task status" });
  if (!(taskNodeIdsForValidation as readonly unknown[]).includes(value.currentNode))
    issues.push({ code: "invalid_task", message: "invalid current node" });
  if (value.iteration !== 0 && value.iteration !== 1)
    issues.push({ code: "invalid_iteration", message: "iteration must be 0 or 1" });
  if (!Array.isArray(value.completionGateIds) || value.completionGateIds.some((id) => !isNonEmptyString(id)))
    issues.push({ code: "invalid_task", message: "completion gate ids must be strings" });
  if (
    value.presetSnapshotDigest !== null &&
    (typeof value.presetSnapshotDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.presetSnapshotDigest))
  )
    issues.push({ code: "invalid_task", message: "preset snapshot digest must be null or SHA-256" });
  if (
    value.provenance !== undefined &&
    (!Array.isArray(value.provenance) ||
      value.provenance.length === 0 ||
      value.provenance.some((entry) => !validateSessionProvenance(entry)))
  )
    issues.push({ code: "invalid_task", message: "task provenance must contain session identities" });
  if (value.pinned !== undefined && typeof value.pinned !== "boolean")
    issues.push({ code: "invalid_task", message: "pinned must be a boolean" });
  if (value.metadata !== undefined) {
    const issue = metadataIssue(value.metadata, allowUnknownFields);
    if (issue) issues.push(issue);
  }
  const relationFields = [
    "relation_id",
    "source",
    "target",
    "type",
    "strength",
    "direction",
    "origin",
    "rationale",
    "state",
  ];
  if (
    value.relations !== undefined &&
    (!Array.isArray(value.relations) ||
      value.relations.some(
        (relation) =>
          !isRecord(relation) ||
          !(allowUnknownFields || Object.keys(relation).every((field) => relationFields.includes(field))) ||
          relationFields.some((field) => !Object.hasOwn(relation, field)),
      ) ||
      validateRelationRecordsForHost(`task/${String(value.taskId)}`, value.relations as EntityRelationRecord[]).length)
  )
    issues.push({ code: "invalid_task", message: "task relations are invalid" });
  if (
    value.packageDisposition !== undefined &&
    !["active", "archived", "tombstoned"].includes(String(value.packageDisposition))
  )
    issues.push({ code: "invalid_task", message: "invalid package disposition" });
  if (value.supersededBy !== undefined && value.supersededBy !== null && !isNonEmptyString(value.supersededBy))
    issues.push({ code: "invalid_task", message: "supersededBy must be a task id or null" });
  if (
    value.contractVersion !== undefined &&
    (!Number.isSafeInteger(value.contractVersion) || (value.contractVersion as number) < 1)
  )
    issues.push({ code: "invalid_task", message: "contractVersion must be a positive integer" });
  issues.push(
    ...validateActorAxes(value.createdBy, allowUnknownFields),
    ...validateTaskGraph(value.graph, allowUnknownFields),
  );
  return issues;
}

const taskMetadataFields = [
  "idempotencyKey",
  "parentTaskId",
  "workKind",
  "riskTier",
  "urgency",
  "verticalId",
  "presetId",
  "profileId",
  "moduleKey",
  "slug",
  "surfaces",
  "fromLegacyId",
] as const;
function metadataIssue(value: unknown, allowUnknownFields: boolean): ContractValidationIssue | null {
  // longRunning predates taskClass=long_running (dec_01KYRHP8ND). The event log is immutable,
  // so historical payloads may still carry the retired boolean; current writers never emit it.
  if (!isRecord(value)) return { code: "invalid_task", message: "task metadata must be an object" };
  const missing = taskMetadataFields.filter((field) => !Object.hasOwn(value, field));
  if (missing.length)
    return { code: "invalid_task", message: `task metadata is missing required fields: ${missing.join(", ")}` };
  const unknown = Object.keys(value)
    .filter((field) => !(taskMetadataFields as readonly string[]).includes(field))
    .sort();
  if (!allowUnknownFields && unknown.length)
    return { code: "invalid_task", message: `task metadata contains unknown fields: ${unknown.join(", ")}` };
  if (allowUnknownFields && Object.hasOwn(value, "longRunning") && typeof value.longRunning !== "boolean")
    return { code: "invalid_task", message: "retired task metadata field longRunning must be a boolean" };
  const nullableText = (candidate: unknown): boolean => candidate === null || isNonEmptyString(candidate);
  const invalid = [
    !nullableText(value.idempotencyKey) && "idempotencyKey",
    !nullableText(value.parentTaskId) && "parentTaskId",
    !(
      value.workKind === null || ["feat", "fix", "refactor", "docs", "test", "chore"].includes(String(value.workKind))
    ) && "workKind",
    !(value.riskTier === null || ["low", "medium", "high"].includes(String(value.riskTier))) && "riskTier",
    !(value.urgency === null || ["low", "medium", "high"].includes(String(value.urgency))) && "urgency",
    !isNonEmptyString(value.verticalId) && "verticalId",
    !isNonEmptyString(value.presetId) && "presetId",
    !isNonEmptyString(value.profileId) && "profileId",
    !nullableText(value.moduleKey) && "moduleKey",
    !/^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$/u.test(String(value.slug)) && "slug",
    !(Array.isArray(value.surfaces) && value.surfaces.every(isNonEmptyString)) && "surfaces",
    !nullableText(value.fromLegacyId) && "fromLegacyId",
  ].filter((field): field is string => typeof field === "string");
  return invalid.length
    ? { code: "invalid_task", message: `task metadata fields have invalid values: ${invalid.join(", ")}` }
    : null;
}

export function currentTaskForWrite(task: TaskV1): TaskV1 {
  if (task.metadata === undefined || !Object.hasOwn(task.metadata, "longRunning")) return task;
  const { longRunning, ...metadata } = task.metadata as TaskMetadataV1 & { readonly longRunning: unknown };
  void longRunning;
  return { ...task, metadata };
}

const taskNodeIdsForValidation = ["implementation", "review"] as const;
