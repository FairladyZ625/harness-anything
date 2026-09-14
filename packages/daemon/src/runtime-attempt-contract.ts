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
