import { validateRepositoryReadFrame, type RepositoryReadFrame } from "@harness-anything/daemon/protocol";
import { isRendererRecord } from "./result-validation.ts";

/** Preserve the daemon's cut when a renderer parser unwraps or assembles a result. */
export function repositoryReadFrame(value: unknown): Partial<RepositoryReadFrame> {
  if (!isRendererRecord(value) || !Object.hasOwn(value, "freshness")) return {};
  const errors = validateRepositoryReadFrame(value);
  if (errors.length) throw new Error(errors.join("; "));
  const frame = value as unknown as RepositoryReadFrame;
  return { cut: frame.cut, freshness: frame.freshness, warning: frame.warning };
}

const reportedReadFailures = new Set([
  "replica_unavailable",
  "replica_syncing",
  "authorization_denied",
  "authentication_required",
]);

export type ReplicaBootstrapStep = "basebackup" | "objects" | "installing" | "projecting";

export interface ReplicaSyncProgressRead {
  readonly step: ReplicaBootstrapStep;
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
  readonly receivedObjects?: number;
  readonly totalObjects?: number;
  readonly updatedAt: string;
}

function parseReplicaSyncProgress(value: unknown): ReplicaSyncProgressRead | null {
  if (!isRendererRecord(value) || typeof value.step !== "string") return null;
  if (!["basebackup", "objects", "installing", "projecting"].includes(value.step)) return null;
  if (typeof value.receivedBytes !== "number" || typeof value.updatedAt !== "string") return null;
  if (value.totalBytes !== null && typeof value.totalBytes !== "number") return null;
  return {
    step: value.step as ReplicaBootstrapStep,
    receivedBytes: value.receivedBytes,
    totalBytes: value.totalBytes,
    ...(typeof value.receivedObjects === "number" ? { receivedObjects: value.receivedObjects } : {}),
    ...(typeof value.totalObjects === "number" ? { totalObjects: value.totalObjects } : {}),
    updatedAt: value.updatedAt,
  };
}

export function repositoryReadFailure(value: unknown): Error | null {
  if (!isRendererRecord(value) || value.ok !== false) return null;
  const detail = isRendererRecord(value.error) ? value.error : value,
    code = detail.code ?? value.code;
  if (typeof code !== "string" || !reportedReadFailures.has(code)) return null;
  const syncProgress = parseReplicaSyncProgress(detail.syncProgress ?? value.syncProgress);
  return Object.assign(new Error(String(detail.hint ?? detail.message ?? value.rejectionExplanation ?? code)), {
    code,
    ...(syncProgress ? { syncProgress } : {}),
  });
}

export function extractReplicaSyncProgress(error: unknown): ReplicaSyncProgressRead | null {
  if (!(error instanceof Error) || !("syncProgress" in error)) return null;
  return parseReplicaSyncProgress(error.syncProgress);
}

export function isLedgerUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "replica_unavailable" || error.code === "replica_syncing" || error.code === "authorization_denied")
  );
}

export function replicaSyncPercent(progress: ReplicaSyncProgressRead | null): number | null {
  if (!progress) return null;
  if (progress.totalBytes !== null && progress.totalBytes > 0) {
    return Math.min(100, Math.max(0, Math.floor((progress.receivedBytes / progress.totalBytes) * 100)));
  }
  if (
    typeof progress.totalObjects === "number" &&
    progress.totalObjects > 0 &&
    typeof progress.receivedObjects === "number"
  ) {
    return Math.min(100, Math.max(0, Math.floor((progress.receivedObjects / progress.totalObjects) * 100)));
  }
  return null;
}

export function formatSyncBytes(bytes: number): string {
  const gib = 1024 * 1024 * 1024;
  const mib = 1024 * 1024;
  const kib = 1024;
  if (bytes >= gib) return `${(bytes / gib).toFixed(2)} GiB`;
  if (bytes >= mib) return `${(bytes / mib).toFixed(1)} MiB`;
  if (bytes >= kib) return `${(bytes / kib).toFixed(1)} KiB`;
  return `${bytes} B`;
}
