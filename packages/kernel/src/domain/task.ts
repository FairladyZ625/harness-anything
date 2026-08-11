import type { LifecycleBinding } from "./lifecycle-binding.js";
import { validateTaskGraph } from "./task-graph.ts";
import type { TaskGraphV1, TaskNodeId } from "./task-graph.ts";

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

export const replayTaskStatuses = ["planned", "active", "in_review", "done"] as const;
export type ReplayTaskStatus = (typeof replayTaskStatuses)[number];
export interface ActorAxes { readonly principal: { readonly personId: string }; readonly executor: { readonly kind: "agent"; readonly id: string } | null }
export interface TaskV1 { readonly schema: "task/v1"; readonly taskId: string; readonly title: string; readonly status: ReplayTaskStatus; readonly graph: TaskGraphV1; readonly currentNode: TaskNodeId; readonly iteration: 0 | 1; readonly createdBy: ActorAxes; readonly completionGateIds: readonly string[] }
export interface ContractValidationIssue { readonly code: string; readonly message: string }
export const TASK_V1_SCHEMA = Object.freeze({ id: "Task/v1", required: Object.freeze(["schema", "taskId", "title", "status", "graph", "currentNode", "iteration", "createdBy", "completionGateIds"]), statuses: replayTaskStatuses });
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function canonicalizeContractValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeContractValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeContractValue(value[key])]));
}
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
export function hasOnlyFields(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return Object.keys(value).every((field) => fields.includes(field)) && fields.every((field) => Object.hasOwn(value, field));
}
export function validateActorAxes(value: unknown): readonly ContractValidationIssue[] {
  if (!isRecord(value) || !hasOnlyFields(value, ["principal", "executor"]) || !isRecord(value.principal)
    || !hasOnlyFields(value.principal, ["personId"]) || !isNonEmptyString(value.principal.personId)) {
    return [{ code: "invalid_actor", message: "actor requires only principal.personId and executor" }];
  }
  if (value.executor !== null && (!isRecord(value.executor) || !hasOnlyFields(value.executor, ["kind", "id"])
    || value.executor.kind !== "agent" || !isNonEmptyString(value.executor.id))) {
    return [{ code: "invalid_actor", message: "executor must be null or an agent identity" }];
  }
  return [];
}
export function validateTaskV1(value: unknown): readonly ContractValidationIssue[] {
  const fields = TASK_V1_SCHEMA.required;
  if (!isRecord(value) || !hasOnlyFields(value, fields)) return [{ code: "invalid_task", message: "Task/v1 fields are incomplete or unknown" }];
  const issues: ContractValidationIssue[] = [];
  if (value.schema !== "task/v1") issues.push({ code: "invalid_schema", message: "Task must use task/v1" });
  if (!isNonEmptyString(value.taskId) || !isNonEmptyString(value.title)) issues.push({ code: "invalid_task", message: "taskId and title are required" });
  if (!(replayTaskStatuses as readonly unknown[]).includes(value.status)) issues.push({ code: "invalid_task", message: "invalid Task status" });
  if (!(taskNodeIdsForValidation as readonly unknown[]).includes(value.currentNode)) issues.push({ code: "invalid_task", message: "invalid current node" });
  if (value.iteration !== 0 && value.iteration !== 1) issues.push({ code: "invalid_iteration", message: "iteration must be 0 or 1" });
  if (!Array.isArray(value.completionGateIds) || value.completionGateIds.some((id) => !isNonEmptyString(id))) issues.push({ code: "invalid_task", message: "completion gate ids must be strings" });
  issues.push(...validateActorAxes(value.createdBy), ...validateTaskGraph(value.graph));
  return issues;
}

const taskNodeIdsForValidation = ["implementation", "anti_entropy", "review"] as const;

export type WriteTarget =
  | { readonly kind: "event_stream"; readonly stream: string; readonly operation: "append" }
  | { readonly kind: "projection_invalidation"; readonly projection: string; readonly taskId: string }
  | { readonly kind: "task_artifact"; readonly path: string; readonly operation: "create" | "replace" };
export interface WritePlan<C extends string = string> { readonly commandType: C; readonly targets: readonly WriteTarget[] }
declare const frozenWritePlanBrand: unique symbol;
export type FrozenWritePlan<C extends string = string> = Readonly<WritePlan<C>> & { readonly [frozenWritePlanBrand]: true };

function writeTargetKey(target: WriteTarget): string {
  return target.kind === "event_stream" ? `${target.kind}:${target.stream}`
    : target.kind === "projection_invalidation" ? `${target.kind}:${target.projection}:${target.taskId}`
    : `${target.kind}:${target.path}`;
}
export function validateWritePlanShape(plan: WritePlan, commandTypes: readonly string[]): readonly ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];
  if (!commandTypes.includes(plan.commandType)) issues.push({ code: "invalid_write_plan", message: "write plan command must come from the lifecycle contract" });
  if (!Array.isArray(plan.targets) || !plan.targets.some((target) => target.kind === "event_stream")
    || !plan.targets.some((target) => target.kind === "projection_invalidation")) issues.push({ code: "invalid_write_plan", message: "every command must declare its event stream and projection invalidation" });
  const keys = new Set<string>();
  for (const target of plan.targets) {
    if (keys.has(writeTargetKey(target))) issues.push({ code: "duplicate_write_target", message: `duplicate write target: ${writeTargetKey(target)}` });
    keys.add(writeTargetKey(target));
    if (target.kind === "event_stream" && (!isNonEmptyString(target.stream) || target.operation !== "append")) issues.push({ code: "invalid_write_plan", message: "event stream targets require append" });
    if (target.kind === "projection_invalidation" && (!isNonEmptyString(target.projection) || !isNonEmptyString(target.taskId))) issues.push({ code: "invalid_write_plan", message: "projection invalidation requires projection and task identity" });
    if (target.kind === "task_artifact" && (!isNonEmptyString(target.path) || !["create", "replace"].includes(target.operation))) issues.push({ code: "invalid_write_plan", message: "artifact targets require an explicit write operation" });
  }
  return issues;
}
export function freezeValidatedWritePlan<C extends string>(plan: WritePlan<C>): FrozenWritePlan<C> {
  return Object.freeze({ commandType: plan.commandType, targets: Object.freeze(plan.targets.map((target) => Object.freeze({ ...target }))) }) as FrozenWritePlan<C>;
}
export function isFrozenWritePlan(plan: WritePlan): boolean { return Object.isFrozen(plan) || Object.isFrozen(plan.targets); }
export function appendWriteTarget<C extends string>(plan: WritePlan<C>, target: WriteTarget): WritePlan<C> {
  return { commandType: plan.commandType, targets: [...plan.targets, target] };
}
