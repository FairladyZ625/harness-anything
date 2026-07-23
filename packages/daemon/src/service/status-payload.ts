import type {
  DaemonActiveControlStatus,
  DaemonAdmissionStatus,
  DaemonDeploymentStatus,
  DaemonQueueStatus,
  DaemonRepoStatus,
  DaemonStatusResultV2
} from "@harness-anything/application";
import type { JsonObject, JsonValue } from "../protocol/json-rpc-types.ts";
import type { DaemonReconcileError, DaemonReconcileState } from "../runtime/registry-reconciler.ts";

export interface DaemonConnectionStats {
  active: number;
  total: number;
}

export interface DaemonStatusRuntimeRepo {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly state: string;
  readonly displayName?: string;
  readonly lockPath?: string;
  readonly lockOwnerToken?: string;
  readonly queue: {
    readonly interactive: number;
    readonly normal: number;
    readonly background: number;
    readonly maintenance: number;
    readonly running: boolean;
    readonly admission?: DaemonAdmissionStatus;
  };
  readonly lastRecovery?: unknown;
  readonly lastError?: string;
  readonly lastMaterializerError?: string;
  readonly projectionGeneration?: unknown;
  readonly runtimeRegistrationId?: string;
  readonly daemonGeneration?: number;
}

const emptyDaemonQueue = { interactive: 0, normal: 0, background: 0, maintenance: 0, running: false } as const;
const emptyAdmission: DaemonAdmissionStatus = {
  limits: { maxOperations: 0, maxBytes: 0, reservedOperationsPerPlane: 0, reservedBytesPerPlane: 0 },
  used: { operations: 0, bytes: 0, authorityOperations: 0, authorityBytes: 0, jsonRpcOperations: 0, jsonRpcBytes: 0 },
  rejected: { authority: 0, "json-rpc": 0 }
};

export function daemonStatusPayload(input: {
  readonly daemonId: string;
  readonly rootDir: string;
  readonly repoId: string;
  readonly endpoint: string;
  readonly userRoot: string;
  readonly startedAt: string;
  readonly loadedIdentity: string;
  readonly version: string;
  readonly readInstalledIdentity: () => string;
  readonly readDeploymentStatus?: (installedIdentity: string) => DaemonDeploymentStatus;
  readonly activeControl: DaemonActiveControlStatus | null;
  readonly runtimeStatus: {
    readonly started: boolean;
    readonly lockPath?: string;
    readonly lockOwnerToken?: string;
    readonly queue?: {
      readonly interactive: number;
      readonly normal: number;
      readonly background: number;
      readonly maintenance: number;
      readonly running: boolean;
    };
    readonly lastRecovery?: unknown;
    readonly repos?: ReadonlyArray<DaemonStatusRuntimeRepo>;
  };
  readonly connections: DaemonConnectionStats;
  readonly generationAxes?: { readonly machineId: string; readonly daemonGeneration: number };
  readonly includeGenerationAxes?: true;
  readonly includeDeploymentIdentity?: true;
  readonly reconcileStatus?: Pick<DaemonReconcileState, "lastReconcileAt" | "lastReconcileError" | "repoErrors">;
}): DaemonStatusResultV2 {
  const runtimeRepos = input.runtimeStatus.repos ?? [];
  const repos = runtimeRepos.map((repo) => repoStatus(repo, input.reconcileStatus, input));
  const selectedRepo = repos.find((repo) => repo.repoId === input.repoId) ?? repoStatus({
    repoId: input.repoId,
    canonicalRoot: input.rootDir,
    state: input.runtimeStatus.started ? "attached" : "detached",
    lockPath: input.runtimeStatus.lockPath,
    lockOwnerToken: input.runtimeStatus.lockOwnerToken,
    queue: input.runtimeStatus.queue ?? emptyDaemonQueue,
    lastRecovery: input.runtimeStatus.lastRecovery
  }, input.reconcileStatus, input);
  const aggregateQueue = aggregateQueues(repos.length > 0 ? repos.map((repo) => repo.queue) : [selectedRepo.queue]);
  const installedIdentity = input.readInstalledIdentity();
  return {
    schema: "daemon-status/v2",
    daemonId: input.daemonId,
    pid: process.pid,
    started: input.runtimeStatus.started,
    rootDir: selectedRepo.canonicalRoot,
    repoId: selectedRepo.repoId,
    endpoint: input.endpoint,
    version: input.version,
    protocolVersion: 1,
    queue: selectedRepo.queue,
    queueDepth: selectedRepo.queue.depth,
    connections: {
      active: input.connections.active,
      total: input.connections.total
    },
    lastReconcileAt: input.reconcileStatus?.lastReconcileAt ?? null,
    lastReconcileError: reconcileErrorPayload(input.reconcileStatus?.lastReconcileError ?? null),
    lastRecovery: selectedRepo.lastRecovery,
    projectionGeneration: selectedRepo.projectionGeneration,
    service: {
      daemonId: input.daemonId,
      pid: process.pid,
      endpoint: input.endpoint,
      userRoot: input.userRoot,
      started: input.runtimeStatus.started,
      startedAt: input.startedAt,
      uptimeMs: Math.max(0, Date.now() - Date.parse(input.startedAt)),
      build: {
        version: input.version,
        loadedIdentity: input.loadedIdentity,
        installedIdentity,
        identitySource: "installed-artifact-set",
        stale: installedIdentity !== input.loadedIdentity
      },
      ...(input.includeDeploymentIdentity && input.readDeploymentStatus
        ? { deployment: input.readDeploymentStatus(installedIdentity) }
        : {}),
      queue: aggregateQueue,
      connections: {
        active: input.connections.active,
        total: input.connections.total
      },
      repoCount: repos.length,
      attachedCount: repos.filter((repo) => repo.state === "attached").length,
      unavailableCount: repos.filter((repo) => repo.state === "unavailable").length,
      lastReconcileAt: input.reconcileStatus?.lastReconcileAt ?? null,
      lastReconcileError: reconcileErrorPayload(input.reconcileStatus?.lastReconcileError ?? null),
      activeControl: projectActiveControl(input.activeControl, input.includeGenerationAxes === true),
      ...(input.includeGenerationAxes && input.generationAxes ? {
        machineId: input.generationAxes.machineId,
        daemonGeneration: input.generationAxes.daemonGeneration
      } : {})
    },
    requestedRepo: selectedRepo,
    repos
  };
}

function projectActiveControl(
  activeControl: DaemonActiveControlStatus | null,
  includeGenerationAxes: boolean
): DaemonActiveControlStatus | null {
  if (!activeControl || includeGenerationAxes
    || (activeControl.machineId === undefined && activeControl.daemonGeneration === undefined)) return activeControl;
  const { machineId: _machineId, daemonGeneration: _daemonGeneration, ...legacy } = activeControl;
  return legacy;
}

function repoStatus(
  repo: DaemonStatusRuntimeRepo,
  reconcileStatus: Pick<DaemonReconcileState, "lastReconcileAt" | "lastReconcileError" | "repoErrors"> | undefined,
  projection: {
    readonly includeGenerationAxes?: true;
    readonly generationAxes?: { readonly daemonGeneration: number };
  }
): DaemonRepoStatus {
  const state = repo.state === "attached" || repo.state === "unavailable" || repo.state === "detaching" || repo.state === "detached"
    ? repo.state
    : "unavailable";
  return {
    repoId: repo.repoId,
    canonicalRoot: repo.canonicalRoot,
    ...(repo.displayName ? { displayName: repo.displayName } : {}),
    state,
    lock: { path: repo.lockPath ?? null, ownerToken: repo.lockOwnerToken ?? null },
    queue: queueStatus(repo.queue),
    lastRecovery: toStatusJsonValue(repo.lastRecovery ?? null),
    projectionGeneration: toStatusJsonValue(repo.projectionGeneration ?? null),
    lastError: repo.lastError ?? null,
    lastMaterializerError: repo.lastMaterializerError ?? null,
    lastReconcileError: reconcileErrorPayload(reconcileStatus?.repoErrors.get(repo.repoId) ?? null),
    ...(projection.includeGenerationAxes && repo.runtimeRegistrationId !== undefined
      ? { runtimeRegistrationId: repo.runtimeRegistrationId } : {}),
    ...(projection.includeGenerationAxes && (repo.daemonGeneration ?? projection.generationAxes?.daemonGeneration) !== undefined
      ? { daemonGeneration: (repo.daemonGeneration ?? projection.generationAxes?.daemonGeneration)! } : {})
  };
}

function queueStatus(queue: Omit<DaemonQueueStatus, "depth" | "admission"> & { readonly admission?: DaemonAdmissionStatus }): DaemonQueueStatus {
  return {
    ...queue,
    admission: queue.admission ?? emptyAdmission,
    depth: queue.interactive + queue.normal + queue.background + queue.maintenance
  };
}

function aggregateQueues(queues: ReadonlyArray<DaemonQueueStatus>): DaemonQueueStatus {
  return queues.reduce<DaemonQueueStatus>((total, queue) => ({
    interactive: total.interactive + queue.interactive,
    normal: total.normal + queue.normal,
    background: total.background + queue.background,
    maintenance: total.maintenance + queue.maintenance,
    running: total.running || queue.running,
    depth: total.depth + queue.depth,
    admission: aggregateAdmissions(total.admission ?? emptyAdmission, queue.admission ?? emptyAdmission)
  }), { interactive: 0, normal: 0, background: 0, maintenance: 0, running: false, depth: 0, admission: emptyAdmission });
}

function aggregateAdmissions(left: DaemonAdmissionStatus, right: DaemonAdmissionStatus): DaemonAdmissionStatus {
  return {
    limits: {
      maxOperations: left.limits.maxOperations + right.limits.maxOperations,
      maxBytes: left.limits.maxBytes + right.limits.maxBytes,
      reservedOperationsPerPlane: left.limits.reservedOperationsPerPlane + right.limits.reservedOperationsPerPlane,
      reservedBytesPerPlane: left.limits.reservedBytesPerPlane + right.limits.reservedBytesPerPlane
    },
    used: {
      operations: left.used.operations + right.used.operations,
      bytes: left.used.bytes + right.used.bytes,
      authorityOperations: left.used.authorityOperations + right.used.authorityOperations,
      authorityBytes: left.used.authorityBytes + right.used.authorityBytes,
      jsonRpcOperations: left.used.jsonRpcOperations + right.used.jsonRpcOperations,
      jsonRpcBytes: left.used.jsonRpcBytes + right.used.jsonRpcBytes
    },
    rejected: { authority: left.rejected.authority + right.rejected.authority, "json-rpc": left.rejected["json-rpc"] + right.rejected["json-rpc"] }
  };
}

function reconcileErrorPayload(error: DaemonReconcileError | null): DaemonStatusResultV2["service"]["lastReconcileError"] {
  if (!error) return null;
  return {
    at: error.at,
    code: error.code,
    message: error.message,
    repoId: error.repoId
  };
}

function toStatusJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toStatusJsonValue);
  if (!isStatusRecord(value)) return String(value);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toStatusJsonValue(entry)])) as JsonObject;
}

function isStatusRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
