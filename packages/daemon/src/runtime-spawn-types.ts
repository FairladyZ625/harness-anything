import type { SquadDispatchSelection } from "./agent-entities.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import type { FleetAssignmentScope } from "./fleet/contract.ts";
import type {
  CanonicalEventStore,
  SettingsV1,
  TaskProjection,
  ActorIdentity,
  AgentRuntimeEventV1,
  AuthorizationDecision,
  RoleBinding,
  RuntimeSession,
  SessionIdentity,
  WriteSource,
} from "../../kernel/src/index.ts";
import type {
  AgentFallbackDeclarationV1,
  AgentPermissionMode,
  AgentRole,
  AgentSkillDeclarationV1,
} from "../../kernel/src/index.ts";
import type { PreparedRuntimeLaunch, RuntimeInstanceKind, RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import type { AgentRuntimeStreamHub, AgentRuntimeNativeSignal } from "./agent-runtime-stream.ts";
import { type DispatchStreamWriter } from "./dispatch-stream.ts";
import { type RuntimeDispatchArchive } from "./doc-sync-actions.ts";
import { type JsonObject } from "./protocol/json-rpc-types.ts";
import { type RuntimePermissionMode } from "./runtime-permissions.ts";
import type { RuntimeFallbackAttempt, RuntimeProviderFault } from "./runtime-fallback-contract.ts";

export interface RuntimeProcess {
  readonly pid: number;
  readonly onOutput: (listener: (chunk: string, persisted?: boolean) => void) => void;
  readonly onErrorOutput: (listener: (chunk: string) => void) => void;
  /** Fires only after onOutput delivered every provider line; exit settlement does not re-read the stream. */
  readonly onExit: (listener: (code: number | null) => void) => void;
  readonly terminate: () => void;
  readonly terminateTree?: () => Promise<void>;
  readonly release?: () => void;
}

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
  /** Preserve whether local authorization came from the default or authored binding projection. */
  readonly authorizationBindingMode?: "default" | "declared";
  readonly roleBindings?: readonly RoleBinding[];
  readonly assignmentScope?: FleetAssignmentScope;
  readonly authorizationDecision?: AuthorizationDecision;
};

/** Persist only the runtime binding contract; RepoCell transport fences never cross a daemon restart. */
export function runtimeBindingForDispatch(binding: RuntimeBinding): RuntimeBinding {
  return {
    actor: binding.actor,
    source: binding.source,
    ...(binding.authorizationBindingMode === undefined
      ? {}
      : { authorizationBindingMode: binding.authorizationBindingMode }),
    ...(binding.roleBindings === undefined ? {} : { roleBindings: binding.roleBindings }),
    ...(binding.assignmentScope === undefined ? {} : { assignmentScope: binding.assignmentScope }),
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
    readonly baseRef: "origin/main";
  };
}

export interface TrustedScheduleSpawn extends TrustedScheduleRuntime {
  readonly mission: string;
  readonly runtimeInstanceId: string;
  readonly agentId: string;
  readonly model?: string;
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
  readonly outcome: "succeeded" | "failed";
  readonly reason: string | null;
  readonly endedAt: string;
  readonly resultRef: string | null;
  readonly binding: RuntimeBinding;
}

export type RuntimeAgent = {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly runtime_type: string;
  readonly instance?: string;
  readonly permissionMode?: AgentPermissionMode;
  readonly role?: AgentRole;
  readonly model?: string;
  readonly skills?: readonly AgentSkillDeclarationV1[];
  readonly prompts?: readonly string[];
  readonly preset?: string;
  readonly fallback?: AgentFallbackDeclarationV1;
};

export type ActiveRuntime = {
  readonly process: RuntimeProcess;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly dispatchOpId: string;
  readonly instanceId: string;
  readonly kindId: RuntimeInstanceKind;
  readonly permissionMode: RuntimePermissionMode | null;
  readonly agent: Pick<RuntimeAgent, "id" | "name"> | null;
  readonly delegatedBy: Pick<RuntimeAgent, "id" | "name"> | null;
  readonly squadId: string | null;
  readonly parentRuntimeSessionId: string | null;
  readonly binding: RuntimeBinding;
  readonly task: RuntimeLeaseScope | null;
  readonly schedule: TrustedScheduleRuntime | null;
  readonly cwd: string;
  readonly prompt: string;
  readonly promptSource?: string;
  readonly onExitCommand: string | null;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly fast: boolean;
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
  lossReason: string | null;
  lossSignal: string | null;
  lossExitCode: number | null;
  descendantsAlive: boolean;
  worktreeDirty: boolean;
  toolCallObserved: boolean;
  nonEmptyAgentOutputObserved: boolean;
  providerUsageEmpty: boolean;
  providerFault: RuntimeProviderFault | null;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  toolCallCount: number;
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
  readonly providerUsageEmpty?: boolean;
  readonly providerFault?: RuntimeProviderFault;
};

export type ResumeProcessEvent =
  | { readonly kind: "output"; readonly chunk: string }
  | { readonly kind: "error"; readonly chunk: string }
  | { readonly kind: "exit"; readonly code: number | null };

export type ResumeProcessObservation = {
  readonly ready: Promise<void>;
  readonly activate: (handlers: {
    readonly output: (chunk: string) => void;
    readonly error: (chunk: string) => void;
    readonly exit: (code: number | null) => void;
  }) => void;
};

export type RuntimeSessionSelection = Pick<
  RuntimeSession,
  "runtimeSessionId" | "providerSessionId" | "instanceId" | "liveness" | "outcome"
>;

export interface RemoteRuntimePersistence {
  readonly existing: (opId: string) => Promise<JsonObject | null>;
  readonly taskContext: (
    taskId: string,
    missionName?: string,
  ) => Promise<{
    readonly executionId: string;
    readonly mission: string;
    readonly packageRoot: string;
    readonly planPath: string;
    readonly plan: string;
    readonly missionPath: string | null;
    readonly missionBody: string | null;
  }>;
  readonly readRuntimeSessions: () => Promise<readonly RuntimeSessionSelection[]>;
  readonly publish: (draft: {
    readonly type: AgentRuntimeEventV1["type"];
    readonly payload: Readonly<Record<string, unknown>>;
    readonly opId: string;
    readonly resultBody?: string;
  }) => Promise<{
    readonly event: AgentRuntimeEventV1;
    readonly receipt: JsonObject;
  }>;
  readonly archive: (archive: RuntimeDispatchArchive) => Promise<{ readonly outcome: string }>;
}

export interface RuntimeSpawnerInput {
  readonly repoId: string;
  readonly rootDir: string;
  readonly daemonGeneration: number;
  readonly runtimeNodeId?: string;
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
    },
    binding: RuntimeBinding,
  ) => Promise<{ readonly event?: AgentRuntimeEventV1; readonly receipt: JsonObject }>;
  readonly stream: Pick<AgentRuntimeStreamHub, "publish">;
  readonly now: () => string;
  readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
  readonly prepareLaunch: (
    instanceId: string,
    request: {
      readonly cwd: string;
      readonly prompt: string;
      readonly model?: string;
      readonly effort?: string;
      readonly fast?: boolean;
      readonly providerSessionId?: string;
      readonly permissionMode?: string;
    },
  ) => Promise<PreparedRuntimeLaunch>;
  readonly prepareWorkerGitEnvironment?: (instanceId: string) => Promise<NodeJS.ProcessEnv | null>;
  readonly resolveAgent?: (agentId: string) => RuntimeAgent;
  readonly resolveSquadDispatch?: (
    squadId: string | undefined,
    leaderId: string,
    workerId?: string,
  ) => SquadDispatchSelection;
  readonly launch?: RuntimeLauncher;
  readonly schedule: (work: () => void | Promise<void>, binding?: RuntimeBinding) => void;
  readonly onRuntimeOutcome?: (
    event: Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }>,
    schedule: TrustedScheduleRuntime | null,
  ) => void;
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
  ) => RuntimeBinding;
  /** Re-authorizes each local RuntimeSession catalog Action at its commit cut. */
  readonly authorizeRuntimeEvent?: (input: {
    readonly type: AgentRuntimeEventV1["type"];
    readonly payload: AgentRuntimeEventV1["payload"];
    readonly opId: string;
    readonly binding: RuntimeBinding;
  }) => RuntimeBinding;
  /** Re-authorizes a local terminal archive at the settlement cut. */
  readonly authorizeRuntimeArchive?: (archive: RuntimeDispatchArchive, binding: RuntimeBinding) => RuntimeBinding;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
}
