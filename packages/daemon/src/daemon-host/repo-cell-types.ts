import type { RepoCellCore } from "./repo-cell.ts";
import type { SquadControlResult } from "./squad-control-result.ts";
import type { makeTaskLifecycleService } from "@harness-anything/application/internal/task-lifecycle-service";
import type {
  ActorIdentity,
  AgentRuntimeEventV1,
  AuthorizationDecision,
  CanonicalEventCut,
  CanonicalEventStore,
  DaemonRepoMode,
  DelegatedExecutionToken,
  MaterializationHealth,
  WriteReceipt,
  WriteReceiptDraft,
  WriteSource,
  TaskClaimant,
  DaemonRegistryRepo,
  CanonicalEventAppendReceipt,
  EventPublicationKillpoint,
  HarnessLayout,
  LocalSettingsV1,
  RepositorySettingsV1,
  SettingsV1,
  TaskProjection,
  assertCurrentWriter,
} from "@harness-anything/kernel";
import type { PresetRunReceiptV1, createPresetProcessService } from "@harness-anything/preset";
import type { AgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import type { RuntimeDispatchArchive } from "./doc-sync-actions.ts";
import type { FleetRuntimeDispatchContext } from "./fleet/command-protocol.ts";
import type { openGuiCatalog } from "./gui-catalog.ts";
import type {
  DaemonRepoAttachProgress,
  DaemonGuiReadMethod,
  DaemonGuiReadPayloadMap,
  DaemonGuiReadResultMap,
  ObserveTailResult,
  CanonicalRoot,
} from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RepoBootstrapReceipt } from "./repo-bootstrap.ts";
import type { TerminalHost, TrustedTerminalLaunch } from "./terminal-host.ts";
import type { KeycloakCenterAuthority } from "./transport/auth-context.ts";
import type { WriterEpochFenceDescriptor, createLedgerBackup } from "@harness-anything/storage";
import type { NodeTaskMaterializationPolicy } from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
import type { runTaskActionCatalogRuntime as lifecycleActionImpl } from "./task-action-catalog-runtime.ts";
import type { decisionProposalAction, taskCreateAction } from "./repo-cell-action-parse.ts";
import type { buildCommand, withServerMeta } from "./repo-cell-command.ts";
import type {
  completionKillpoint as completionKillpointImpl,
  publishGateWitness as publishGateWitnessImpl,
} from "./repo-cell-completion.ts";
import type { errorOperationId, publishGeneratedArtifact } from "./repo-cell-errors.ts";
import type { decodeEvidencePayload } from "@harness-anything/application/internal/queries/evidence-payload.ts";
import type { renderEvidencePayload } from "@harness-anything/application/internal/queries/repo-cell-evidence.ts";
import type {
  completeRetryCommand,
  explicitExecutionId,
  uniqueDerivedExecutionId,
} from "./repo-cell-execution-selection.ts";
import type { lifecycleReceipt, workspaceText } from "./repo-cell-packets.ts";
import type { createTaskId, operationId, proofFor, receiptProof, withoutDryRun } from "./repo-cell-proof.ts";
import type {
  canonicalSettlement as canonicalSettlementImpl,
  progressReceipt as progressReceiptImpl,
  projectedTaskIds as projectedTaskIdsImpl,
  receiptForOperation as receiptForOperationImpl,
} from "./repo-cell-receipts.ts";
import type { legacyReviewLint } from "./repo-cell-review-lint.ts";
import type { appendAuxiliaryRuntimeIngress as appendAuxiliaryRuntimeIngressImpl } from "./repo-cell-runtime-ingress.ts";
import type {
  cellStringList,
  completionApplied,
  completionSettlement,
  completionStopped,
  failed,
  progressEvidence,
  projectionReady,
  rejected,
  requiredCellText,
} from "./repo-cell-settlement.ts";
import type {
  runTaskCommandWithDocs as runTaskCommandWithDocsImpl,
  taskSurfaceWrite as taskSurfaceWriteImpl,
} from "./repo-cell-task-command-docs.ts";
import type { taskMutation as taskMutationImpl } from "./repo-cell-task-mutation.ts";
import type { assertTaskTransitionDocumentReady } from "./transition-document-access.ts";
import type {
  createTask as createTaskImpl,
  previewResult as previewResultImpl,
  upgradePresetSnapshot as upgradePresetSnapshotImpl,
  withHumanSummary as withHumanSummaryImpl,
} from "./repo-cell-task-create.ts";
import type {
  archiveTasks as archiveTasksImpl,
  upsertEntity as upsertEntityImpl,
  migrateTaskContracts as migrateTaskContractsImpl,
  supersedeWithNewTask as supersedeWithNewTaskImpl,
} from "./repo-cell-task-maintenance.ts";
import type {
  appendProgress as appendProgressImpl,
  completeTask as completeTaskImpl,
  completionContext as completionContextImpl,
} from "./repo-cell-task-progress.ts";
import type {
  assertTaskWipCapacity as assertTaskWipCapacityImpl,
  listRelations as listRelationsImpl,
  listTasks as listTasksImpl,
  reviewTask as reviewTaskImpl,
  taskReadSet as taskReadSetImpl,
  taskWipEnteringAction as taskWipEnteringActionImpl,
  wipSnapshotEntries as wipSnapshotEntriesImpl,
  TaskQueryCell,
} from "./repo-cell-task-query.ts";
import type { graphView as graphViewImpl } from "@harness-anything/application/internal/queries/repo-cell-graph-view.ts";
import type {
  listEvents as listEventsImpl,
  showEvent as showEventImpl,
} from "@harness-anything/application/internal/queries/repo-cell-event-query.ts";
import type { makeSquadCoordinator } from "./squad-coordinator.ts";
import type {
  EntityActionCatalogRuntimes,
  makeEntityActionCatalogExecutor,
} from "@harness-anything/application/internal/commands/entity-action-catalog-executor.ts";
import type { makeRuntimeSpawner } from "./runtime-spawn.ts";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import type { makeRecoveryProbe } from "./recovery-state.ts";
import type { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import type { DaemonStorageConfig, makeTaskEventStore } from "@harness-anything/storage";
import type { WorkspaceId } from "./protocol/daemon-protocol.contract.ts";
import type { RuntimeLauncher, RuntimeDaemonRoute, RuntimeAttemptTerminal } from "./runtime-spawn-types.ts";
import type { RuntimeOperatorSession } from "./runtime-online-binding.ts";
import type { RuntimeLaunchRequest, PreparedRuntimeLaunch } from "./agent-runtime-instances.ts";
import type { RepoBootstrapInput } from "./repo-bootstrap.ts";
import type { AgentRuntimeNativeSignal } from "./agent-runtime-stream.ts";
import type { DaemonLifecycleRecorder } from "./lifecycle-log.ts";

export type RepoTaskAction = Readonly<Record<string, unknown>> & {
  readonly kind: string;
};

/** A continuation enters the writer as its own command, not as the completed parent command. */
export type RepoCellContinuationWrite = (
  action: RepoTaskAction,
  binding: RepoCellBinding,
  execute?: (authorizedBinding: RepoCellBinding) => Promise<WriteReceiptDraft>,
) => Promise<WriteReceiptDraft>;

export type RepoCellAutoClaimRelation = Extract<
  DaemonGuiReadResultMap["repo.triadic.relationGraph"],
  { readonly facet: "edges" }
>["edges"][number];

export interface RepoCellAutoClaimAssignment {
  readonly relation: RepoCellAutoClaimRelation;
  readonly assignedByPersonId: string | null;
}

export interface RepoCellBinding {
  /** Git candidate names observed before entering the local document write turn. */
  readonly observedDocGitPaths?: readonly string[] | null;
  /** Worker-local session lifetime; stripped at every transport/persistence boundary. */
  readonly retainAuthorization?: () => () => void;
  /** Daemon-established node identity for references to host-local files; never accepted from the Action. */
  readonly sourceNodeId?: string;
  readonly executionPrincipal?: import("./runtime-execution-credential.ts").RuntimeExecutionPrincipal;
  /** Resolve a declared Artifact kind name to its stable `entity-kind/KND-…` identity at this turn. */
  readonly artifactKindResolver?: (kind: string) => string | null;
  /** Online directory facts resolved inside the center writer, never accepted from transport. */
  readonly taskClaimant?: TaskClaimant;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  /** Established exclusively by the daemon local socket boundary for host-resident actions. */
  readonly daemonSocketOwner?: true;
  readonly sessionEnvironment?: Readonly<Record<string, string | undefined>>;
  /**
   * Daemon-established material for online Keycloak evaluation; never accepted from action payloads. A
   * signed-in person must match the actor and pass user-token authorization; when center authority
   * is present, its realm must also authorize that same person.
   */
  readonly keycloakAuthorization?: {
    /** Center-created proof that a machine token was bound to this node and owner for replica reads. */
    readonly fleetReplicaPrincipal?: { readonly nodeId: string; readonly personId: string; readonly expiresAt: number };
    readonly session?: {
      readonly provider: import("@harness-anything/kernel").AuthorizationDecisionPort &
        Pick<
          import("@harness-anything/kernel").AuthorizationProvider,
          "policyRef" | "authority" | "deniedReasonCode" | "withFetchPort"
        >;
      readonly currentAccessToken?: () => Promise<string>;
      readonly personId: string;
      readonly accessToken: string;
      readonly azp?: string;
      readonly scopes?: readonly string[];
      readonly url: string;
      readonly realm: string;
      readonly clientId: string;
      readonly certificate?: string;
      readonly servername?: string;
    };
    readonly center?: KeycloakCenterAuthority;
  };
  /**
   * Center-verified DelegatedExecutionToken covering the one Action currently executing; resolved from the
   * repository-private delegation record together with the issuer actor, never supplied by transport.
   */
  readonly delegatedExecutionToken?: DelegatedExecutionToken;
  /** Center-issued decision for the one Action currently executing; transport never supplies this. */
  readonly authorizationDecision?: AuthorizationDecision;
  /** Keycloak-resolved Person identity and per-action decisions prepared before a synchronous read cut. */
  readonly personExplanation?: {
    readonly existsIds: ReadonlySet<string>;
    readonly decisions: ReadonlyMap<string, AuthorizationDecision>;
  };
  /** Keycloak user IDs resolved at the writer cut for Person endpoints used by this Action. */
  readonly personIdentityWitnesses?: ReadonlyMap<string, string>;
  readonly explanationDecisions?: ReadonlyMap<string, AuthorizationDecision>;
  readonly writerEpoch?: number;
  readonly withWriterEpochFence?: <T>(operation: () => T) => T;
  readonly writerEpochFence?: WriterEpochFenceDescriptor;
}

export type RuntimeIngressAction =
  | {
      readonly kind: "event";
      readonly type: AgentRuntimeEventV1["type"];
      readonly payload: Readonly<Record<string, unknown>>;
      readonly opId: string;
      readonly resultBody?: string;
      readonly dispatchContext?: FleetRuntimeDispatchContext;
    }
  | { readonly kind: "archive"; readonly archive: RuntimeDispatchArchive };

export interface ReplicaCutSource {
  readonly kick: () => void;
  readonly close: () => void;
  readonly ledgerCut: () => { readonly repoId: string; readonly revision: number; readonly headDigest: string } | null;
}

export interface RepoCellFleetBackupInput {
  readonly directory: string;
  readonly writerEpochFence: NonNullable<RepoCellBinding["writerEpochFence"]>;
  readonly mode?: import("@harness-anything/storage").BaseBackupMode;
}

export type TaskCreateReceipt = WriteReceiptDraft & {
  readonly summary: string;
  readonly taskId: string;
  readonly taskStatus: "planned";
  readonly packagePath: string;
  /** The same package address relative to the workspace root; CLI receipts print this spelling. */
  readonly workspacePackagePath?: string;
  readonly generatedPaths: readonly string[];
  readonly presetDigest: string;
  readonly scaffoldDigest: string;
  readonly presetId: string;
  readonly profileId: string;
  readonly outputShape: string;
  readonly completionGates: readonly string[];
  readonly commitSha: string | null;
  readonly dryRun: boolean;
  readonly next?: readonly { readonly command: string; readonly reason?: string }[];
};

export type TaskProgressReceipt = WriteReceiptDraft & {
  readonly summary: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly progressPath: string;
  readonly eventId: string;
  readonly commitSha: string | null;
  readonly cut: CanonicalEventCut;
  readonly worktreeVisible: true;
};

export type RepoCellAttachProgress = DaemonRepoAttachProgress;

/** The write that currently owns the repository's single-write chain. */
export interface RepoCellWriteQueueHead {
  /** The writer request that owns this turn; null for daemon-internal work such as a builtin run. */
  readonly requestId: string | null;
  /** The command or builtin label this turn belongs to. */
  readonly command: string;
  /** Milliseconds the head had already been executing when the waiting request was appended. */
  readonly executingMs: number;
}

/** Label a queued write turn carries while it is the head, so waiters can name what blocked them. */
export interface RepoCellWriteQueueLabel {
  readonly requestId: string | null;
  readonly command: string;
}

export interface RepoCellWriteQueueEntry {
  readonly label: RepoCellWriteQueueLabel;
  /** Process-monotonic append time; a queued turn that has not started yet still blocks later appends. */
  readonly appendedAtMs: number;
  startedAtMs?: number;
}

export interface RepoCellWriteQueueState {
  /** Appended turns not settled yet, oldest first; index 0 is the head a new append waits behind. */
  readonly waiting: RepoCellWriteQueueEntry[];
  /** Process-monotonic milliseconds; injected so queue tests do not read the wall clock. */
  readonly nowMs: () => number;
}

/** Filled by the queue at the first append: the head live when this request started waiting. */
export interface RepoCellQueueObservation {
  readonly label: RepoCellWriteQueueLabel;
  head?: RepoCellWriteQueueHead | null;
}

export interface RepoCellStatus {
  readonly repoId: string;
  readonly rootDir: string;
  readonly mode: DaemonRepoMode | null;
  readonly state: OperationalStatus.RepoCellAttachmentState;
  /** A verified source generation can retain completed reads while writes are latched. */
  readonly projectionReadable?: boolean;
  readonly generation: number | null;
  readonly queueDepth: number | null;
  readonly projectionWatermark?: number;
  readonly ledgerRevision?: number;
  readonly lastError: string | null;
  readonly causeClass: "data-shape" | "infrastructure" | "projection" | null;
  readonly recoveryMs: number | null;
  readonly materialization: MaterializationHealth | null;
  readonly receiptFollowers?: ReturnType<CanonicalEventStore["followerStatus"]>;
  readonly attach?: RepoCellAttachProgress;
}

export interface RepoInFlightWork {
  readonly kind: "runtime-session" | "task-lease" | "publication" | "schedule-occurrence";
  readonly id: string;
  readonly taskId?: string;
  readonly executionId?: string;
  readonly phase?: string;
  readonly holder?: string;
  readonly scheduleId?: string;
  readonly runtimeSessionId?: string;
  readonly nodeId?: string;
  readonly queueDepth?: number;
  readonly nextAction: string;
}

export type RepoCellReadMethod = Exclude<
  DaemonGuiReadMethod,
  | "repo.tasks.claimable"
  | "repo.tasks.assignmentDirectory"
  | "daemon.gui.system.read"
  | "daemon.gui.home.read"
  | "daemon.gui.control.receipt"
  | "repo.gui.catalog.snapshot"
  | "repo.gui.catalog.preset.read"
  | "repo.terminal.sessions.list"
>;

export type RepoCellTerminal = Omit<TerminalHost, "spawn" | "spawnTrusted" | "input" | "resize" | "terminate"> & {
  readonly spawn: (payload: JsonObject, binding: RepoCellBinding) => ReturnType<TerminalHost["spawn"]>;
  readonly spawnTrusted: (
    input: TrustedTerminalLaunch,
    binding: RepoCellBinding,
  ) => ReturnType<TerminalHost["spawnTrusted"]>;
  readonly input: (payload: JsonObject, binding: RepoCellBinding) => ReturnType<TerminalHost["input"]>;
  readonly resize: (payload: JsonObject, binding: RepoCellBinding) => ReturnType<TerminalHost["resize"]>;
  readonly terminate: (payload: JsonObject, binding: RepoCellBinding) => ReturnType<TerminalHost["terminate"]>;
};

export interface RepoCell {
  /** Settlement authority for the occurrence's linked dispatch, read from its accepted subject. */
  readonly scheduleOccurrenceSettlementOwner: (
    dispatchId: string | undefined,
  ) => Promise<"runtime-attempt" | "squad-coordinator">;
  readonly hasBuiltinExecutor: (claimFence: string) => Promise<boolean>;
  readonly bootstrapReceipt?: RepoBootstrapReceipt;
  readonly run: (
    action: RepoTaskAction,
    binding: RepoCellBinding,
    signal?: AbortSignal,
    onExecutionStart?: () => void,
    queueObservation?: RepoCellQueueObservation,
  ) => Promise<WriteReceipt | SquadControlResult>;
  readonly presetRun: (
    action: RepoTaskAction,
    binding: RepoCellBinding,
    onSettled?: () => void,
    queueObservation?: RepoCellQueueObservation,
  ) => Promise<PresetRunReceiptV1>;
  readonly spawnRuntime: (
    payload: JsonObject,
    binding: RepoCellBinding,
    queueObservation?: RepoCellQueueObservation,
    onExecutionStart?: () => void,
  ) => Promise<JsonObject>;
  readonly handoffRuntime: (
    payload: JsonObject,
    binding: RepoCellBinding,
    queueObservation?: RepoCellQueueObservation,
    onExecutionStart?: () => void,
  ) => Promise<JsonObject>;
  readonly cancelRuntime: (
    payload: JsonObject,
    binding: RepoCellBinding,
    queueObservation?: RepoCellQueueObservation,
    onExecutionStart?: () => void,
  ) => Promise<JsonObject>;
  readonly steerRuntime: (
    payload: JsonObject,
    binding: RepoCellBinding,
    queueObservation?: RepoCellQueueObservation,
    onExecutionStart?: () => void,
  ) => Promise<JsonObject>;
  /** Resolves when the session's projected outcome is settled per the domain settle predicate. */
  readonly awaitRuntimeOutcome: (runtimeSessionId: string) => Promise<void>;
  /** Resolves on the next runtime signal/outcome notification or the settlement grace backstop. */
  readonly runtimeSignalVersion: () => number;
  readonly awaitRuntimeSignal: (observedVersion?: number) => Promise<void>;
  readonly runtimeIngress: (
    action: RuntimeIngressAction,
    binding: RepoCellBinding,
    queueObservation?: RepoCellQueueObservation,
    onExecutionStart?: () => void,
  ) => Promise<JsonObject>;
  readonly catalog: ReturnType<typeof openGuiCatalog>;
  readonly terminal: RepoCellTerminal;
  readonly read: <M extends RepoCellReadMethod>(
    method: M,
    payload?: Readonly<Record<string, unknown>>,
    binding?: RepoCellBinding,
    signal?: AbortSignal,
  ) => Promise<DaemonGuiReadResultMap[M]>;
  readonly readDispatchLifecycle: (
    query: import("@harness-anything/kernel").DispatchLifecycleQuery,
    signal?: AbortSignal,
  ) => Promise<import("@harness-anything/kernel").DispatchLifecycleRead>;
  /** Canonical actor witness for an event revision; used by local policy decisions. */
  readonly readEventWitness: (
    revision: number,
  ) => Promise<ReturnType<import("@harness-anything/kernel").TaskProjection["readEventWitness"]>>;
  /** Assignment edges and actor witnesses read from one authorized projection cut. */
  readonly readNodeAutoClaimAssignments: (
    binding: RepoCellBinding,
    signal?: AbortSignal,
  ) => Promise<readonly RepoCellAutoClaimAssignment[]>;
  readonly readNodeAutoDispatchCandidates?: (
    nodeId: string,
    signal?: AbortSignal,
  ) => Promise<readonly import("./node-auto-dispatch.ts").NodeAutoDispatchCandidate[]>;
  readonly workspaceSummary: () => Promise<DaemonGuiReadResultMap["repo.workspace.summary.read"]>;
  readonly workspaceScope: (
    payload: DaemonGuiReadPayloadMap["repo.workspace.scope.read"],
  ) => Promise<DaemonGuiReadResultMap["repo.workspace.scope.read"]>;
  readonly observeTail: (
    payload: unknown,
    daemon: { readonly userRoot: string; readonly daemonId: string },
    binding?: RepoCellBinding,
    signal?: AbortSignal,
  ) => Promise<ObserveTailResult>;
  readonly replica: ReplicaCutSource;
  readonly verifyReadiness: () => Promise<{
    readonly cellState: "attached";
    readonly l2State: "ready";
  }>;
  readonly attach: AgentRuntimeStreamHub["attach"];
  readonly runtime: Pick<AgentRuntimeStreamHub, "publish" | "issueWitnessToken" | "bindWitness">;
  readonly status: () => RepoCellStatus;
  readonly statusCuts: () => Pick<RepoCellStatus, "projectionWatermark" | "ledgerRevision"> | null;
  readonly inFlightWork: () => Promise<readonly RepoInFlightWork[]>;
  /** Waits for the event-derived Git follower while the caller's writer epoch is current. */
  readonly settlePendingMaterialization: (context: string) => Promise<void>;
  readonly backup?: (
    input: {
      readonly kind: "backup" | "drill";
      readonly backupDir: string;
      readonly shadowParent?: string;
      readonly registration: DaemonRegistryRepo;
      readonly writerEpoch: number;
    },
    queueObservation?: RepoCellQueueObservation,
  ) => Promise<
    ReturnType<typeof createLedgerBackup> | Awaited<ReturnType<typeof import("./repo-all-purge.ts").drillRepoBackup>>
  >;
  /** Replication-log retention, run on this repository's single write chain. */
  readonly pruneReplicationLog?: (beforeSequence: number, queueObservation?: RepoCellQueueObservation) => Promise<void>;
  /** Pins the replication snapshot on the write chain; waits for its archive outside that chain. */
  readonly fleetBackup?: (
    input: RepoCellFleetBackupInput,
    signal?: AbortSignal,
    queueObservation?: RepoCellQueueObservation,
  ) => Promise<import("@harness-anything/storage").BaseBackupArchive>;
  /** Internal idle retirement; false leaves background work running. */
  readonly hibernate?: () => Promise<boolean>;
  readonly close: () => Promise<void>;
}

export type DaemonGuiReadHandlers = {
  readonly [M in RepoCellReadMethod]: (
    payload: Readonly<Record<string, unknown>>,
    binding?: RepoCellBinding,
  ) => DaemonGuiReadResultMap[M];
};

export type Snapshot = Awaited<ReturnType<ReturnType<typeof makeTaskLifecycleService>["read"]>>["snapshot"];

export type PublicPublication = {
  readonly commitSha: string | null;
  readonly cut: CanonicalEventCut;
};

/** Fallback execution-lease TTL when a lease command carries no explicit ttlMs (consumed by
 * task-action-catalog-runtime and repo-cell-proof). Same 24h magnitude as the `tasks.assignmentTtlMs`
 * setting default, but the two are separate authorities — assignment expiry vs execution lease —
 * and this constant deliberately does not derive from that setting: lease duration is a fleet
 * concurrency-safety parameter (how long a dead holder blocks the task), not an operator knob. */
export const leaseTtlMs = 24 * 60 * 60 * 1_000;

type Bound<Implementation> = Implementation extends (context: infer Context, ...args: infer Args) => infer Result
  ? Context extends object
    ? (...args: Args) => Result
    : never
  : never;

/** The settings value an absent entity would be minted with, and the authored bytes it comes from. */
export interface AuthoredSettingsInitialization {
  readonly settings: SettingsV1;
  readonly repository: RepositorySettingsV1;
  readonly documentBody: string;
  readonly candidateDocumentBody: string;
}

export interface RepoCellSettingsState {
  /** `ha init`'s mint. It may seed a defaults local file, and only when the machine has none yet. */
  readonly initializeBootstrap: (
    settings: SettingsV1,
    documentBody: string,
    binding: RepoCellBinding,
  ) => ReturnType<CanonicalEventStore["append"]> | null;
  /** The write path's mint: repository settings only, never this machine's preferences file. */
  readonly initializeAuthored: (
    initialization: AuthoredSettingsInitialization,
    binding: RepoCellBinding,
  ) => ReturnType<CanonicalEventStore["append"]> | null;
  /**
   * The mint a write request would perform, resolved without writing: the request is judged against
   * this value first so a rejected request appends no event. `null` when the entity already exists.
   */
  readonly authoredInitialization: () => AuthoredSettingsInitialization | null;
  readonly read: () => SettingsV1;
  readonly readLocal: () => LocalSettingsV1;
  readonly readRepository: () => RepositorySettingsV1;
  readonly writeLocal: (value: LocalSettingsV1) => boolean;
}

export interface RepoCellActionContext extends TaskQueryCell {
  readonly projection: TaskProjection;
  /** The resolved layout for this repository, so receipt translation never re-reads harness.yaml. */
  readonly layout: HarnessLayout;
  readonly store: CanonicalEventStore;
  readonly input: {
    readonly repoId: string;
    readonly nodeTaskMaterializationPolicy?: NodeTaskMaterializationPolicy;
    readonly runtimeDaemonRoute?: import("./runtime-spawn.ts").RuntimeDaemonRoute;
    readonly killpoint?: (point: EventPublicationKillpoint) => void;
    readonly shouldStop?: () => boolean;
    readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
    readonly runtimeInstanceCapacities?: Readonly<Record<string, number>>;
    readonly prepareDaemonGitEnvironment?: (
      instanceId: string,
      provider: "github" | "gitlab",
      repoId: string,
    ) => Promise<NodeJS.ProcessEnv | null>;
  };
  readonly appendAuxiliaryRuntimeIngress: Bound<typeof appendAuxiliaryRuntimeIngressImpl>;
  readonly requiredCellText: typeof requiredCellText;
  readonly now: () => string;
  readonly operationId: typeof operationId;
  readonly receiptForOperation: Bound<typeof receiptForOperationImpl>;
  readonly listTasks: Bound<typeof listTasksImpl>;
  readonly listRelations: Bound<typeof listRelationsImpl>;
  readonly listEvents: Bound<typeof listEventsImpl>;
  readonly showEvent: Bound<typeof showEventImpl>;
  readonly reviewTask: Bound<typeof reviewTaskImpl>;
  readonly taskReadSet: Bound<typeof taskReadSetImpl>;
  readonly graphView: Bound<typeof graphViewImpl>;
  readonly publishGeneratedArtifact: typeof publishGeneratedArtifact;
  readonly entityActionExecutor: ReturnType<typeof makeEntityActionCatalogExecutor>;
  readonly entityActionRuntimes: EntityActionCatalogRuntimes;
  readonly decisionProposalAction: typeof decisionProposalAction;
  readonly upgradePresetSnapshot: Bound<typeof upgradePresetSnapshotImpl>;
  readonly upsertEntity: Bound<typeof upsertEntityImpl>;
  readonly taskWipEnteringAction: Bound<typeof taskWipEnteringActionImpl>;
  readonly assertTaskWipCapacity: Bound<typeof assertTaskWipCapacityImpl>;
  readonly createTask: Bound<typeof createTaskImpl>;
  readonly taskCreateAction: typeof taskCreateAction;
  readonly runTaskCommandWithDocs: Bound<typeof runTaskCommandWithDocsImpl>;
  readonly assertTaskTransitionDocumentReady: typeof assertTaskTransitionDocumentReady;
  readonly appendProgress: Bound<typeof appendProgressImpl>;
  readonly migrateTaskContracts: Bound<typeof migrateTaskContractsImpl>;
  readonly archiveTasks: Bound<typeof archiveTasksImpl>;
  readonly supersedeWithNewTask: Bound<typeof supersedeWithNewTaskImpl>;
  readonly declareExecutionExecutor: (action: RepoTaskAction, binding: RepoCellBinding) => WriteReceiptDraft;
  readonly annotateExecution: (action: RepoTaskAction, binding: RepoCellBinding) => WriteReceiptDraft;
  readonly completeTask: Bound<typeof completeTaskImpl>;
  readonly taskSurfaceWrite: Bound<typeof taskSurfaceWriteImpl>;
  readonly rejected: typeof rejected;
  readonly lifecycleAction: Bound<typeof lifecycleActionImpl>;
  readonly service: ReturnType<typeof makeTaskLifecycleService>;
  readonly squadCoordinator: ReturnType<typeof makeSquadCoordinator>;
  readonly workspaceText: typeof workspaceText;
  readonly buildCommand: typeof buildCommand;
  readonly withServerMeta: typeof withServerMeta;
  readonly proofFor: (
    command: Parameters<typeof proofFor>[0],
    snapshot: Parameters<typeof proofFor>[1],
    binding: Parameters<typeof proofFor>[2],
    projection: Parameters<typeof proofFor>[3],
  ) => ReturnType<typeof proofFor>;
  readonly lifecycleReceipt: Bound<typeof lifecycleReceipt>;
  readonly publicPublication: (value: Pick<CanonicalEventAppendReceipt, "commitSha" | "cut">) => PublicPublication;
  readonly explicitExecutionId: typeof explicitExecutionId;
  readonly projectionReady: typeof projectionReady;
  readonly uniqueDerivedExecutionId: typeof uniqueDerivedExecutionId;
  readonly receiptProof: typeof receiptProof;
  readonly taskMutation: Bound<typeof taskMutationImpl>;
  readonly withoutDryRun: typeof withoutDryRun;
  readonly previewResult: Bound<typeof previewResultImpl>;
  readonly projectedTaskIds: Bound<typeof projectedTaskIdsImpl>;
  readonly wipSnapshotEntries: Bound<typeof wipSnapshotEntriesImpl>;
  readonly legacyReviewLint: typeof legacyReviewLint;
  readonly cellStringList: typeof cellStringList;
  readonly decodeEvidencePayload: typeof decodeEvidencePayload;
  readonly renderEvidencePayload: typeof renderEvidencePayload;
  readonly createTaskId: typeof createTaskId;
  readonly progressReceipt: Bound<typeof progressReceiptImpl>;
  readonly progressEvidence: typeof progressEvidence;
  readonly completionApplied: typeof completionApplied;
  readonly completionContext: Bound<typeof completionContextImpl>;
  readonly completeRetryCommand: typeof completeRetryCommand;
  readonly failed: typeof failed;
  readonly completionSettlement: typeof completionSettlement;
  readonly publishGateWitness: Bound<typeof publishGateWitnessImpl>;
  readonly errorOperationId: typeof errorOperationId;
  readonly completionStopped: typeof completionStopped;
  readonly completionKillpoint: Bound<typeof completionKillpointImpl>;
  readonly executeAction: (action: RepoTaskAction, binding: RepoCellBinding) => Promise<WriteReceiptDraft>;
  readonly withHumanSummary: Bound<typeof withHumanSummaryImpl>;
  recoveryUncertain: boolean;
  readonly recovery: RepoCellCore["recovery"];
  readonly canonicalSettlement: Bound<typeof canonicalSettlementImpl>;
  knownTaskIds: Set<string> | null;
}

export interface RepoCellRuntimeContext extends RepoCellActionContext {
  readonly mode: DaemonRepoMode;
  readonly runtimeSpawner: ReturnType<typeof makeRuntimeSpawner>;
}

export interface RepoCellOperationalContext extends RepoCellRuntimeContext {
  readonly settings: RepoCellSettingsState;
}

export interface RepoCellApiContext {
  readonly extracted: RepoCellOperationalContext;
  readonly mode: DaemonRepoMode;
  readonly input: {
    readonly repoId: string;
    readonly runtimeDaemonRoute?: import("./runtime-spawn.ts").RuntimeDaemonRoute;
    readonly killpoint?: (point: EventPublicationKillpoint) => void;
    readonly runtimeInstances?: RepoCellOperationalContext["input"]["runtimeInstances"];
    readonly prepareDaemonGitEnvironment?: (
      instanceId: string,
      provider: "github" | "gitlab",
      repoId: string,
    ) => Promise<NodeJS.ProcessEnv | null>;
  };
  readonly rejected: RepoCellOperationalContext["rejected"];
  readonly operationId: RepoCellOperationalContext["operationId"];
  readonly failed: RepoCellOperationalContext["failed"];
  readonly fatalCellError: (error: unknown) => boolean;
  readonly errorOperationId: RepoCellOperationalContext["errorOperationId"];
  readonly cellCodedError: RepoCellOperationalContext["cellCodedError"];
  readonly requiredCellText: RepoCellOperationalContext["requiredCellText"];
  readonly dispatchRead: typeof import("./repo-cell-command.ts").dispatchRead;
  state: RepoCell["status"] extends () => infer Status
    ? Status extends { readonly state: infer State }
      ? State
      : never
    : never;
  readonly attemptRecovery: (force?: boolean) => Promise<void>;
  causeClass: ReturnType<RepoCell["status"]>["causeClass"];
  readonly latched: () => string;
  readonly latchWith: (error: unknown) => void;
  queueDepth: number;
  tail: Promise<void>;
  /** Head tracker shared by every append to `tail`; names who a waiting write is behind. */
  readonly writeQueue: RepoCellWriteQueueState;
  readonly activeWriter: Parameters<typeof assertCurrentWriter>[0];
  readonly writerToken: Parameters<typeof assertCurrentWriter>[1];
  activeWriterEpochFence: (<T>(operation: () => T) => T) | null;
  activeWriterEpochFenceDescriptor: NonNullable<RepoCellBinding["writerEpochFence"]> | null;
  readonly withHumanSummary: (receipt: WriteReceiptDraft) => WriteReceiptDraft;
  lastError: string | null;
  recoveryUncertain: boolean;
  readonly recoveryProbe: ReturnType<typeof makeRecoveryProbe>;
  readonly replica: RepoCell["replica"];
  readonly rootDir: CanonicalRoot;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly withReadSession?: import("./doc-sync-reads.ts").ProjectedDocumentReadContext["withReadSession"];
  readonly now: () => string;
  readonly onlineBinding: (binding: RepoCellBinding) => Promise<RepoCellBinding>;
  readonly executeAction: RepoCellOperationalContext["executeAction"];
  readonly squadCoordinator: ReturnType<typeof makeSquadCoordinator>;
  readonly presetProcess: ReturnType<typeof createPresetProcessService>;
  readonly runtimeReads: ReturnType<typeof makeAgentRuntimeReadModel>;
  readonly runtimeSpawner: ReturnType<typeof makeRuntimeSpawner>;
  /** Resolves when the session's projected outcome is settled per the domain settle predicate. */
  readonly awaitRuntimeOutcome: (runtimeSessionId: string) => Promise<void>;
  /** Resolves on the next runtime signal/outcome notification or the settlement grace backstop. */
  readonly runtimeSignalVersion: () => number;
  readonly awaitRuntimeSignal: (observedVersion?: number) => Promise<void>;
  readonly settings: RepoCellSettingsState;
  readonly appendAuxiliaryRuntimeIngress: RepoCellOperationalContext["appendAuxiliaryRuntimeIngress"];
  bootstrapReceipt: RepoBootstrapReceipt | undefined;
  readonly catalog: RepoCell["catalog"];
  readonly runtimeStream: AgentRuntimeStreamHub;
  readonly canHibernate?: () => boolean;
  readonly generation: number;
  readonly recovery: RepoCellOperationalContext["recovery"];
  readonly lock: { readonly close: () => Promise<void> };
}

export interface RepoCellOpenInput {
  readonly canonicalWriter?: (options: {
    readonly writerFence: () => import("@harness-anything/storage/sqlite").DaemonWriterFence;
  }) => NonNullable<import("@harness-anything/storage/sqlite").SqliteTaskEventStoreOptions["canonicalWriter"]>;
  readonly storage?: DaemonStorageConfig;
  readonly repoId: WorkspaceId;
  readonly rootDir: CanonicalRoot;
  readonly ownerId: string;
  /** Supervisor-owned generation for physical isolate replacement, independent of wall-clock steps. */
  readonly writerGeneration?: number;
  readonly mode?: DaemonRepoMode;
  readonly authoredBranch?: string;
  readonly runtimeLaunch?: RuntimeLauncher;
  readonly runtimeDaemonRoute?: RuntimeDaemonRoute;
  readonly keycloakCenter?: import("./transport/auth-context.ts").KeycloakCenterAuthority;
  readonly keycloakSession?: (rootDir: string) => Promise<RuntimeOperatorSession>;
  readonly runtimeInstanceDispatchState?: import("@harness-anything/kernel/internal/domain/runtime-instance-scheduling.ts").RuntimeInstanceDispatchState;
  readonly selectRuntimeInstance?: import("./runtime-spawn-types.ts").RuntimeSpawnerInput["selectRuntimeInstance"];
  readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
  /** Center-owned instance limits; edges cannot supply or override these in an admission payload. */
  readonly runtimeInstanceCapacities?: Readonly<Record<string, number>>;
  readonly runtimeProviderHealth?: import("../runtime-engine/runtime-provider-health.ts").RuntimeProviderHealthStore;
  readonly prepareRuntimeLaunch?: (instanceId: string, request: RuntimeLaunchRequest) => Promise<PreparedRuntimeLaunch>;
  readonly prepareCloudRelay?: NonNullable<Parameters<typeof makeRuntimeSpawner>[0]["prepareCloudRelay"]>;
  readonly reclaimRuntimeTempDirectory?: (instanceId: string, runtimeSessionId: string) => Error | null;
  readonly listRuntimeTempSessionIds?: () => readonly string[];
  readonly reclaimSettledRuntimeTempDirectories?: (
    settledRuntimeSessionIds: readonly string[],
  ) => { readonly instanceId: string; readonly runtimeSessionId: string; readonly error: Error }[];
  readonly prepareDaemonGitEnvironment?: (
    instanceId: string,
    provider: "github" | "gitlab",
    repoId: string,
  ) => Promise<NodeJS.ProcessEnv | null>;
  readonly bootstrap?: RepoBootstrapInput;
  readonly onBootstrap?: (receipt: RepoBootstrapReceipt) => void;
  readonly onRuntimeOutcome?: (
    event: Extract<
      import("@harness-anything/kernel").AgentRuntimeEventV1,
      { readonly type: "runtime_session_outcome_observed" }
    >,
  ) => void;
  /** Relays validated live provider frames to the host-side read-only stream hub. */
  readonly onRuntimeSignal?: (runtimeSessionId: string, signal: AgentRuntimeNativeSignal) => void;
  readonly onAttemptTerminal?: (terminal: RuntimeAttemptTerminal) => void;
  /** Internal writer status bridge for asynchronous materialization health changes. */
  readonly onMaterializationHealthChange?: Parameters<typeof makeTaskEventStore>[0]["onMaterializationHealthChange"];
  readonly onQueueDepthChange?: (queueDepth: number) => void;
  readonly onOpenProgress?: (progress: RepoCellAttachProgress) => void;
  readonly now?: () => string;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
  readonly shouldStop?: () => boolean;
  readonly recordLifecycle?: DaemonLifecycleRecorder;
  /** Host-owned fleet roster snapshot (remote-center schedule reads); resolved per read. */
  /** Daemon-owned fallback for writes produced inside the cell rather than a request. */
  readonly defaultWriterEpochFence?: NonNullable<RepoCellBinding["writerEpochFence"]>;
}
