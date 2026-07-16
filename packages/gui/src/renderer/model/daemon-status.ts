/**
 * Typed model + validating reader for daemon-status/v2.
 * Fixture-backed today; later swapped for a real bridge call (X4).
 *
 * Note: wire lock-owner identity fields are intentionally not modeled
 * here — the System panel only surfaces lock paths, and the renderer
 * contract forbids privileged identity material in this layer.
 */

export const DAEMON_STATUS_SCHEMA = "daemon-status/v2" as const;

export type DaemonRepoState = "attached" | "unavailable" | "detaching" | "detached";

export type DaemonControlKind = "restart" | "refresh";

export type DaemonControlPhase =
  | "accepted"
  | "draining"
  | "building"
  | "replacing"
  | "failed";

export interface DaemonQueueLanes {
  readonly interactive: number;
  readonly normal: number;
  readonly background: number;
  readonly maintenance: number;
  readonly running: boolean;
  readonly depth: number;
}

export interface DaemonLockInfo {
  readonly path: string | null;
}

export interface DaemonConnections {
  readonly active: number;
  readonly total: number;
}

export interface DaemonBuildInfo {
  readonly version: string;
  readonly loadedIdentity: string;
  readonly installedIdentity: string;
  readonly identitySource: "installed-artifact-set";
  readonly stale: boolean;
}

export interface DaemonReconcileError {
  readonly at: string;
  readonly code: string;
  readonly message: string;
  readonly repoId: string | null;
}

export interface DaemonActiveControl {
  readonly operationId: string;
  readonly kind: DaemonControlKind;
  readonly phase: DaemonControlPhase;
  readonly requestedAt: string;
}

export interface DaemonServiceStatus {
  readonly daemonId: string;
  readonly pid: number;
  readonly endpoint: string;
  readonly userRoot: string;
  readonly started: boolean;
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly build: DaemonBuildInfo;
  readonly queue: DaemonQueueLanes;
  readonly connections: DaemonConnections;
  readonly repoCount: number;
  readonly attachedCount: number;
  readonly unavailableCount: number;
  readonly lastReconcileAt: string | null;
  readonly lastReconcileError: DaemonReconcileError | null;
  readonly activeControl: DaemonActiveControl | null;
}

export interface DaemonRepoStatus {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly displayName?: string;
  readonly state: DaemonRepoState;
  readonly lock: DaemonLockInfo;
  readonly queue: DaemonQueueLanes;
  readonly lastRecovery: unknown | null;
  readonly projectionGeneration: unknown | null;
  readonly lastError: string | null;
  readonly lastMaterializerError: string | null;
  readonly lastReconcileError: DaemonReconcileError | null;
}

export interface DaemonStatusModel {
  readonly schema: typeof DAEMON_STATUS_SCHEMA;
  readonly service: DaemonServiceStatus;
  readonly requestedRepo: DaemonRepoStatus;
  readonly repos: ReadonlyArray<DaemonRepoStatus>;
}

const REPO_STATES = new Set<DaemonRepoState>([
  "attached",
  "unavailable",
  "detaching",
  "detached",
]);

const CONTROL_KINDS = new Set<DaemonControlKind>(["restart", "refresh"]);

const CONTROL_PHASES = new Set<DaemonControlPhase>([
  "accepted",
  "draining",
  "building",
  "replacing",
  "failed",
]);

/** Rows for the per-repo table — always `repos[]` in v2. */
export function daemonRepoRows(status: DaemonStatusModel): ReadonlyArray<DaemonRepoStatus> {
  return status.repos;
}

export function readDaemonStatus(value: unknown): DaemonStatusModel {
  if (!isRecord(value)) {
    throw new Error("Daemon status is not an object.");
  }
  if (value.schema !== DAEMON_STATUS_SCHEMA) {
    throw new Error(
      `Daemon status schema must be ${DAEMON_STATUS_SCHEMA}, got ${String(value.schema)}.`,
    );
  }
  if (value.service === undefined) {
    throw new Error("Daemon status.service is required.");
  }
  const service = readService(value.service);
  const requestedRepo = readRepoStatus(value.requestedRepo, "requestedRepo");
  if (!Array.isArray(value.repos)) {
    throw new Error("Daemon status.repos must be an array.");
  }
  const repos = value.repos.map((entry, index) =>
    readRepoStatus(entry, `repos[${index}]`),
  );
  return {
    schema: DAEMON_STATUS_SCHEMA,
    service,
    requestedRepo,
    repos,
  };
}

function readService(value: unknown): DaemonServiceStatus {
  if (!isRecord(value)) {
    throw new Error("Daemon status.service must be an object.");
  }
  if (typeof value.daemonId !== "string" || value.daemonId.length === 0) {
    throw new Error("Daemon status.service.daemonId must be a non-empty string.");
  }
  if (!isNonNegInt(value.pid) || value.pid < 1) {
    throw new Error("Daemon status.service.pid must be a positive integer.");
  }
  if (typeof value.endpoint !== "string" || value.endpoint.length === 0) {
    throw new Error("Daemon status.service.endpoint must be a non-empty string.");
  }
  if (typeof value.userRoot !== "string" || value.userRoot.length === 0) {
    throw new Error("Daemon status.service.userRoot must be a non-empty string.");
  }
  if (typeof value.started !== "boolean") {
    throw new Error("Daemon status.service.started must be a boolean.");
  }
  if (typeof value.startedAt !== "string") {
    throw new Error("Daemon status.service.startedAt must be a string.");
  }
  if (!isNonNegInt(value.uptimeMs)) {
    throw new Error("Daemon status.service.uptimeMs must be a non-negative integer.");
  }
  const build = readBuild(value.build);
  const queue = readQueue(value.queue, "service.queue");
  const connections = readConnections(value.connections);
  if (!isNonNegInt(value.repoCount)) {
    throw new Error("Daemon status.service.repoCount must be a non-negative integer.");
  }
  if (!isNonNegInt(value.attachedCount)) {
    throw new Error("Daemon status.service.attachedCount must be a non-negative integer.");
  }
  if (!isNonNegInt(value.unavailableCount)) {
    throw new Error(
      "Daemon status.service.unavailableCount must be a non-negative integer.",
    );
  }
  if (!isNullableString(value.lastReconcileAt)) {
    throw new Error(
      "Daemon status.service.lastReconcileAt must be a string or null.",
    );
  }
  const lastReconcileError = readReconcileError(
    value.lastReconcileError,
    "service.lastReconcileError",
  );
  const activeControl = readActiveControl(value.activeControl);
  return {
    daemonId: value.daemonId,
    pid: value.pid,
    endpoint: value.endpoint,
    userRoot: value.userRoot,
    started: value.started,
    startedAt: value.startedAt,
    uptimeMs: value.uptimeMs,
    build,
    queue,
    connections,
    repoCount: value.repoCount,
    attachedCount: value.attachedCount,
    unavailableCount: value.unavailableCount,
    lastReconcileAt: value.lastReconcileAt,
    lastReconcileError,
    activeControl,
  };
}

function readBuild(value: unknown): DaemonBuildInfo {
  if (!isRecord(value)) {
    throw new Error("Daemon status.service.build must be an object.");
  }
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error("Daemon status.service.build.version must be a non-empty string.");
  }
  if (typeof value.loadedIdentity !== "string") {
    throw new Error("Daemon status.service.build.loadedIdentity must be a string.");
  }
  if (typeof value.installedIdentity !== "string") {
    throw new Error(
      "Daemon status.service.build.installedIdentity must be a string.",
    );
  }
  if (value.identitySource !== "installed-artifact-set") {
    throw new Error(
      "Daemon status.service.build.identitySource must be installed-artifact-set.",
    );
  }
  if (typeof value.stale !== "boolean") {
    throw new Error("Daemon status.service.build.stale must be a boolean.");
  }
  return {
    version: value.version,
    loadedIdentity: value.loadedIdentity,
    installedIdentity: value.installedIdentity,
    identitySource: "installed-artifact-set",
    stale: value.stale,
  };
}

function readActiveControl(value: unknown): DaemonActiveControl | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new Error("Daemon status.service.activeControl must be an object or null.");
  }
  if (typeof value.operationId !== "string" || value.operationId.length === 0) {
    throw new Error(
      "Daemon status.service.activeControl.operationId must be a non-empty string.",
    );
  }
  if (typeof value.kind !== "string" || !CONTROL_KINDS.has(value.kind as DaemonControlKind)) {
    throw new Error(
      "Daemon status.service.activeControl.kind must be restart or refresh.",
    );
  }
  if (
    typeof value.phase !== "string" ||
    !CONTROL_PHASES.has(value.phase as DaemonControlPhase)
  ) {
    throw new Error("Daemon status.service.activeControl.phase is invalid.");
  }
  if (typeof value.requestedAt !== "string") {
    throw new Error(
      "Daemon status.service.activeControl.requestedAt must be a string.",
    );
  }
  return {
    operationId: value.operationId,
    kind: value.kind as DaemonControlKind,
    phase: value.phase as DaemonControlPhase,
    requestedAt: value.requestedAt,
  };
}

function readLock(value: unknown, label: string): DaemonLockInfo {
  if (!isRecord(value)) {
    throw new Error(`Daemon status.${label}.lock must be an object.`);
  }
  if (!isNullableString(value.path)) {
    throw new Error(`Daemon status.${label}.lock.path must be a string or null.`);
  }
  // Wire may also carry lock-owner identity; the System panel does not surface it.
  return { path: value.path };
}

function readQueue(value: unknown, label: string): DaemonQueueLanes {
  if (!isRecord(value)) {
    throw new Error(`Daemon status.${label} must be an object.`);
  }
  for (const lane of ["interactive", "normal", "background", "maintenance"] as const) {
    if (!isNonNegInt(value[lane])) {
      throw new Error(
        `Daemon status.${label}.${lane} must be a non-negative integer.`,
      );
    }
  }
  if (typeof value.running !== "boolean") {
    throw new Error(`Daemon status.${label}.running must be a boolean.`);
  }
  if (!isNonNegInt(value.depth)) {
    throw new Error(`Daemon status.${label}.depth must be a non-negative integer.`);
  }
  return {
    interactive: value.interactive as number,
    normal: value.normal as number,
    background: value.background as number,
    maintenance: value.maintenance as number,
    running: value.running,
    depth: value.depth as number,
  };
}

function readConnections(value: unknown): DaemonConnections {
  if (!isRecord(value)) {
    throw new Error("Daemon status.service.connections must be an object.");
  }
  if (!isNonNegInt(value.active) || !isNonNegInt(value.total)) {
    throw new Error(
      "Daemon status.service.connections.active/total must be non-negative integers.",
    );
  }
  return { active: value.active as number, total: value.total as number };
}

function readReconcileError(
  value: unknown,
  label: string,
): DaemonReconcileError | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new Error(`Daemon status.${label} must be an object or null.`);
  }
  if (typeof value.at !== "string") {
    throw new Error(`Daemon status.${label}.at must be a string.`);
  }
  if (typeof value.code !== "string" || value.code.length === 0) {
    throw new Error(`Daemon status.${label}.code must be a non-empty string.`);
  }
  if (typeof value.message !== "string" || value.message.length === 0) {
    throw new Error(`Daemon status.${label}.message must be a non-empty string.`);
  }
  if (!isNullableString(value.repoId)) {
    throw new Error(`Daemon status.${label}.repoId must be a string or null.`);
  }
  return {
    at: value.at,
    code: value.code,
    message: value.message,
    repoId: value.repoId,
  };
}

function readRepoStatus(value: unknown, label: string): DaemonRepoStatus {
  if (!isRecord(value)) {
    throw new Error(`Daemon status.${label} must be an object.`);
  }
  if (typeof value.repoId !== "string" || value.repoId.length === 0) {
    throw new Error(`Daemon status.${label}.repoId must be a non-empty string.`);
  }
  if (typeof value.canonicalRoot !== "string" || value.canonicalRoot.length === 0) {
    throw new Error(
      `Daemon status.${label}.canonicalRoot must be a non-empty string.`,
    );
  }
  if (typeof value.state !== "string" || !REPO_STATES.has(value.state as DaemonRepoState)) {
    throw new Error(
      `Daemon status.${label}.state must be attached|unavailable|detaching|detached.`,
    );
  }
  if (value.displayName !== undefined && typeof value.displayName !== "string") {
    throw new Error(`Daemon status.${label}.displayName must be a string when present.`);
  }
  if (!isNullableString(value.lastError)) {
    throw new Error(`Daemon status.${label}.lastError must be a string or null.`);
  }
  if (!isNullableString(value.lastMaterializerError)) {
    throw new Error(
      `Daemon status.${label}.lastMaterializerError must be a string or null.`,
    );
  }
  return {
    repoId: value.repoId,
    canonicalRoot: value.canonicalRoot,
    ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
    state: value.state as DaemonRepoState,
    lock: readLock(value.lock, label),
    queue: readQueue(value.queue, `${label}.queue`),
    lastRecovery: value.lastRecovery ?? null,
    projectionGeneration: value.projectionGeneration ?? null,
    lastError: value.lastError,
    lastMaterializerError: value.lastMaterializerError,
    lastReconcileError: readReconcileError(
      value.lastReconcileError,
      `${label}.lastReconcileError`,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
