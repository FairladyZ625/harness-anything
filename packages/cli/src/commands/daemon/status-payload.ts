import {
  type DaemonActiveControlStatus,
  type DaemonQueueStatus,
  type DaemonRepoStatus,
  type DaemonStatusResultV2,
  type JsonObject,
  type JsonValue
} from "../../../../daemon/src/index.ts";
import { resolveCliVersion } from "../core/version.ts";
import type {
  DaemonReconcileError,
  DaemonReconcileState
} from "../../daemon/registry-reconciler.ts";

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
  };
  readonly lastRecovery?: unknown;
  readonly lastError?: string;
  readonly lastMaterializerError?: string;
  readonly projectionGeneration?: unknown;
}

const emptyDaemonQueue = { interactive: 0, normal: 0, background: 0, maintenance: 0, running: false } as const;

export function daemonStatusPayload(input: {
  readonly daemonId: string;
  readonly rootDir: string;
  readonly repoId: string;
  readonly endpoint: string;
  readonly userRoot: string;
  readonly startedAt: string;
  readonly loadedIdentity: string;
  readonly readInstalledIdentity: () => string;
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
  readonly reconcileStatus?: Pick<DaemonReconcileState, "lastReconcileAt" | "lastReconcileError" | "repoErrors">;
}): DaemonStatusResultV2 {
  const runtimeRepos = input.runtimeStatus.repos ?? [];
  const repos = runtimeRepos.map((repo) => repoStatus(repo, input.reconcileStatus));
  const selectedRepo = repos.find((repo) => repo.repoId === input.repoId) ?? repoStatus({
    repoId: input.repoId,
    canonicalRoot: input.rootDir,
    state: input.runtimeStatus.started ? "attached" : "detached",
    lockPath: input.runtimeStatus.lockPath,
    lockOwnerToken: input.runtimeStatus.lockOwnerToken,
    queue: input.runtimeStatus.queue ?? emptyDaemonQueue,
    lastRecovery: input.runtimeStatus.lastRecovery
  }, input.reconcileStatus);
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
    version: resolveCliVersion(),
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
        version: resolveCliVersion(),
        loadedIdentity: input.loadedIdentity,
        installedIdentity,
        identitySource: "installed-artifact-set",
        stale: installedIdentity !== input.loadedIdentity
      },
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
      activeControl: input.activeControl
    },
    requestedRepo: selectedRepo,
    repos
  };
}

export function daemonStatusCliProjection(status: DaemonStatusResultV2): Record<string, unknown> {
  return {
    ...status,
    ...status.service,
    version: status.service.build.version,
    protocolVersion: 1,
    rootDir: status.requestedRepo.canonicalRoot,
    repoId: status.requestedRepo.repoId,
    lock: status.requestedRepo.lock,
    lockPath: status.requestedRepo.lock.path,
    lockOwnerToken: status.requestedRepo.lock.ownerToken,
    queueDepth: status.service.queue.depth,
    repos: status.repos.map((repo) => ({
      ...repo,
      lockPath: repo.lock.path,
      lockOwnerToken: repo.lock.ownerToken
    }))
  };
}

function repoStatus(
  repo: DaemonStatusRuntimeRepo,
  reconcileStatus: Pick<DaemonReconcileState, "lastReconcileAt" | "lastReconcileError" | "repoErrors"> | undefined
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
    lastRecovery: toJsonValue(repo.lastRecovery ?? null),
    projectionGeneration: toJsonValue(repo.projectionGeneration ?? null),
    lastError: repo.lastError ?? null,
    lastMaterializerError: repo.lastMaterializerError ?? null,
    lastReconcileError: reconcileErrorPayload(reconcileStatus?.repoErrors.get(repo.repoId) ?? null)
  };
}

function queueStatus(queue: Omit<DaemonQueueStatus, "depth">): DaemonQueueStatus {
  return {
    ...queue,
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
    depth: total.depth + queue.depth
  }), { interactive: 0, normal: 0, background: 0, maintenance: 0, running: false, depth: 0 });
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

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (!isStatusRecord(value)) return String(value);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)])) as JsonObject;
}

function isStatusRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
