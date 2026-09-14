export interface AgentRuntimeAttemptChainDto {
  readonly attemptGroupId: string;
  readonly attempts: readonly {
    readonly dispatchId: string;
    readonly runtimeSessionId: string;
    readonly attemptIndex: number;
    readonly provider: { readonly instance: string; readonly model: string | null };
    readonly classification: "provider_fault" | "provider_quota" | "worker_stop" | "gate_red" | null;
    readonly reason: string | null;
    readonly faultClass?: "quota_exhausted" | "rate_limited";
    readonly resetAt?: string;
    readonly nextAction?: string;
    readonly fallbackState: "scheduled" | "dispatched" | "exhausted" | null;
    readonly nextDispatchId: string | null;
  }[];
}

export function validAgentRuntimeAttemptChain(value: unknown): value is AgentRuntimeAttemptChainDto {
  return (
    isRecord(value) &&
    chainFieldsExact(value, ["attemptGroupId", "attempts"]) &&
    typeof value.attemptGroupId === "string" &&
    value.attemptGroupId.length > 0 &&
    Array.isArray(value.attempts) &&
    value.attempts.length > 0 &&
    value.attempts.every(
      (attempt) =>
        isRecord(attempt) &&
        chainFields(
          attempt,
          [
            "dispatchId",
            "runtimeSessionId",
            "attemptIndex",
            "provider",
            "classification",
            "reason",
            "fallbackState",
            "nextDispatchId",
          ],
          ["faultClass", "resetAt", "nextAction"],
        ) &&
        typeof attempt.dispatchId === "string" &&
        typeof attempt.runtimeSessionId === "string" &&
        Number.isInteger(attempt.attemptIndex) &&
        (attempt.attemptIndex as number) >= 0 &&
        isRecord(attempt.provider) &&
        chainFieldsExact(attempt.provider, ["instance", "model"]) &&
        typeof attempt.provider.instance === "string" &&
        (attempt.provider.model === null || typeof attempt.provider.model === "string") &&
        (attempt.classification === null ||
          ["provider_fault", "provider_quota", "worker_stop", "gate_red"].includes(String(attempt.classification))) &&
        (attempt.reason === null || typeof attempt.reason === "string") &&
        (attempt.faultClass === undefined ||
          ["quota_exhausted", "rate_limited"].includes(String(attempt.faultClass))) &&
        (attempt.resetAt === undefined ||
          (!Number.isNaN(Date.parse(String(attempt.resetAt))) && typeof attempt.resetAt === "string")) &&
        (attempt.nextAction === undefined ||
          (typeof attempt.nextAction === "string" && attempt.nextAction.length > 0)) &&
        (attempt.fallbackState === null ||
          ["scheduled", "dispatched", "exhausted"].includes(String(attempt.fallbackState))) &&
        (attempt.nextDispatchId === null || typeof attempt.nextDispatchId === "string"),
    )
  );
}
function chainFieldsExact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
function chainFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => required.includes(field) || optional.includes(field))
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
