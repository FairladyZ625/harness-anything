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

/** The runtime-incident disposition the center daemon recorded for this dispatch. `claimed` is the
 * durable pre-action fence, appended before any launch; it is replaced by `applied`/`failed` once
 * the action settles. Because the fence is keyed by the dispatch itself, a later settlement
 * observation can never act twice, and a crash between claim and settlement stays visible instead
 * of silently replaying. */
export type TaskDispatchDecisionAction =
  | {
      readonly pointId: string;
      readonly questionVersion: string;
      readonly status: "claimed";
      readonly decidedAt: string;
    }
  | {
      readonly pointId: string;
      readonly questionVersion: string;
      readonly status: "applied" | "failed";
      readonly selected: string;
      readonly action: "resume" | "rerun" | "needs_attention" | "no_action";
      /** Why an owner escalation needs attention: a real `question`, or a `guard` refusal that is
       * CEO handling work but not a ruling request. `null` for every non-escalation action. */
      readonly attention: "question" | "guard" | null;
      readonly reason: string | null;
      readonly successorDispatchId: string | null;
      readonly budget: {
        readonly used: number;
        readonly limit: number;
        readonly source: "task" | "repository" | "daemon";
      } | null;
      readonly decidedAt: string;
    };

export interface TaskDispatchRow {
  readonly decisionAction?: TaskDispatchDecisionAction;
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
  /** The bound task's title from the same projection row that yields `taskId`. A reader must not
   *  need a second, independently filtered task listing to label this dispatch: the live floor
   *  grouped rows by work while every row lost its title exactly because the two reads disagreed
   *  about which task rows were readable. Absent only when the projected task carries no title. */
  readonly taskTitle?: string;
  readonly executionId: string;
  /** Source role from runtime_dispatch_requested; absent only on older unclassified events. */
  readonly role?: string;
  /** Latest canonical or local dispatch observation, projected beside the dispatch row. */
  readonly lastObservedAt?: string;
  /** Daemon-owned activity judgment for the live-floor page. */
  readonly activityStatus?: "thinking" | "tool" | "waiting" | "silent" | "stalled" | "unknown";
  /** Observation used to calculate the activity age shown by the live-floor page. */
  readonly activityObservedAt?: string;
  /** Whole minutes since activityObservedAt; only meaningful for a live dispatch. */
  readonly activityIdleMinutes?: number;
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly attemptGroupId: string;
  readonly attemptIndex: number;
  readonly provider: { readonly instance: string; readonly model: string | null };
  readonly classification:
    | "provider_fault"
    | "provider_quota"
    | "worker_stop"
    | "awaiting_ruling"
    | "needs_attention"
    | "gate_red"
    | "completed_without_final_text"
    | null;
  /** Worker-authored ruling from its artifact; daemon incident escalations are in `decisionAction`. */
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
