import { isJsonObject } from "./json-rpc-types.ts";

export type TaskDispatchResume = {
  readonly dispatchId: string;
  readonly agentId: string | null;
};

export interface TaskDispatchRow {
  readonly resume?: TaskDispatchResume;
  readonly metrics?: {
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly toolCallCount: number;
    readonly compacted: boolean;
  };
  readonly dispatchId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly attemptGroupId: string;
  readonly attemptIndex: number;
  readonly provider: { readonly instance: string; readonly model: string | null };
  readonly classification: "provider_fault" | "provider_quota" | "worker_stop" | "gate_red" | null;
  readonly reason: string | null;
  readonly faultClass?: "quota_exhausted" | "rate_limited";
  readonly resetAt?: string;
  readonly nextAction?: string;
  readonly fallbackState: "scheduled" | "dispatched" | "exhausted" | null;
  readonly nextDispatchId: string | null;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly delegatedByAgentId?: string;
  readonly delegatedByAgentName?: string;
  readonly squadId?: string;
  readonly parentRuntimeSessionId?: string;
  readonly providerSessionId: string | null;
  readonly eventStreamRef: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | null;
  readonly status: "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "lost";
  readonly resultRef?: string | null;
  readonly exitCode?: number | null;
  readonly dispatchPath?: string | null;
  readonly reportPath?: string | null;
}

export type TaskDispatchAttempt = Pick<
  TaskDispatchRow,
  | "resume"
  | "dispatchId"
  | "runtimeSessionId"
  | "attemptIndex"
  | "provider"
  | "classification"
  | "reason"
  | "faultClass"
  | "resetAt"
  | "nextAction"
  | "fallbackState"
  | "nextDispatchId"
>;

const attemptRequiredFields = [
    "dispatchId",
    "runtimeSessionId",
    "attemptIndex",
    "provider",
    "classification",
    "reason",
    "fallbackState",
    "nextDispatchId",
  ] as const,
  attemptOptionalFields = ["resume", "faultClass", "resetAt", "nextAction"] as const;

export function validTaskDispatchAttempt(value: unknown): value is TaskDispatchAttempt {
  return (
    isJsonObject(value) &&
    hasFields(value, attemptRequiredFields, attemptOptionalFields) &&
    validTaskDispatchAttemptValues(value)
  );
}

export function validTaskDispatchRow(value: unknown): value is TaskDispatchRow {
  return (
    isJsonObject(value) &&
    [
      value.dispatchId,
      value.taskId,
      value.executionId,
      value.runtimeSessionId,
      value.instanceId,
      value.attemptGroupId,
    ].every(nonEmpty) &&
    validTaskDispatchAttemptValues(value) &&
    optionalTextFields(value, [
      "agentId",
      "agentName",
      "delegatedByAgentId",
      "delegatedByAgentName",
      "squadId",
      "parentRuntimeSessionId",
    ]) &&
    nullableText(value.providerSessionId) &&
    nullableText(value.eventStreamRef) &&
    nonEmpty(value.startedAt) &&
    nullableText(value.endedAt) &&
    [null, "succeeded", "failed", "unknown", "cancelled"].includes(value.outcome as never) &&
    ["running", "succeeded", "failed", "unknown", "cancelled", "lost"].includes(String(value.status)) &&
    optionalNullableText(value.resultRef) &&
    (value.exitCode === undefined || value.exitCode === null || nonNegativeInteger(value.exitCode)) &&
    optionalNullableText(value.dispatchPath) &&
    optionalNullableText(value.reportPath)
  );
}

function validTaskDispatchAttemptValues(value: Record<string, unknown>): boolean {
  return (
    nonEmpty(value.dispatchId) &&
    nonEmpty(value.runtimeSessionId) &&
    nonNegativeInteger(value.attemptIndex) &&
    isJsonObject(value.provider) &&
    nonEmpty(value.provider.instance) &&
    (value.provider.model === null || nonEmpty(value.provider.model)) &&
    (value.classification === null ||
      ["provider_fault", "provider_quota", "worker_stop", "gate_red"].includes(String(value.classification))) &&
    (value.reason === null || nonEmpty(value.reason)) &&
    (value.resume === undefined || validTaskDispatchResume(value.resume)) &&
    (value.faultClass === undefined || ["quota_exhausted", "rate_limited"].includes(String(value.faultClass))) &&
    (value.resetAt === undefined || (typeof value.resetAt === "string" && !Number.isNaN(Date.parse(value.resetAt)))) &&
    (value.nextAction === undefined || nonEmpty(value.nextAction)) &&
    (value.fallbackState === null || ["scheduled", "dispatched", "exhausted"].includes(String(value.fallbackState))) &&
    (value.nextDispatchId === null || nonEmpty(value.nextDispatchId))
  );
}

function validTaskDispatchResume(value: unknown): value is TaskDispatchResume {
  return (
    isJsonObject(value) &&
    hasFields(value, ["dispatchId", "agentId"], []) &&
    nonEmpty(value.dispatchId) &&
    (value.agentId === null || nonEmpty(value.agentId))
  );
}

function hasFields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => required.includes(field) || optional.includes(field))
  );
}

function optionalTextFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => value[field] === undefined || nonEmpty(value[field]));
}
function optionalNullableText(value: unknown): boolean {
  return value === undefined || nullableText(value);
}
function nullableText(value: unknown): boolean {
  return value === null || nonEmpty(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}
