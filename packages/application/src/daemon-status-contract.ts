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
  readonly failure?: Pick<DaemonControlErrorV1, "code" | "hint">;
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

export class DaemonStatusContractError extends Error {
  readonly code: "invalid_daemon_status_request" | "invalid_daemon_status_result";

  constructor(code: DaemonStatusContractError["code"], message: string) {
    super(message);
    this.name = "DaemonStatusContractError";
    this.code = code;
  }
}

/** Runtime boundary codec for the daemon-status/v2 request and service result. */
export function decodeDaemonStatusRequestV2(value: unknown): DaemonStatusRequestV2 {
  try {
    const request = object(value, "request");
    keys(request, ["repo"], "request");
    const repo = object(request.repo, "request.repo");
    keys(repo, ["repoId"], "request.repo");
    string(repo.repoId, "request.repo.repoId");
    return { repo: { repoId: repo.repoId as string } };
  } catch (error) {
    if (error instanceof DaemonStatusContractError) {
      throw new DaemonStatusContractError("invalid_daemon_status_request", error.message);
    }
    throw error;
  }
}

export function decodeDaemonStatusResultV2(value: unknown): DaemonStatusResultV2 {
  const result = object(value, "result");
  keys(result, [
    "schema", "daemonId", "pid", "started", "rootDir", "repoId", "endpoint", "version", "protocolVersion", "queue", "queueDepth",
    "connections", "lastReconcileAt", "lastReconcileError", "lastRecovery", "projectionGeneration", "service", "requestedRepo", "repos"
  ], "result");
  literal(result.schema, "daemon-status/v2", "result.schema");
  for (const field of ["daemonId", "rootDir", "repoId", "endpoint", "version"] as const) string(result[field], `result.${field}`);
  nonNegativeStatusInteger(result.pid, "result.pid");
  boolean(result.started, "result.started");
  literal(result.protocolVersion, 1, "result.protocolVersion");
  queue(result.queue, "result.queue");
  nonNegativeStatusInteger(result.queueDepth, "result.queueDepth");
  connections(result.connections, "result.connections");
  nullableTimestamp(result.lastReconcileAt, "result.lastReconcileAt");
  nullableReconcileError(result.lastReconcileError, "result.lastReconcileError");
  service(result.service);
  repo(result.requestedRepo, "result.requestedRepo");
  if (!Array.isArray(result.repos)) invalidStatusShape("result.repos must be an array");
  result.repos.forEach((entry, index) => repo(entry, `result.repos[${index}]`));
  return result as unknown as DaemonStatusResultV2;
}

export function isDaemonStatusContractError(error: unknown): error is DaemonStatusContractError {
  return error instanceof DaemonStatusContractError;
}

function service(value: unknown): void {
  const record = object(value, "result.service");
  keys(record, [
    "daemonId", "pid", "endpoint", "userRoot", "started", "startedAt", "uptimeMs", "build", "queue", "connections", "repoCount",
    "attachedCount", "unavailableCount", "lastReconcileAt", "lastReconcileError", "activeControl"
  ], "result.service");
  for (const field of ["daemonId", "endpoint", "userRoot"] as const) string(record[field], `result.service.${field}`);
  nonNegativeStatusInteger(record.pid, "result.service.pid");
  boolean(record.started, "result.service.started");
  timestamp(record.startedAt, "result.service.startedAt");
  nonNegativeStatusInteger(record.uptimeMs, "result.service.uptimeMs");
  const build = object(record.build, "result.service.build");
  keys(build, ["version", "loadedIdentity", "installedIdentity", "identitySource", "stale"], "result.service.build");
  for (const field of ["version", "loadedIdentity", "installedIdentity"] as const) string(build[field], `result.service.build.${field}`);
  literal(build.identitySource, "installed-artifact-set", "result.service.build.identitySource");
  boolean(build.stale, "result.service.build.stale");
  queue(record.queue, "result.service.queue");
  connections(record.connections, "result.service.connections");
  for (const field of ["repoCount", "attachedCount", "unavailableCount"] as const) nonNegativeStatusInteger(record[field], `result.service.${field}`);
  nullableTimestamp(record.lastReconcileAt, "result.service.lastReconcileAt");
  nullableReconcileError(record.lastReconcileError, "result.service.lastReconcileError");
  if (record.activeControl !== null) activeControl(record.activeControl);
}

function repo(value: unknown, label: string): void {
  const record = object(value, label);
  keys(record, ["repoId", "canonicalRoot", "displayName", "state", "lock", "queue", "lastRecovery", "projectionGeneration", "lastError", "lastMaterializerError", "lastReconcileError"], label, ["displayName"]);
  string(record.repoId, `${label}.repoId`);
  string(record.canonicalRoot, `${label}.canonicalRoot`);
  if (record.displayName !== undefined) string(record.displayName, `${label}.displayName`);
  oneOf(record.state, ["attached", "unavailable", "detaching", "detached"], `${label}.state`);
  const lock = object(record.lock, `${label}.lock`);
  keys(lock, ["path", "ownerToken"], `${label}.lock`);
  nullableString(lock.path, `${label}.lock.path`);
  nullableString(lock.ownerToken, `${label}.lock.ownerToken`);
  queue(record.queue, `${label}.queue`);
  nullableString(record.lastError, `${label}.lastError`);
  nullableString(record.lastMaterializerError, `${label}.lastMaterializerError`);
  nullableReconcileError(record.lastReconcileError, `${label}.lastReconcileError`);
}

function queue(value: unknown, label: string): void {
  const record = object(value, label);
  keys(record, ["interactive", "normal", "background", "maintenance", "running", "depth"], label);
  for (const field of ["interactive", "normal", "background", "maintenance", "depth"] as const) nonNegativeStatusInteger(record[field], `${label}.${field}`);
  boolean(record.running, `${label}.running`);
}

function connections(value: unknown, label: string): void {
  const record = object(value, label);
  keys(record, ["active", "total"], label);
  nonNegativeStatusInteger(record.active, `${label}.active`);
  nonNegativeStatusInteger(record.total, `${label}.total`);
}

function activeControl(value: unknown): void {
  const record = object(value, "result.service.activeControl");
  keys(record, ["operationId", "kind", "phase", "requestedAt"], "result.service.activeControl");
  string(record.operationId, "result.service.activeControl.operationId");
  oneOf(record.kind, ["restart", "refresh"], "result.service.activeControl.kind");
  oneOf(record.phase, ["accepted", "draining", "building", "replacing", "failed"], "result.service.activeControl.phase");
  timestamp(record.requestedAt, "result.service.activeControl.requestedAt");
}

function nullableReconcileError(value: unknown, label: string): void {
  if (value === null) return;
  const record = object(value, label);
  keys(record, ["at", "code", "message", "repoId"], label);
  timestamp(record.at, `${label}.at`);
  string(record.code, `${label}.code`);
  string(record.message, `${label}.message`);
  nullableString(record.repoId, `${label}.repoId`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidStatusShape(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(record: Record<string, unknown>, allowed: ReadonlyArray<string>, label: string, optional: ReadonlyArray<string> = []): void {
  const unknown = Object.keys(record).find((field) => !allowed.includes(field));
  if (unknown) invalidStatusShape(`${label} has unsupported field: ${unknown}`);
  const missing = allowed.find((field) => !optional.includes(field) && !(field in record));
  if (missing) invalidStatusShape(`${label}.${missing} is required`);
}

function string(value: unknown, label: string): asserts value is string { if (typeof value !== "string") invalidStatusShape(`${label} must be a string`); }
function nullableString(value: unknown, label: string): void { if (value !== null && typeof value !== "string") invalidStatusShape(`${label} must be null or a string`); }
function boolean(value: unknown, label: string): void { if (typeof value !== "boolean") invalidStatusShape(`${label} must be a boolean`); }
function nonNegativeStatusInteger(value: unknown, label: string): void { if (!Number.isInteger(value) || Number(value) < 0) invalidStatusShape(`${label} must be a non-negative integer`); }
function literal(value: unknown, expected: string | number, label: string): void { if (value !== expected) invalidStatusShape(`${label} must be ${String(expected)}`); }
function oneOf(value: unknown, expected: ReadonlyArray<string>, label: string): void { if (typeof value !== "string" || !expected.includes(value)) invalidStatusShape(`${label} is unsupported`); }
function timestamp(value: unknown, label: string): void { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalidStatusShape(`${label} must be an ISO timestamp`); }
function nullableTimestamp(value: unknown, label: string): void { if (value !== null) timestamp(value, label); }
function invalidStatusShape(message: string): never { throw new DaemonStatusContractError("invalid_daemon_status_result", message); }

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
