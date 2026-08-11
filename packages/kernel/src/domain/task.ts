import type { LifecycleBinding } from "./lifecycle-binding.js";
import { validateTaskGraph } from "./task-graph.ts";
import type { TaskGraphV1, TaskNodeId } from "./task-graph.ts";
import { hasOnlyFields, isNonEmptyString, isRecord, validateActorIdentity } from "./write-chain.contract.ts";
export { canonicalizeWriteValue as canonicalizeContractValue, hasOnlyFields, isNonEmptyString, isRecord } from "./write-chain.contract.ts";

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
export function validateActorAxes(value: unknown): readonly ContractValidationIssue[] {
  return validateActorIdentity(value).map((message) => ({ code: "invalid_actor", message }));
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
