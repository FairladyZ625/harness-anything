import type { RuntimeInstanceKind } from "./agent-runtime-instances.ts";

export type DispatchExitClassification =
  | "provider_fault"
  | "provider_quota"
  | "worker_stop"
  /** The worker stopped to await an owner ruling; the question rides the ruling artifact. */
  | "awaiting_ruling"
  | "needs_attention"
  | "gate_red"
  | "completed_without_final_text";

export function isProviderFailureClassification(classification: DispatchExitClassification): boolean {
  return classification === "provider_fault" || classification === "provider_quota";
}

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
  readonly faultClass?: "quota_exhausted" | "rate_limited";
  readonly resetAt?: string;
};

export type RuntimeFallbackCandidate = { readonly instance: string; readonly model?: string };

export type RuntimeFallbackAttempt = {
  readonly attemptGroupId: string;
  readonly attemptIndex: number;
  /** Position within the current candidate round. Older streams omit this and use attemptIndex. */
  readonly candidateIndex?: number;
  /** Number of completed retry rounds after the initial candidate pass. */
  readonly retryRound?: number;
  readonly waitStartedAt?: string;
  readonly rootDispatchKey: string;
  /** Fallback source mission with the current dispatch ID replaced by the spawner's prompt token. */
  readonly originalMission: string;
  readonly candidates: readonly RuntimeFallbackCandidate[];
};

export type RuntimeAttemptOutcome = {
  readonly classification: DispatchExitClassification;
  readonly reason: string;
  readonly provider: { readonly instance: string; readonly model: string; readonly kind: RuntimeInstanceKind };
  readonly attemptGroupId: string;
  readonly attemptIndex: number;
  readonly faultClass?: RuntimeProviderFault["faultClass"];
  readonly resetAt?: string;
};
