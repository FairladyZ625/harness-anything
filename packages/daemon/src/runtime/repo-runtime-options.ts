import type {
  DaemonAdmissionBudget,
  HarnessLayoutOverrides,
  LedgerMaterializerReport,
  OperationalActor,
  RecoveryReport,
  WriteAttribution,
  WriteCoordinator
} from "@harness-anything/kernel";
import type {
  ExecutionEvidencePage,
  ExecutionEvidencePageQuery,
  ProjectionChangeEvent,
  ProjectionSourceFenceFactory
} from "@harness-anything/kernel/daemon-runtime-support";
import type {
  DaemonAuthorityPublicationOptions,
  DaemonAuthorityPublicationReport
} from "./authority-publication.ts";
import type {
  BackgroundBatchRequest,
  DaemonQueueSnapshot,
  InteractiveWriteReceipt,
  InteractiveWriteRequest
} from "./write-queue.ts";
import type { DaemonGenerationWitness } from "../lifecycle/daemon-generation.ts";
import type { DaemonProjectionGenerationSnapshot } from "./projection-generation-manager.ts";

export interface DaemonMaterializerBatchOptions {
  readonly dryRun?: boolean;
  readonly sessionId?: string;
}

export interface DaemonDrainOptions {
  readonly drainTimeoutMs?: number;
}

export interface DaemonRuntimeOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly operationalActor?: OperationalActor;
  readonly lockTtlMs?: number;
  readonly interactiveMicroBatchMs?: number;
  readonly maxInteractiveOpsPerCommit?: number;
  readonly materializerPollMs?: number | false;
  readonly materializerMaxBranchesPerBatch?: number;
  readonly admissionMaxOperations?: number;
  readonly admissionMaxBytes?: number;
  readonly admissionReservedOperationsPerPlane?: number;
  readonly admissionReservedBytesPerPlane?: number;
  readonly projectionSourceFenceFactory?: ProjectionSourceFenceFactory;
  readonly reservationReconciler?: (input: {
    readonly rootDir: string;
    readonly layoutOverrides?: HarnessLayoutOverrides;
  }) => Promise<void>;
  /** Present only when this runtime is owned by a durable daemon generation. */
  readonly generationAxes?: {
    readonly machineId: string;
    readonly daemonGeneration: number;
  };
  readonly generationWitness?: DaemonGenerationWitness;
}

export interface DaemonRuntimeStatus {
  readonly started: boolean;
  readonly rootDir: string;
  readonly lockPath?: string;
  readonly lockOwnerToken?: string;
  readonly queue: DaemonQueueSnapshot;
  readonly lastRecovery?: RecoveryReport;
  readonly projectionGeneration: DaemonProjectionGenerationSnapshot;
}

export interface HarnessDaemonRuntime {
  readonly start: () => Promise<DaemonRuntimeStatus>;
  readonly stop: (options?: DaemonDrainOptions) => Promise<void>;
  readonly status: () => DaemonRuntimeStatus;
  readonly enqueueInteractiveWrite: (request: InteractiveWriteRequest) => Promise<InteractiveWriteReceipt>;
  readonly enqueueBackgroundBatch: <Result>(request: BackgroundBatchRequest<Result>) => Promise<Result>;
  readonly enqueueMaterializerBatch: (options?: DaemonMaterializerBatchOptions) => Promise<LedgerMaterializerReport>;
  readonly enqueueAuthorityPublication: (
    options: DaemonAuthorityPublicationOptions
  ) => Promise<DaemonAuthorityPublicationReport>;
  readonly queryExecutionEvidencePage: (query: ExecutionEvidencePageQuery) => Promise<ExecutionEvidencePage>;
  /** Authority/application port backed by this runtime's current held global lock. */
  readonly createAttributedCoordinator: (input: {
    readonly attribution: WriteAttribution;
    readonly sessionId: string;
    readonly commitAuthor?: InteractiveWriteRequest["commitAuthor"];
  }) => WriteCoordinator;
  readonly assertWriteFenceHeld: () => Promise<void>;
  readonly daemonGenerationContext?: () => {
    readonly witness: DaemonGenerationWitness;
    readonly machineId: string;
    readonly daemonGeneration: number;
    readonly runtimeRegistrationId?: string;
  } | undefined;
  readonly admissionBudget: DaemonAdmissionBudget;
  readonly subscribeProjectionChanges: (listener: (event: ProjectionChangeEvent) => void) => () => void;
}

export type DaemonRepoRuntimeState = "attached" | "unavailable" | "detaching" | "detached";

export interface DaemonRepoRuntimeOptions extends DaemonRuntimeOptions {
  readonly repoId: string;
  readonly displayName?: string;
}

export interface DaemonRepoRuntimeStatus extends DaemonRuntimeStatus {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly displayName?: string;
  readonly state: DaemonRepoRuntimeState;
  readonly lastError?: string;
  readonly lastMaterializerError?: string;
  readonly runtimeRegistrationId?: string;
  readonly daemonGeneration?: number;
}

export interface MultiRepoDaemonRuntimeOptions extends Omit<DaemonRuntimeOptions, "rootDir" | "layoutOverrides"> {
  readonly repos: ReadonlyArray<DaemonRepoRuntimeOptions>;
}

export interface MultiRepoDaemonRuntimeStatus {
  readonly started: boolean;
  readonly repoCount: number;
  readonly attachedCount: number;
  readonly unavailableCount: number;
  readonly repos: ReadonlyArray<DaemonRepoRuntimeStatus>;
}

export interface MultiRepoHarnessDaemonRuntime {
  readonly start: () => Promise<MultiRepoDaemonRuntimeStatus>;
  readonly stop: (options?: DaemonDrainOptions) => Promise<void>;
  readonly status: () => MultiRepoDaemonRuntimeStatus;
  readonly attachRepo: (repo: DaemonRepoRuntimeOptions) => Promise<DaemonRepoRuntimeStatus>;
  readonly detachRepo: (repoId: string) => Promise<DaemonRepoRuntimeStatus>;
  readonly retryUnavailableRepos: () => Promise<ReadonlyArray<DaemonRepoRuntimeStatus>>;
  readonly getRepoRuntime: (repoId: string) => HarnessDaemonRuntime | undefined;
  readonly enqueueInteractiveWrite: (repoId: string, request: InteractiveWriteRequest) => Promise<InteractiveWriteReceipt>;
  readonly enqueueBackgroundBatch: <Result>(repoId: string, request: BackgroundBatchRequest<Result>) => Promise<Result>;
  readonly enqueueMaterializerBatch: (repoId: string, options?: DaemonMaterializerBatchOptions) => Promise<LedgerMaterializerReport>;
}
