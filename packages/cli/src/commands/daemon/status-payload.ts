import {
  currentDaemonProtocolVersion,
  type JsonObject,
  type JsonValue
} from "../../../../daemon/src/index.ts";
import { resolveCliVersion } from "../core/version.ts";

export interface DaemonConnectionStats {
  active: number;
  total: number;
}

export interface DaemonStatusRuntimeRepo {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly state: string;
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
}): JsonObject {
  const selectedRepo = input.runtimeStatus.repos?.find((repo) => repo.repoId === input.repoId) ?? input.runtimeStatus.repos?.[0];
  const queue = selectedRepo?.queue ?? input.runtimeStatus.queue ?? emptyDaemonQueue;
  const lockPath = selectedRepo?.lockPath ?? input.runtimeStatus.lockPath;
  const lockOwnerToken = selectedRepo?.lockOwnerToken ?? input.runtimeStatus.lockOwnerToken;
  const lastRecovery = selectedRepo?.lastRecovery ?? input.runtimeStatus.lastRecovery ?? null;
  const projectionGeneration = selectedRepo?.projectionGeneration ?? null;
  const rootDir = selectedRepo?.canonicalRoot ?? input.rootDir;
  const repoId = selectedRepo?.repoId ?? input.repoId;
  const queueDepth = queue.interactive
    + queue.normal
    + queue.background
    + queue.maintenance;
  return {
    schema: "daemon-status/v1",
    started: input.runtimeStatus.started,
    daemonId: input.daemonId,
    pid: process.pid,
    rootDir,
    repoId,
    endpoint: input.endpoint,
    version: resolveCliVersion(),
    protocolVersion: currentDaemonProtocolVersion,
    lock: {
      path: lockPath ?? null,
      ownerToken: lockOwnerToken ?? null
    },
    queue,
    queueDepth,
    connections: {
      active: input.connections.active,
      total: input.connections.total
    },
    lastRecovery: toJsonValue(lastRecovery),
    projectionGeneration: toJsonValue(projectionGeneration),
    ...(input.runtimeStatus.repos ? {
      repos: input.runtimeStatus.repos.map((repo) => ({
        repoId: repo.repoId,
        canonicalRoot: repo.canonicalRoot,
        state: repo.state,
        lockPath: repo.lockPath ?? null,
        lockOwnerToken: repo.lockOwnerToken ?? null,
        queue: repo.queue,
        lastRecovery: toJsonValue(repo.lastRecovery ?? null),
        projectionGeneration: toJsonValue(repo.projectionGeneration ?? null),
        lastError: repo.lastError ?? null,
        lastMaterializerError: repo.lastMaterializerError ?? null
      }))
    } : {})
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
