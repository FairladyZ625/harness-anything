import type { SquadDispatchSelection } from "./agent-entities.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import type { FleetRuntimeDispatchContext } from "./fleet/command-protocol.ts";
import type {
  CanonicalEventStore,
  SettingsV1,
  TaskProjection,
  TaskMetadataV1,
  TaskWorktreeBindingV1,
  ActorIdentity,
  AgentRuntimeEventV1,
  AuthorizationDecision,
  RuntimeSession,
  SessionIdentity,
  WriteSource,
} from "@harness-anything/kernel";
import type {
  AgentPermissionMode,
  AgentRole,
  AgentRuntimeTargetV1,
  AgentSkillDeclarationV1,
  ScheduleRunOutcome,
} from "@harness-anything/kernel";
import type {
  PreparedRuntimeLaunch,
  RuntimeInstallationWitness,
  RuntimeInstanceKind,
  RuntimeInstanceSummary,
  RuntimeLaunchRequest,
} from "./agent-runtime-instances.ts";
import type { AgentRuntimeStreamHub, AgentRuntimeNativeSignal } from "./agent-runtime-stream.ts";
import { type DispatchStreamWriter } from "./dispatch-stream.ts";
import { type RuntimeDispatchArchive } from "./doc-sync-actions.ts";
import { type JsonObject } from "./protocol/json-rpc-types.ts";
import { type RuntimePermissionMode } from "./runtime-permissions.ts";
import type { RuntimeFallbackAttempt, RuntimeProviderFault } from "./runtime-fallback-contract.ts";
import type { RuntimeProviderHealthStore } from "./runtime-provider-health.ts";
import type { RuntimeContinuationSeed } from "./runtime-continuation-context.ts";

export interface RuntimeProcess {
  readonly pid: number;
  readonly onOutput: (listener: (chunk: string, persisted?: boolean) => void) => void;
  readonly onErrorOutput: (listener: (chunk: string) => void) => void;
  /** Fires only after onOutput delivered every provider line; exit settlement does not re-read the stream. */
  readonly onExit: (listener: (code: number | null, lossReason?: string) => void) => void;
  readonly terminate: () => void;
  readonly terminateTree?: () => Promise<void>;
  /** Live descendants of this runtime's root process, excluding the root itself. The probe
   *  reports unavailability as a failure result rather than an empty list: the watchdog must
   *  keep its historical deadline when the process table cannot be read. */
  readonly liveDescendantPids?: () => Promise<LiveDescendantProbeResult>;
  readonly release?: () => void;
}

export type LiveDescendantProbeResult =
  | { readonly available: true; readonly pids: readonly number[] }
  | { readonly available: false };

export type RuntimeLauncher = (
  input: PreparedRuntimeLaunch,
  persistence: {
    readonly rootDir: string;
    readonly dispatchId: string;
    readonly callbackRelay?: RuntimeCallbackRelay;
  },
) => RuntimeProcess;

export interface RuntimeDaemonRoute {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly endpoint: string;
}

export interface RuntimeCallbackRelay {
  readonly endpoint: string;
  readonly path: string;
}

export type RuntimeBinding = {
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly authorizationDecision?: AuthorizationDecision;
};

/** Persist only the runtime binding contract; RepoCell transport fences never cross a daemon restart. */
export function runtimeBindingForDispatch(binding: RuntimeBinding): RuntimeBinding {
  return {
    actor: binding.actor,
    source: binding.source,
  };
}

export interface TrustedScheduleRuntime {
  readonly scheduleId: string;
  readonly occurrenceId: string;
  readonly claimFence: string;
  readonly mode: "detect" | "remediate";
  readonly worktree?: {
    readonly cwd: string;
    readonly branch: string;
    readonly baseRef: string;
  };
}

export interface TrustedScheduleSpawn extends TrustedScheduleRuntime {
  readonly mission: string;
  readonly agentId: string;
  readonly effort?: string;
  readonly fast?: boolean;
  readonly cwd: string;
}

/** The execution lease generation a task-bound dispatch was authorized against; terminal
 * settlement releases that generation only, never whichever lease the task holds later. */
export interface RuntimeLeaseScope {
  readonly taskId: string;
  readonly executionId: string;
  readonly leaseVersion: number | null;
}

export interface RuntimeAttemptTerminal {
  readonly runtimeSessionId: string;
  readonly dispatchId: string;
  readonly task: RuntimeLeaseScope | null;
  readonly schedule: TrustedScheduleRuntime | null;
  readonly outcome: ScheduleRunOutcome | "superseded";
  readonly reason: string | null;
  readonly endedAt: string;
  readonly binding: RuntimeBinding;
}

export interface StalledReviewerContinuation {
  readonly dispatchId: string;
  readonly task: RuntimeLeaseScope;
  readonly binding: RuntimeBinding;
}

export type RuntimeAgent = {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly runtimes: readonly AgentRuntimeTargetV1[];
  readonly instance?: string;
  /** Ordered soft preference among the instances one runtimes row admits; unlike `instance` it
   *  never fails a dispatch when a preferred instance is unavailable on this node. */
  readonly preferredInstances?: readonly string[];
  readonly permissionMode?: AgentPermissionMode;
  readonly role?: AgentRole;
  readonly skills?: readonly AgentSkillDeclarationV1[];
  readonly prompts?: readonly string[];
  readonly preset?: string;
};

export type ActiveRuntime = {
  readonly process: RuntimeProcess;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly dispatchOpId: string;
  readonly instanceId: string;
  readonly kindId: RuntimeInstanceKind;
  /** Frozen launch witness from the dispatch stream header; null before the field existed or
   * when the launch environment resolved no provider home. */
  readonly resolvedProviderDirectory: string | null;
  readonly permissionMode: RuntimePermissionMode | null;
  readonly agent: Pick<RuntimeAgent, "id" | "name"> | null;
  readonly role: string | null;
  readonly delegatedBy: Pick<RuntimeAgent, "id" | "name"> | null;
  readonly squadId: string | null;
  readonly publicationOwner: "runtime" | "commander";
  readonly parentRuntimeSessionId: string | null;
  readonly binding: RuntimeBinding;
  readonly task: RuntimeLeaseScope | null;
  readonly decisionReviewTarget: { readonly decisionId: string; readonly digest: string } | null;
  readonly schedule: TrustedScheduleRuntime | null;
  /** The witnessed installation backing this launch; absent on adopted sessions
   * rebuilt from persisted streams, where the witness is no longer in scope. */
  readonly installation?: Pick<RuntimeInstallationWitness, "executablePath" | "version">;
  readonly cwd: string;
  readonly prompt: string;
  readonly promptSource?: string;
  readonly onExitCommand: string | null;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly fast: boolean;
  /** Total-token cap frozen from repository settings at launch; null disables the cap. */
  readonly tokenLimit: number | null;
  /** Idle deadline frozen from repository settings at dispatch creation. */
  readonly stallTimeoutMs: number;
  /** Last provider event or workspace change observed by the owner daemon. */
  lastProgressAtMs: number;
  /** Provider-announced tool calls that have not settled yet, with the observation time and the
   * call's own timeout when the provider declared one. A long command legitimately produces no
   * frames while it runs, so this ledger — not a timer reset — is the evidence the watchdog defers on. */
  inFlightToolCalls: Map<string, InFlightToolCall>;
  workspaceActivityCount: number;
  stalledAt: string | null;
  recordProviderProgress: (() => void) | null;
  recordWorkspaceProgress: (() => void) | null;
  readonly startedAt: string;
  readonly stream: DispatchStreamWriter;
  readonly fallbackAttempt: RuntimeFallbackAttempt | null;
  buffer: string;
  durableOutputCount: number;
  stdoutObserved: boolean;
  errorBuffer: string;
  errorOverflowed: boolean;
  providerSessionId: string | null;
  resumeProviderSessionId: string | null;
  finalText: string | null;
  failureText: string | null;
  providerOutcome: "succeeded" | "failed" | "unknown" | null;
  writeItemObserved: boolean;
  planObserved: boolean;
  planIncomplete: boolean;
  protocolError: boolean;
  cancelRequested: boolean;
  cancelBinding: RuntimeBinding | null;
  cancelOpId: string | null;
  /** Set once provider-reported consumption passes `tokenLimit`; one-way for the attempt. */
  spendCapExceeded: boolean;
  lossReason: string | null;
  lossSignal: string | null;
  lossExitCode: number | null;
  toolCallObserved: boolean;
  nonEmptyAgentOutputObserved: boolean;
  providerUsageEmpty: boolean;
  providerFault: RuntimeProviderFault | null;
  /** How many provider stream reconnects this attempt saw, and the provider's own last one.
   * Codex reports a reconnect as a plain `error` frame and then keeps answering, so this count
   * plus the tool/message flags below decide whether the attempt's tail is provider-caused.
   * Scalar state on purpose: an attempt can reconnect many times and nothing needs the history. */
  providerReconnectCount: number;
  lastProviderReconnect: ProviderReconnect | null;
  /** Reset on every reconnect; a completed, non-failed tool call sets it. A failed command is an
   * answered-but-red result and does not prove the provider resumed serving the attempt. */
  successfulToolCallAfterReconnect: boolean;
  /** Whether an agent message arrived after the latest reconnect. */
  finalAgentMessageAfterReconnect: boolean;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  toolCallCount: number;
  usageReported: boolean;
  providerToolSteps: Set<string>;
  compacted: boolean;
  rawUsage: Record<string, unknown>;
};

export type ProviderFrame = {
  readonly sessionIdentity?: SessionIdentity;
  readonly signals?: readonly AgentRuntimeNativeSignal[];
  readonly finalText?: string;
  readonly failureText?: string;
  readonly outcome?: "succeeded" | "failed" | "unknown";
  readonly writeItemObserved?: boolean;
  readonly planObserved?: boolean;
  readonly planIncomplete?: boolean;
  readonly toolCallObserved?: boolean;
  /** Set only when the settled tool call succeeded; a failed command is an answered-but-red tool
   * result and does not prove the provider resumed serving the attempt. */
  readonly toolCallSucceeded?: boolean;
  readonly providerUsageEmpty?: boolean;
  /** Token usage a provider nests below the frame top level, handed to the shared usage counters. */
  readonly usage?: Record<string, unknown>;
  readonly providerFault?: RuntimeProviderFault;
  /** A provider-declared stream reconnect (`Reconnecting... n/m (...)`), not a failure frame. */
  readonly providerReconnect?: ProviderReconnect;
  /** Tool-call lifecycle announced by this frame. A started call opens an entry in the runtime's
   * in-flight ledger; a settled one closes it. `timeoutMs` is the provider's own bound when it
   * declares one, which is what the stall watchdog may defer to. */
  readonly toolCalls?: readonly ProviderToolCallLifecycle[];
  /** Model ids the provider advertised on session establishment (ACP kinds). */
  readonly observedModels?: readonly string[];
  readonly observedCurrentModel?: string;
};

export type ProviderToolCallLifecycle = {
  readonly id: string;
  readonly settled: boolean;
  readonly timeoutMs?: number;
};

/** One provider-announced tool call as the daemon saw it start. */
export type InFlightToolCall = {
  readonly startedAtMs: number;
  readonly timeoutMs: number | null;
};

/** One provider stream reconnect. Codex spends a bounded `attempt/limit` budget on most of them, but
 * not all: `Reconnecting... waiting for network (...)` carries no budget, so both fields are null
 * there. `diagnostic` is the provider's own detail text, never the local reasoning about it. */
export type ProviderReconnect = {
  readonly attempt: number | null;
  readonly limit: number | null;
  readonly diagnostic: string;
};

export type ResumeProcessEvent =
  | { readonly kind: "output"; readonly chunk: string; readonly persisted: boolean }
  | { readonly kind: "error"; readonly chunk: string }
  | { readonly kind: "exit"; readonly code: number | null; readonly lossReason?: string };

export type ResumeProcessObservation = {
  readonly ready: Promise<void>;
  readonly activate: (handlers: {
    readonly output: (chunk: string, persisted?: boolean) => void;
    readonly error: (chunk: string) => void;
    readonly exit: (code: number | null, lossReason?: string) => void;
  }) => void;
};

export type RuntimeSessionSelection = Pick<
  RuntimeSession,
  "runtimeSessionId" | "providerSessionId" | "instanceId" | "liveness" | "outcome"
>;

export interface RemoteRuntimePersistence {
  readonly executionCredential: (runtimeSessionId: string) => {
    readonly credential: string;
    readonly expiresAt: string;
  };
  readonly taskContext: (
    taskId: string,
    missionName?: string,
    review?: { readonly executionId: string | undefined },
  ) => Promise<{
    readonly executionId: string;
    readonly reviewerSubmission?: Parameters<typeof import("@harness-anything/kernel").submissionDigest>[0];
    /** The mirrored task package on this node, and the mission that names it as the worker reaches it. */
    readonly packageRoot: string;
    readonly mission: (packageRoot: string) => string;
    /** The mirrored task plan body the mission inlines; explicit-prompt assembly reuses it. */
    readonly planBody: string | null;
    /** The task's frozen risk tier selects its worker mission flow. */
    readonly riskTier: TaskMetadataV1["riskTier"];
    /** Null for historical tasks using their creation-time profile mission rule. */
    readonly riskTierFlowVersion: TaskMetadataV1["riskTierFlowVersion"] | null;
    /** The task's frozen profile id from the center's serving cut; it identifies preset materialization. */
    readonly profileId: string | null;
    readonly taskClass: string;
    /** The causal-context block the center assembled for this task at the serving
     * cut; null when the task has no causal neighborhood. The block is also
     * embedded in the mission so task-bound remote spawns carry it verbatim. */
    readonly causalContext: string | null;
    /** The mirrored managed rework record (`returns/iteration-N.md`) of the iteration a
     * re-dispatched worker answers; null on a first dispatch. Re-dispatched missions carry
     * it verbatim; the mirrored document stays the single storage of the instruction. */
    readonly ownerReturnBody: string | null;
    /** Previous runtime conclusion and exit HEAD; current HEAD is measured after edge checkout. */
    readonly continuationContext: RuntimeContinuationSeed | null;
    /** The reviewer note the worker mission names; null for reviewer bindings (dec_E369B861 CH3). */
    readonly reviewerNote: string | null;
    /** The worktree binding the center derived for this task; null when it is closed or changes no repository files. */
    readonly worktree: TaskWorktreeBindingV1 | null;
  }>;
  readonly readRuntimeSessions: () => Promise<readonly RuntimeSessionSelection[]>;
  readonly publish: (draft: {
    readonly type: AgentRuntimeEventV1["type"];
    readonly payload: Readonly<Record<string, unknown>>;
    readonly opId: string;
    readonly resultBody?: string;
    readonly dispatchContext?: FleetRuntimeDispatchContext;
  }) => Promise<{
    readonly event: AgentRuntimeEventV1 | null;
    readonly receipt: JsonObject;
  }>;
  readonly archive: (archive: RuntimeDispatchArchive) => Promise<{ readonly outcome: string }>;
}

export interface RuntimeSpawnerInput {
  readonly repoId: string;
  readonly rootDir: string;
  readonly daemonGeneration: number;
  readonly runtimeNode?: { readonly nodeId: string };
  readonly runtimeDaemonRoute?: RuntimeDaemonRoute;
  readonly store?: () => CanonicalEventStore;
  readonly projection?: () => TaskProjection;
  readonly readSettings?: () => SettingsV1;
  readonly remote?: RemoteRuntimePersistence;
  /** Local runtime event commit; the caller already owns the RepoCell writer queue. */
  readonly commitRuntimeEvent?: (
    draft: {
      readonly type: AgentRuntimeEventV1["type"];
      readonly payload: Readonly<Record<string, unknown>>;
      readonly opId: string;
      readonly resultBody?: string;
      readonly dispatchContext?: FleetRuntimeDispatchContext;
    },
    binding: RuntimeBinding,
  ) => Promise<{ readonly event?: AgentRuntimeEventV1; readonly receipt: JsonObject }>;
  readonly stream: Pick<AgentRuntimeStreamHub, "publish">;
  readonly now: () => string;
  readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
  readonly runtimeProviderHealth?: RuntimeProviderHealthStore;
  readonly prepareLaunch: (instanceId: string, request: RuntimeLaunchRequest) => Promise<PreparedRuntimeLaunch>;
  /** Reclaims one runtime session's per-run temp directory under its instance state root;
   *  a no-op for instances without enforced isolation. Returns the filesystem failure (if
   *  any) so terminal settlement can record it honestly instead of swallowing it. */
  readonly reclaimRuntimeTempDirectory?: (instanceId: string, runtimeSessionId: string) => Error | null;
  /** Startup-only sweep: reclaims every per-run temp directory named in the caller's
   *  repository-scoped terminal session set. This — not the dispatch-stream-driven adoption branch —
   *  is the retry path for a reclaim that failed at settlement, because settlement archives
   *  the stream and archived streams do not drive adoption. */
  readonly reclaimSettledRuntimeTempDirectories?: (
    settledRuntimeSessionIds: readonly string[],
  ) => { readonly instanceId: string; readonly runtimeSessionId: string; readonly error: Error }[];
  readonly keycloakCenter?: import("./transport/auth-context.ts").KeycloakCenterAuthority;
  readonly prepareDaemonGitEnvironment?: (
    instanceId: string,
    provider?: "github" | "gitlab",
  ) => Promise<NodeJS.ProcessEnv | null>;
  readonly resolveAgent?: (agentId: string) => RuntimeAgent;
  readonly resolveSquadDispatch?: (
    squadId: string | undefined,
    leaderId: string,
    workerId: string | undefined,
    binding: RuntimeBinding,
  ) => SquadDispatchSelection;
  readonly launch?: RuntimeLauncher;
  readonly schedule: (work: () => void | Promise<void>, binding?: RuntimeBinding) => void;
  readonly onRuntimeOutcome?: (
    event: Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }>,
    schedule: TrustedScheduleRuntime | null,
  ) => void;
  /** Re-enters the existing task-review dispatch lane once after a primary reviewer stalls. */
  readonly onStalledReviewer?: (continuation: StalledReviewerContinuation) => void;
  readonly onAttemptTerminal?: (terminal: RuntimeAttemptTerminal) => void | Promise<void>;
  readonly handoffTaskLease?: (input: {
    readonly taskId: string;
    readonly runtimeSessionId: string;
    readonly fromRuntimeSessionId: string | null;
    readonly binding: RuntimeBinding;
  }) => Promise<RuntimeBinding>;
  /** Re-authorizes a persisted provider continuation before admitting its next attempt. */
  readonly authorizeRuntimeContinuation?: (
    payload: JsonObject,
    binding: RuntimeBinding,
    actionId: string,
  ) => RuntimeBinding | Promise<RuntimeBinding>;
  /** Re-authorizes each local RuntimeSession catalog Action at its commit cut. */
  readonly authorizeRuntimeEvent?: (input: {
    readonly type: AgentRuntimeEventV1["type"];
    readonly payload: AgentRuntimeEventV1["payload"];
    readonly opId: string;
    readonly binding: RuntimeBinding;
  }) => RuntimeBinding | Promise<RuntimeBinding>;
  /** Re-authorizes a local terminal archive at the settlement cut. */
  readonly authorizeRuntimeArchive?: (
    archive: RuntimeDispatchArchive,
    binding: RuntimeBinding,
  ) => RuntimeBinding | Promise<RuntimeBinding>;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
}
