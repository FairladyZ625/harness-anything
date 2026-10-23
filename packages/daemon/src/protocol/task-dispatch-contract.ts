export type TaskDispatchResume = {
  readonly dispatchId: string;
  readonly agentId: string | null;
};

export interface TaskDispatchAdvisory {
  readonly evaluatedAt: string;
  readonly pointId: string;
  readonly questionVersion: string;
  readonly selected: string;
  readonly distribution: Readonly<Record<string, number>>;
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly provider: {
    readonly providerId: string;
    readonly vendor: "openrouter";
    readonly requestedModel: string;
    readonly resolvedModel: string;
    readonly modelVersion: null;
    readonly providerRoute: string | null;
  };
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reportedCost: number | null;
  };
  readonly latencyMs: number;
}

export interface TaskDispatchRow {
  readonly reviewTarget?:
    | { readonly kind: "task"; readonly taskId: string; readonly executionId: string; readonly digest: string }
    | { readonly kind: "decision"; readonly decisionId: string; readonly digest: string };
  readonly resume?: TaskDispatchResume;
  readonly metrics?: {
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly toolCallCount: number;
    readonly compacted: boolean | null;
  };
  readonly dispatchId: string;
  readonly taskId: string;
  readonly executionId: string;
  /** Source role from runtime_dispatch_requested; absent only on older unclassified events. */
  readonly role?: string;
  /** Latest canonical or local dispatch observation, projected beside the dispatch row. */
  readonly lastObservedAt?: string;
  /** Daemon-owned activity judgment for the live-floor page. */
  readonly activityStatus?: "progressing" | "waiting_ci" | "stalled" | "unknown";
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly attemptGroupId: string;
  readonly attemptIndex: number;
  readonly provider: { readonly instance: string; readonly model: string | null };
  readonly classification: "provider_fault" | "provider_quota" | "worker_stop" | "awaiting_ruling" | "gate_red" | null;
  /** Present when the worker stopped to await an owner ruling (classification `awaiting_ruling`). */
  readonly ruling?: {
    readonly question: string;
    readonly options: readonly string[];
    readonly path: string;
  };
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
  readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped" | null;
  readonly status: "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "stopped" | "blocked" | "lost";
  readonly resultRef?: string | null;
  readonly exitCode?: number | null;
  readonly dispatchPath?: string | null;
  readonly reportPath?: string | null;
  readonly advisories?: readonly TaskDispatchAdvisory[];
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
