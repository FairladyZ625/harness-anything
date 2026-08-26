import type { RuntimeInstanceKind } from "./agent-runtime-instances.ts";

export type DispatchExitClassification = "provider_fault" | "worker_stop" | "gate_red";

export type RuntimeProviderFault = {
  readonly code:
    | "rate_limited"
    | "server_error"
    | "quota_exhausted"
    | "unrecognized_model"
    | "auth_failed"
    | "provider_disconnected"
    | "pre_tool_exit";
  readonly reason: string;
};

export type RuntimeFallbackCandidate = { readonly instance: string; readonly model?: string };

export type RuntimeFallbackAttempt = {
  readonly attemptGroupId: string;
  readonly attemptIndex: number;
  readonly rootIdempotencyKey: string;
  readonly originalMission: string;
  readonly candidates: readonly RuntimeFallbackCandidate[];
  readonly backoff: { readonly baseMs: number; readonly maxMs: number; readonly maxAttempts: number };
};

export type RuntimeAttemptOutcome = {
  readonly classification: DispatchExitClassification;
  readonly reason: string;
  readonly provider: { readonly instance: string; readonly model: string; readonly kind: RuntimeInstanceKind };
  readonly attemptGroupId: string;
  readonly attemptIndex: number;
};
