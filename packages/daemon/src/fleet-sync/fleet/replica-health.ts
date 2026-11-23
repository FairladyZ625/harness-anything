import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { writeFileDurably } from "@harness-anything/storage";

export const replicaBootstrapSteps = ["basebackup", "objects", "installing", "projecting"] as const;
export type ReplicaBootstrapStep = (typeof replicaBootstrapSteps)[number];

export interface ReplicaSyncProgress {
  readonly step: ReplicaBootstrapStep;
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
  readonly receivedObjects?: number;
  readonly totalObjects?: number;
  readonly updatedAt: string;
}

interface ReplicaHealth {
  readonly rebuildCount: number;
  readonly lastHeartbeatAt: string | null;
  readonly syncFailure: { readonly code: string; readonly message: string } | null;
  readonly modelFailure: { readonly code: string; readonly message: string } | null;
  readonly syncProgress?: ReplicaSyncProgress | null;
}
const empty: ReplicaHealth = {
  rebuildCount: 0,
  lastHeartbeatAt: null,
  syncFailure: null,
  modelFailure: null,
  syncProgress: null,
};
const file = (viewDir: string) => path.join(viewDir, "replica-health.json");
const healthEvents = new EventEmitter();
healthEvents.setMaxListeners(0);

/** Subscribes to in-process replica health transitions for one edge view directory. */
export function subscribeReplicaHealthChange(viewDir: string, listener: () => void): () => void {
  const key = path.resolve(viewDir);
  healthEvents.on(key, listener);
  return () => {
    healthEvents.off(key, listener);
  };
}

export function notifyReplicaHealthChange(viewDir: string): void {
  healthEvents.emit(path.resolve(viewDir));
}

export function parseReplicaSyncProgress(value: unknown): ReplicaSyncProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const step = candidate.step as ReplicaBootstrapStep;
  if (!replicaBootstrapSteps.includes(step)) return null;
  if (!Number.isSafeInteger(candidate.receivedBytes) || Number(candidate.receivedBytes) < 0) return null;
  const receivedBytes = Number(candidate.receivedBytes);
  if (
    candidate.totalBytes !== null &&
    (!Number.isSafeInteger(candidate.totalBytes) || Number(candidate.totalBytes) < receivedBytes)
  ) {
    return null;
  }
  const totalBytes = candidate.totalBytes === null ? null : Number(candidate.totalBytes);
  if (
    candidate.receivedObjects !== undefined &&
    (!Number.isSafeInteger(candidate.receivedObjects) || Number(candidate.receivedObjects) < 0)
  ) {
    return null;
  }
  if (
    candidate.totalObjects !== undefined &&
    (!Number.isSafeInteger(candidate.totalObjects) ||
      Number(candidate.totalObjects) < Number(candidate.receivedObjects ?? 0))
  ) {
    return null;
  }
  if (typeof candidate.updatedAt !== "string" || !Number.isFinite(Date.parse(candidate.updatedAt))) return null;
  return {
    step,
    receivedBytes,
    totalBytes,
    ...(candidate.receivedObjects !== undefined ? { receivedObjects: Number(candidate.receivedObjects) } : {}),
    ...(candidate.totalObjects !== undefined ? { totalObjects: Number(candidate.totalObjects) } : {}),
    updatedAt: candidate.updatedAt,
  };
}

/** Missing observations are unknown; malformed observations are errors, never a healthy zero. */
export function readReplicaHealth(viewDir: string): ReplicaHealth {
  try {
    const value = JSON.parse(readFileSync(file(viewDir), "utf8")) as ReplicaHealth;
    const failure = (v: ReplicaHealth["syncFailure"]) =>
      v === null || (typeof v === "object" && typeof v.code === "string" && typeof v.message === "string");
    const lastHeartbeatAt = value.lastHeartbeatAt === undefined ? null : value.lastHeartbeatAt;
    const rawProgress = value.syncProgress === undefined ? null : value.syncProgress;
    const syncProgress = rawProgress === null ? null : parseReplicaSyncProgress(rawProgress);
    if (
      !Number.isSafeInteger(value.rebuildCount) ||
      value.rebuildCount < 0 ||
      (lastHeartbeatAt !== null && typeof lastHeartbeatAt !== "string") ||
      !failure(value.syncFailure) ||
      !failure(value.modelFailure) ||
      (rawProgress !== null && syncProgress === null)
    )
      throw new Error("Replica health observations are malformed");
    return { ...value, lastHeartbeatAt, syncProgress };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
}

export function activeReplicaSyncProgress(
  health: ReplicaHealth,
  nowMs: number = Date.now(),
): ReplicaSyncProgress | null {
  const progress = health.syncProgress ?? null;
  if (!progress || health.syncFailure !== null || health.modelFailure !== null) return null;
  const ageMs = nowMs - Date.parse(progress.updatedAt);
  const maxFreshAgeMs = storageReadPolicy.defaultValue.deadlines.query * 4;
  return Number.isFinite(ageMs) && ageMs <= maxFreshAgeMs ? progress : null;
}

function formatByteSize(bytes: number): string {
  const gib = 1024 * 1024 * 1024;
  const mib = 1024 * 1024;
  const kib = 1024;
  if (bytes >= gib) return `${(bytes / gib).toFixed(2)} GiB`;
  if (bytes >= mib) return `${(bytes / mib).toFixed(1)} MiB`;
  if (bytes >= kib) return `${(bytes / kib).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function formatReplicaSyncProgressHint(progress: ReplicaSyncProgress): string {
  const parts: string[] = [progress.step];
  if (progress.totalObjects !== undefined && progress.receivedObjects !== undefined) {
    parts.push(`${progress.receivedObjects}/${progress.totalObjects} objects`);
  }
  if (progress.totalBytes !== null && progress.totalBytes > 0) {
    const pct = Math.min(100, Math.floor((progress.receivedBytes / progress.totalBytes) * 100));
    parts.push(`${formatByteSize(progress.receivedBytes)} / ${formatByteSize(progress.totalBytes)} (${pct}%)`);
  } else if (progress.receivedBytes > 0) {
    parts.push(formatByteSize(progress.receivedBytes));
  }
  return `Initial edge replica sync in progress (${parts.join(" · ")}).`;
}

export function recordReplicaHealth(viewDir: string, change: Partial<ReplicaHealth>): void {
  const before = readReplicaHealth(viewDir),
    after = { ...before, ...change };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  writeFileDurably(file(viewDir), JSON.stringify(after));
  notifyReplicaHealthChange(viewDir);
}

export function replicaFailure(error: unknown, code: string) {
  const observed = error as { readonly code?: unknown } | null;
  return {
    code: typeof observed?.code === "string" ? observed.code : code,
    message: error instanceof Error ? error.message : String(error),
  };
}
