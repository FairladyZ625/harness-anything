import type { TaskDispatchAttempt } from "./protocol/task-dispatch-contract.ts";
import { validTaskDispatchAttempt } from "./protocol/daemon-protocol-validate-relation-query.ts";
import { isJsonObject as isRecord } from "./protocol/json-rpc-types.ts";

export interface AgentRuntimeAttemptChainDto {
  readonly attemptGroupId: string;
  readonly attempts: readonly TaskDispatchAttempt[];
}

export function validAgentRuntimeAttemptChain(value: unknown): value is AgentRuntimeAttemptChainDto {
  return (
    isRecord(value) &&
    chainFieldsExact(value, ["attemptGroupId", "attempts"]) &&
    typeof value.attemptGroupId === "string" &&
    value.attemptGroupId.length > 0 &&
    Array.isArray(value.attempts) &&
    value.attempts.length > 0 &&
    value.attempts.every(validTaskDispatchAttempt)
  );
}
function chainFieldsExact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
