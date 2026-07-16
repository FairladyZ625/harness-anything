export interface DaemonStatusRequestV2 {
  readonly repo: { readonly repoId: string };
}

export interface DaemonQueueStatus {
  readonly interactive: number;
  readonly normal: number;
  readonly background: number;
  readonly maintenance: number;
  readonly running: boolean;
  readonly depth: number;
}

export interface DaemonReconcileErrorStatus {
  readonly at: string;
  readonly code: string;
  readonly message: string;
  readonly repoId: string | null;
}

export interface DaemonActiveControlStatus {
  readonly operationId: string;
  readonly kind: DaemonControlKind;
  readonly phase: "accepted" | "draining" | "building" | "replacing" | "failed";
  readonly requestedAt: string;
}

export interface DaemonBuildStatus {
  readonly version: string;
  readonly loadedIdentity: string;
  readonly installedIdentity: string;
  readonly identitySource: "installed-artifact-set";
  readonly stale: boolean;
}

export interface DaemonRepoStatus {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly displayName?: string;
  readonly state: "attached" | "unavailable" | "detaching" | "detached";
  readonly lock: {
    readonly path: string | null;
    readonly ownerToken: string | null;
  };
  readonly queue: DaemonQueueStatus;
  readonly lastRecovery: unknown;
  readonly projectionGeneration: unknown;
  readonly lastError: string | null;
  readonly lastMaterializerError: string | null;
  readonly lastReconcileError: DaemonReconcileErrorStatus | null;
}

export interface DaemonStatusResultV2 {
  readonly schema: "daemon-status/v2";
  /** Transitional v1 read projection. New clients consume service/requestedRepo. */
  readonly daemonId: string;
  readonly pid: number;
  readonly started: boolean;
  readonly rootDir: string;
  readonly repoId: string;
  readonly endpoint: string;
  readonly version: string;
  readonly protocolVersion: 1;
  readonly queue: DaemonQueueStatus;
  readonly queueDepth: number;
  readonly connections: { readonly active: number; readonly total: number };
  readonly lastReconcileAt: string | null;
  readonly lastReconcileError: DaemonReconcileErrorStatus | null;
  readonly lastRecovery: unknown;
  readonly projectionGeneration: unknown;
  readonly service: {
    readonly daemonId: string;
    readonly pid: number;
    readonly endpoint: string;
    readonly userRoot: string;
    readonly started: boolean;
    readonly startedAt: string;
    readonly uptimeMs: number;
    readonly build: DaemonBuildStatus;
    readonly queue: DaemonQueueStatus;
    readonly connections: { readonly active: number; readonly total: number };
    readonly repoCount: number;
    readonly attachedCount: number;
    readonly unavailableCount: number;
    readonly lastReconcileAt: string | null;
    readonly lastReconcileError: DaemonReconcileErrorStatus | null;
    readonly activeControl: DaemonActiveControlStatus | null;
  };
  readonly requestedRepo: DaemonRepoStatus;
  readonly repos: ReadonlyArray<DaemonRepoStatus>;
}

export type DaemonRendererRepoStatus = Omit<DaemonRepoStatus, "lock"> & {
  readonly lock: Omit<DaemonRepoStatus["lock"], "ownerToken">;
};

export type DaemonRendererStatusV2 = Omit<DaemonStatusResultV2, "requestedRepo" | "repos"> & {
  readonly requestedRepo: DaemonRendererRepoStatus;
  readonly repos: ReadonlyArray<DaemonRendererRepoStatus>;
};

export function projectDaemonStatusForRenderer(status: DaemonStatusResultV2): DaemonRendererStatusV2 {
  return {
    ...status,
    requestedRepo: projectRepo(status.requestedRepo),
    repos: status.repos.map(projectRepo)
  };
}

function projectRepo(repo: DaemonRepoStatus): DaemonRendererRepoStatus {
  return { ...repo, lock: { path: repo.lock.path } };
}

export interface DaemonStatusService {
  readonly getStatus: (context?: { readonly repo: { readonly repoId: string; readonly canonicalRoot: string } }) =>
    DaemonStatusResultV2 | Promise<DaemonStatusResultV2>;
}

export type DaemonControlKind = "restart" | "refresh";
export type DaemonRefreshTrigger = "explicit" | "post-merge" | "dist-watcher";

export interface DaemonControlRequestV1 {
  readonly reason: string;
  readonly drainTimeoutMs: number;
  readonly trigger?: DaemonRefreshTrigger;
}

export interface DaemonControlAcceptedV1 {
  readonly schema: "daemon-control-accepted/v1";
  readonly accepted: true;
  readonly operationId: string;
  readonly kind: DaemonControlKind;
  readonly scope: "service";
  readonly requestedAt: string;
  readonly before: {
    readonly pid: number;
    readonly loadedIdentity: string;
    readonly repoCount: number;
    readonly queueDepth: number;
  };
}

export interface DaemonControlErrorV1 {
  readonly code:
    | "daemon_control_not_authorized"
    | "daemon_control_in_progress"
    | "daemon_control_unavailable"
    | "daemon_queue_drain_timeout"
    | "daemon_refresh_wrong_checkout"
    | "daemon_refresh_build_failed"
    | "daemon_restart_failed";
  readonly hint: string;
  readonly operationId: string | null;
}

export type DaemonControlServiceResult =
  | { readonly ok: true; readonly accepted: DaemonControlAcceptedV1; readonly afterResponse: () => void }
  | { readonly ok: false; readonly error: DaemonControlErrorV1 };

export interface DaemonControlService {
  readonly requestControl: (
    kind: DaemonControlKind,
    request: DaemonControlRequestV1
  ) => DaemonControlServiceResult | Promise<DaemonControlServiceResult>;
}

export function daemonControlInProgressError(active: DaemonActiveControlStatus): DaemonControlErrorV1 {
  return {
    code: "daemon_control_in_progress",
    hint: `Daemon ${active.kind} operation ${active.operationId} is already active. Run \`ha daemon status --json\` and wait for that operation to clear before retrying.`,
    operationId: active.operationId
  };
}

export interface DaemonProtocolErrorV1 {
  readonly code: string;
  readonly hint: string;
}
