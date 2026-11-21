import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import type { DaemonHomeOverviewResult } from "./home/home-overview-types.ts";
import type { SquadControlResult } from "./squad-control-result.ts";
import {
  type AuthorizationDecision,
  type DaemonRepoMode,
  type FleetMetricsSnapshot,
  type RepoMetricsAggregates,
  type RepoMetricsSnapshot,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import type {
  AgentRuntimeAttachEvent,
  AgentRuntimeAttachSubscription,
  AgentRuntimeNativeSignal,
  AgentRuntimeWitnessBinding,
  AgentRuntimeWitnessToken,
} from "./agent-runtime-stream.ts";
import { type DaemonBuildStatus } from "./build-identity.ts";
import type { DaemonControlReceipt, TerminalAttachSubscription } from "./gui-s3-control.ts";
import { type DaemonGuiReadResultMap, type DaemonGuiRpcReadMethod } from "./protocol/daemon-protocol.contract.ts";
import type { DaemonStreamPayloadMap } from "./protocol/daemon-protocol-results.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { type RepoBootstrapRequest } from "./repo-bootstrap.ts";
import {
  type RepoCell,
  type RepoCellStatus,
  type RepoTaskAction,
  type RuntimeIngressAction,
} from "./repo-cell-types.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import type { RemoteProxyManager } from "./remote-proxy.ts";
import type { ManagedRbacRequest } from "@harness-anything/kernel";
import type {
  SkillEvalCaseDraft,
  SkillEvalCaseView,
  SkillEvalRunResult,
  SkillEvalRunner,
  SkillEvalSkill,
  SkillEvalVersionDraft,
} from "../runtime-engine/skill-eval-runner.ts";
import type { DaemonStorageConfig } from "@harness-anything/storage";
import type { RuntimeLauncher } from "./runtime-spawn-types.ts";
import type { RuntimeInstallationWitness } from "./agent-runtime-instances.ts";
import type { CredentialPort } from "./agent-runtime-credential-port.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";
import type { IdentitySessionPort, IdentityManagementPort } from "@harness-anything/kernel";
import type { RepoCellOpenInput } from "./repo-cell-types.ts";
import type { EdgeJoinSshTunnelManager } from "../fleet-sync/fleet/edge-join-ssh-tunnel.ts";
import type { createEdgeJoinStore } from "./fleet/edge-join.ts";
import type { SkillEvalProductionInput } from "./skill-eval-production.ts";

export interface DaemonHost {
  /** Platform skill-evaluation capability composed from daemon-owned policy and ports. */
  readonly skillEvalRunner: SkillEvalRunner;
  readonly skillEval: {
    readonly registerVersion: (
      auth: DaemonAuthenticationContext,
      draft: SkillEvalVersionDraft,
    ) => Promise<SkillEvalSkill>;
    readonly addCase: (
      auth: DaemonAuthenticationContext,
      skillId: string,
      draft: SkillEvalCaseDraft,
    ) => Promise<SkillEvalCaseView>;
    readonly listCases: (auth: DaemonAuthenticationContext, skillId: string) => Promise<readonly SkillEvalCaseView[]>;
    readonly run: (
      auth: DaemonAuthenticationContext,
      skillId: string,
      version: string,
      options: { readonly threshold?: number },
    ) => Promise<SkillEvalRunResult>;
  };
  readonly remoteProxy: RemoteProxyManager;
  readonly identityCenter: import("@harness-anything/kernel").IdentitySessionPort["center"];
  readonly readRepositoryMembers: (
    repoId: string,
    auth: DaemonAuthenticationContext,
  ) => Promise<Record<string, unknown>>;
  readonly unregisterFleetNode: (
    request: Extract<
      import("./fleet/command-protocol.ts").FleetFrameV1,
      { schema: "fleet.node.unregister/v1" }
    >["request"],
    actor: NonNullable<DaemonAuthenticationContext["oidcPrincipal"]>,
    assertSourceOpen: () => void,
    retainReply?: () => void,
  ) => Promise<Record<string, unknown>>;
  readonly sessionPrincipal: (
    auth: DaemonAuthenticationContext,
    method: string,
    params: JsonObject,
  ) => Promise<DaemonAuthenticationContext["oidcPrincipal"]>;
  readonly parkedWaitSignal: AbortSignal;
  readonly run: (
    repoId: string,
    action: RepoTaskAction,
    auth: DaemonAuthenticationContext,
  ) => Promise<WriteReceipt | SquadControlResult>;
  readonly presetRun: (
    repoId: string,
    action: RepoTaskAction,
    auth: DaemonAuthenticationContext,
  ) => ReturnType<RepoCell["presetRun"]>;
  readonly replica: (repoId: string) => RepoCell["replica"] & {
    readonly backup: NonNullable<RepoCell["fleetBackup"]>;
  };
  /** Replication-log retention for a center repository, on its single writer. */
  readonly pruneReplicationLog: (repoId: string, beforeSequence: number) => Promise<void>;
  readonly settleMaterialization: (repoId: string, context: string) => Promise<void>;
  readonly read: <M extends DaemonGuiRpcReadMethod>(
    repoId: string,
    method: M,
    payload: Readonly<Record<string, unknown>>,
    auth: DaemonAuthenticationContext,
  ) => Promise<DaemonGuiReadResultMap[M]>;
  readonly readDispatchLifecycle: (
    repoId: string,
    query: import("@harness-anything/kernel").DispatchLifecycleQuery,
    auth: DaemonAuthenticationContext,
  ) => Promise<import("@harness-anything/kernel").DispatchLifecycleRead>;
  readonly readNodeAutoClaimCandidates: (
    repoId: string,
    auth: DaemonAuthenticationContext,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly readNodeAutoDispatchCandidates: (
    repoId: string,
    auth: DaemonAuthenticationContext,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly attach: (
    repoId: string,
    runtimeSessionId: string,
    afterCursor: import("./protocol/stream-contract.ts").RuntimeStreamCursor | undefined,
    auth: DaemonAuthenticationContext,
  ) => Promise<AgentRuntimeAttachSubscription>;
  readonly spawnRuntime: (
    repoId: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly cancelRuntime: (
    repoId: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly steerRuntime: (
    repoId: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly handoffRuntime: (
    repoId: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly batchRuntime: (
    repoId: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly awaitRuntimeSessions: (
    repoId: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly runtimeIngress: (
    repoId: string,
    action: RuntimeIngressAction,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  /** Evaluates one repository action for the transport's principal without executing it. */
  readonly authorize: (
    repoId: string,
    kind: string,
    auth: DaemonAuthenticationContext,
    target?: { readonly taskId: string },
  ) => Promise<AuthorizationDecision>;
  readonly terminalAttach: (
    repoId: string,
    payload: DaemonStreamPayloadMap["repo.terminal.attach"],
    auth: DaemonAuthenticationContext,
  ) => Promise<TerminalAttachSubscription>;
  readonly terminalAction: (
    repoId: string,
    method: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly runtimeInstanceAuth: (
    repoId: string,
    method: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly system: (auth: DaemonAuthenticationContext) => JsonObject;
  readonly home: (auth: DaemonAuthenticationContext) => Promise<DaemonHomeOverviewResult>;
  readonly runtimeInstance: (
    method: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
    repoId?: string,
  ) => Promise<JsonObject>;
  readonly decisionProvider: (
    method: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly requestControl: (payload: JsonObject, auth: DaemonAuthenticationContext) => Promise<DaemonControlReceipt>;
  readonly controlReceipt: (operationId: string, auth: DaemonAuthenticationContext) => DaemonControlReceipt;
  readonly issueRuntimeWitness: (
    repoId: string,
    runtimeSessionId: string,
    auth: DaemonAuthenticationContext,
  ) => Promise<AgentRuntimeWitnessToken>;
  readonly bindRuntimeWitness: (repoId: string, token: string) => AgentRuntimeWitnessBinding;
  readonly publishRuntimeWitness: (
    repoId: string,
    token: string,
    signal: AgentRuntimeNativeSignal,
  ) => AgentRuntimeAttachEvent;
  readonly bootstrap: (
    request: RepoBootstrapRequest,
    auth: DaemonAuthenticationContext,
  ) => Promise<Record<string, unknown>>;
  readonly manageRbac: (
    request: ManagedRbacRequest,
    auth: DaemonAuthenticationContext,
  ) => Promise<Record<string, unknown>>;
  readonly admin: (
    request:
      | {
          readonly kind: "register";
          readonly rootDir?: string;
          readonly repoId: string;
          readonly displayName?: string;
          readonly mode?: DaemonRepoMode;
          readonly endpoint?: string;
          readonly connectionId?: string;
        }
      | {
          readonly kind: "update";
          readonly repoId: string;
          readonly rootDir?: string;
          readonly displayName?: string;
          readonly mode?: DaemonRepoMode;
          readonly endpoint?: string;
          readonly connectionId?: string;
          readonly state?: OperationalStatus.RepoRegistrationState;
        }
      | { readonly kind: "unbind"; readonly repoId: string }
      | { readonly kind: "backup"; readonly rootDir: string; readonly backupDir: string }
      | {
          readonly kind: "restore-drill";
          readonly rootDir: string;
          readonly backupDir: string;
          readonly shadowParent?: string;
        }
      | {
          readonly kind: "purge";
          readonly repoId: string;
          readonly scope: "cache" | "all";
          readonly backup?: string;
          readonly confirm?: string;
        }
      | {
          readonly kind: "connection-register";
          readonly connectionId?: string;
          readonly displayName?: string;
          readonly endpoint: string;
        }
      | {
          readonly kind: "connection-update";
          readonly connectionId: string;
          readonly displayName?: string;
          readonly endpoint?: string;
          readonly state?: OperationalStatus.RepoRegistrationState;
        }
      | { readonly kind: "connection-unregister"; readonly connectionId: string }
      | { readonly kind: "connection-probe"; readonly endpoint: string },
    auth: DaemonAuthenticationContext,
  ) => Promise<Record<string, unknown>>;
  readonly fleet: {
    readonly startCenter: (payload: JsonObject, auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
    readonly readCenterExternalAddress: (auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
    readonly readCenterState: (auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
    readonly setCenterExternalAddress: (
      payload: JsonObject,
      auth: DaemonAuthenticationContext,
    ) => Promise<Record<string, unknown>>;
    readonly edgeSync: (payload: JsonObject, auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
    readonly edgeRuntime: (payload: JsonObject, auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
  };
  readonly status: () => {
    readonly daemonId: string;
    readonly pid: number;
    readonly startedAt: string;
    readonly entry: DaemonBuildStatus["entry"];
    readonly build: Omit<DaemonBuildStatus, "entry"> & { readonly version: string };
    readonly connections: readonly {
      readonly id: string;
      readonly kind: "local" | "remote-endpoint" | "fleet-center";
      readonly displayName: string;
      readonly state: OperationalStatus.RepoRegistrationState;
      readonly endpoint?: string;
    }[];
    readonly repos: readonly RepoCellStatus[];
    readonly fleetVersionWarnings?: readonly string[];
    readonly summary: string;
  };
  /** Lightweight queue snapshot from loaded cells only; no registry/build/cell re-read. */
  readonly writeQueues: () => readonly { readonly repoId: string; readonly queueDepth: number | null }[];
  /** Pure in-memory O(1) observability snapshot for Prometheus scrapes; zero registry, cell polling, or DB scans. */
  readonly observabilitySnapshot: () => {
    readonly repos: readonly RepoMetricsSnapshot[];
    readonly repoAggregates: RepoMetricsAggregates;
    readonly fleet: FleetMetricsSnapshot;
  };
  /** Pure in-memory readiness probe judgment separating process liveness from service readiness. */
  readonly probeSnapshot: () => {
    readonly ready: boolean;
    readonly reasons: readonly string[];
  };
  readonly configureNodeAutoClaim: (policy: unknown, auth: DaemonAuthenticationContext) => Promise<JsonObject>;
  readonly pendingFleetDeliveries: () => number;
  readonly startAttachments: () => void;
  readonly attachmentsSettled: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface DaemonHostOpenInput {
  readonly storage?: Readonly<Record<string, DaemonStorageConfig>>;
  /** Optional strict storage backend policy (defaults to HARNESS_STORAGE_BACKEND env when set). */
  readonly requiredStorageBackend?: import("@harness-anything/storage").StorageBackend;
  readonly daemonId: string;
  readonly userRoot: string;
  readonly endpoint?: string;
  readonly startedAt?: string;
  readonly now?: () => string;
  readonly runtimeLaunch?: RuntimeLauncher;
  readonly runtimeInstanceCapacities?: Readonly<Record<string, number>>;
  readonly runtimeDiscover?: () =>
    | readonly RuntimeInstallationWitness[]
    | Promise<readonly RuntimeInstallationWitness[]>;
  readonly runtimeEnv?: NodeJS.ProcessEnv;
  /** Reads the operator's GitHub token for a launch; tests substitute it so no host login is read. */
  readonly runtimeGithubToken?: (environment: NodeJS.ProcessEnv) => Promise<string | null>;
  readonly runtimeCredentialPort?: CredentialPort;
  readonly authenticateExecutionPrincipal?: (
    credential: string,
  ) => Promise<import("./runtime-execution-credential.ts").RuntimeExecutionPrincipal>;
  readonly runtimeFile?: string;
  /** Enables O(1) in-memory tracked repo metrics instrumentation (disabled by default when metrics are off). */
  readonly metricsEnabled?: boolean;
  /** When true, /readyz requires external/managed identity configuration to be present before advertising ready. */
  readonly requireIdentityReady?: boolean;
  /** Minimum interval (ms) between live upstream OIDC re-verifications while already ready (default 10000). */
  readonly identityReadyReverifyIntervalMs?: number;
  readonly shutdownRequested?: () => boolean;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
  readonly buildDraining?: () => boolean;
  readonly onRepoStatusChange?: () => void;
  /** One persisted transport record per completed request, shared with local JSON-RPC traffic. */
  readonly recordTraffic?: (entry: import("./conn-log.ts").DaemonTrafficLogEntry) => void;
  /** Tracks in-flight Fleet center RPC requests alongside local Unix JSON-RPC requests. */
  readonly onFleetRequestStarted?: () => void;
  readonly onFleetRequestSettled?: () => void;
  /** The daemon's one OIDC session service; the transport binds requests through the same instance. */
  readonly oidc?: IdentitySessionPort;
  /** The managed identity center's lifecycle; a hermetic host substitutes it to stage its resume. */
  readonly managedRbac?: Pick<IdentityManagementPort, "run" | "resume" | "stop" | "loginListenerCertificate">;
  readonly attachTimeoutMs?: number;
  readonly openCell?: (
    input: RepoCellOpenInput & { readonly onStatus?: (status: RepoCellStatus) => void },
  ) => Promise<RepoCell>;
  readonly sshTunnels?: EdgeJoinSshTunnelManager;
  readonly edgeJoins?: ReturnType<typeof createEdgeJoinStore>;
  /** Optional deployment overrides; the daemon composes the default catalog, policy, runtime and slot queue. */
  readonly skillEval?: Omit<SkillEvalProductionInput, "userRoot" | "runner">;
  /** Test/deployment replacement for the composed runner. */
  readonly skillEvalRunner?: SkillEvalRunner;
}
