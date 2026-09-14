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
