import type { CommandTopology } from "../../preset/src/preset-command-contract.ts";
import type { DaemonRepoMode, InvalidDaemonRegistryRepo } from "../../kernel/src/index.ts";
import type { registerDaemonRepo } from "../../kernel/src/index.ts";
import type { RuntimeInstanceSummary, openRuntimeInstanceStore } from "./agent-runtime-instances.ts";
import type { DaemonBuildObserver } from "./build-identity.ts";
import type { DaemonHostOpenInput } from "./daemon-host-open.ts";
import type { DaemonHost } from "./daemon-host-types.ts";
import type { FleetRoster } from "./fleet-center-admission.ts";
import type { FleetEdgeRuntimeRequest, openFleetEdgeRuntime } from "./fleet-edge-runtime.ts";
import type { FleetTlsCenter } from "./fleet/center.ts";
import type { DaemonControlReceipt } from "./gui-s3-control.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { makeRecoveryProbe } from "./recovery-state.ts";
import type { RepoCell, RepoCellStatus } from "./repo-cell-types.ts";
import type { RepoModeAdmission } from "./repo-mode.ts";
import type { RuntimeDaemonRoute } from "./runtime-spawn.ts";
import type { makeScheduleScheduler } from "./schedule-scheduler.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import type { makeWarmingSettlement } from "./daemon-host-errors.ts";

export interface DaemonPoint extends JsonObject {
  readonly daemonId: string;
  readonly pid: number;
  readonly startedAt: string;
}

export interface DaemonRuntimePorts {
  readonly runtimeInstances: () => readonly RuntimeInstanceSummary[];
  readonly prepareRuntimeLaunch: ReturnType<typeof openRuntimeInstanceStore>["prepareLaunch"];
  readonly prepareWorkerGitEnvironment: ReturnType<typeof openRuntimeInstanceStore>["prepareWorkerGitEnvironment"];
}

export interface RegisteredRepoInput {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly authoredBranch: string;
  readonly mode: DaemonRepoMode;
}

export interface AttachProgress {
  readonly attachIndex: number;
  readonly attachTotal: number;
}

interface HostMaps {
  readonly cells: Map<string, RepoCell>;
  readonly warming: Map<string, RepoCellStatus>;
  readonly unavailable: Map<string, RepoCellStatus>;
}

export interface DaemonHostAdmissionContext {
  readonly input: DaemonHostOpenInput;
  readonly unavailable: Map<string, RepoCellStatus>;
  readonly admitHostMode: (
    repoId: string,
    command: CommandTopology,
    auth: DaemonAuthenticationContext,
  ) => RepoModeAdmission;
  readonly hostCodedError: (code: string, message: string, data?: JsonObject) => Error;
  readonly point: () => DaemonPoint;
  readonly code: (error: unknown) => string;
  readonly daemonErrorMessage: (error: unknown) => string;
  readonly controls: Map<string, DaemonControlReceipt>;
  latestControl: DaemonControlReceipt | null;
}

export interface DaemonHostRegistryContext extends HostMaps, DaemonHostAdmissionContext {
  readonly input: DaemonHostOpenInput;
  readonly settleWarming: (repoId: string) => void;
  readonly openings: Map<string, Promise<void>>;
  readonly performOpenRegistered: (repo: RegisteredRepoInput, progress?: AttachProgress) => Promise<void>;
  readonly raceAttachBudget: (opening: Promise<void>, repoId: string, progress?: AttachProgress) => Promise<void>;
  readonly attachTimeoutMs: number;
  readonly attachBudgetError: (repoId: string, timeoutMs: number) => Error;
  readonly openCell: NonNullable<DaemonHostOpenInput["openCell"]>;
  readonly runtimePorts: DaemonRuntimePorts;
  readonly runtimeDaemonRoute: RuntimeDaemonRoute;
  readonly scheduleScheduler: ReturnType<typeof makeScheduleScheduler>;
  readonly edgeRuntimeFor: (request: FleetEdgeRuntimeRequest["payload"]) => ReturnType<typeof openFleetEdgeRuntime>;
  readonly invalidRepoId: (repo: InvalidDaemonRegistryRepo) => string;
  readonly closeCell: (repoId: string) => Promise<void>;
  readonly unavailableProbes: Map<string, ReturnType<typeof makeRecoveryProbe>>;
  readonly latchUnavailable: (repoId: string, status: RepoCellStatus) => void;
  readonly invalidRegistryStatus: (repo: InvalidDaemonRegistryRepo) => RepoCellStatus;
  readonly pruneMissingRoot: (repo: {
    readonly repoId: string;
    readonly canonicalRoot: string;
    readonly registeredAt: string;
  }) => boolean;
  readonly markWarming: (repoId: string, status: RepoCellStatus) => void;
  readonly warmingStatus: (repo: {
    readonly repoId: string;
    readonly canonicalRoot: string;
    readonly mode: DaemonRepoMode;
  }) => RepoCellStatus;
  readonly openRegistered: (repo: RegisteredRepoInput, progress?: AttachProgress) => Promise<void>;
  readonly unavailableStatus: (repoId: string, rootDir: string, mode: DaemonRepoMode, error: unknown) => RepoCellStatus;
  readonly waitForWarming: (repoId: string) => Promise<void>;
  readonly now: () => string;
  readonly warmingSettlements: Map<string, ReturnType<typeof makeWarmingSettlement>>;
  readonly startInitialAttachments: () => Promise<void>;
  fleetRoster: FleetRoster | null;
  initialAttachments: Promise<void> | null;
  readonly attachInitial: () => Promise<void>;
  readonly repos: ReturnType<typeof import("../../kernel/src/index.ts").readDaemonRegistry>["repos"];
  closing: boolean;
}

export interface DaemonHostApiContext extends HostMaps, DaemonHostAdmissionContext {
  readonly runtimePorts: DaemonRuntimePorts;
  readonly failedConfigureVerify: typeof import("./daemon-host-errors.ts").failedConfigureVerify;
  readonly hostCodedError: typeof import("./daemon-host-errors.ts").hostCodedError;
  readonly binding: typeof import("./daemon-host-binding.ts").binding;
  readonly attach: (
    rootDir: string,
    repoId: string,
    mode?: DaemonRepoMode,
  ) => Promise<ReturnType<typeof registerDaemonRepo>>;
  readonly localOnly: typeof import("./daemon-host-status.ts").localOnly;
  readonly settleWarming: (repoId: string) => void;
  readonly closeCell: (repoId: string) => Promise<void>;
  readonly publicRegistryRepo: typeof import("./daemon-host-status.ts").publicRegistryRepo;
  readonly rejectHostAction: typeof import("./daemon-host-errors.ts").rejectHostAction;
  readonly attemptHostRecovery: (repoId: string) => Promise<void>;
  readonly warmingMessage: (repoId: string) => string;
  readonly declaredExecutor: typeof import("./daemon-host-binding.ts").declaredExecutor;
  readonly requiredCell: typeof import("./daemon-host-status.ts").requiredCell;
  readonly rejectPresetRun: typeof import("./daemon-host-errors.ts").rejectPresetRun;
  readonly recoverableRunId: typeof import("./daemon-host-errors.ts").recoverableRunId;
  readonly requireHostMode: (repoId: string, command: CommandTopology, auth: DaemonAuthenticationContext) => void;
  fleetCenter: FleetTlsCenter | null;
  fleetRoster: FleetRoster | null;
  readonly fleetEdgeRuntimes: Map<string, ReturnType<typeof openFleetEdgeRuntime>>;
  readonly runtimeDaemonRoute: RuntimeDaemonRoute;
  readonly scheduleScheduler: ReturnType<typeof makeScheduleScheduler>;
  readonly edgeRuntimeFor: (request: FleetEdgeRuntimeRequest["payload"]) => ReturnType<typeof openFleetEdgeRuntime>;
  readonly instances: ReturnType<typeof openRuntimeInstanceStore>;
  readonly requiredText: typeof import("./daemon-host-status.ts").requiredText;
  readonly refreshRegistry: () => Promise<void>;
  readonly settleControl: (pending: DaemonControlReceipt, ok: boolean, error?: unknown) => void;
  readonly buildObserver: DaemonBuildObserver;
  readonly startInitialAttachments: () => Promise<void>;
  closing: boolean;
  initialAttachments: Promise<void> | null;
  readonly host: DaemonHost;
  readonly system: (auth: DaemonAuthenticationContext) => JsonObject;
  readonly now: () => string;
  readonly startedAt: string;
}
