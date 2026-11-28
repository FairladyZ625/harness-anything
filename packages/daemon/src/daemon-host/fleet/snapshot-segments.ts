import path from "node:path";
import type {
  BaseBackupFormat,
  BaseBackupMetadata,
  BaseBackupMode,
  BaseBackupObjectEntry,
  ReplicationPosition,
} from "@harness-anything/storage";
import { isBaseBackupMetadata, isReplicationPosition } from "../../fleet-sync/fleet/protocol.ts";

/** Default fixed-revision boundary spacing for center immutable snapshot segments (CH4). */
export const DEFAULT_SNAPSHOT_SEGMENT_BOUNDARY_REVISIONS = 50_000;

export interface SnapshotPinRecord {
  readonly schema: "fleet-snapshot-pin/v1";
  readonly snapshotId: string;
  readonly repoId: string;
  readonly mode?: BaseBackupMode;
  readonly format?: BaseBackupFormat;
  readonly segmentRevision?: number;
  readonly metadata: BaseBackupMetadata;
  readonly position: ReplicationPosition;
  readonly size: number;
  readonly sha256: string;
  readonly archiveFile: string;
  readonly objects?: readonly BaseBackupObjectEntry[];
  readonly objectCount?: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ValidatedSnapshotPin {
  readonly pin: SnapshotPinRecord;
  readonly mode: BaseBackupMode;
  readonly format: BaseBackupFormat;
  readonly segmentRevision: number | null;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export function parseSnapshotPinRecord(
  raw: string,
  expectedSnapshotId: string,
  expectedRepoId: string,
  nowMs: number,
): ValidatedSnapshotPin | null {
  const pin = JSON.parse(raw) as Partial<SnapshotPinRecord>;
  const createdAtMs = typeof pin.createdAt === "string" ? Date.parse(pin.createdAt) : Number.NaN;
  const expiresAtMs = typeof pin.expiresAt === "string" ? Date.parse(pin.expiresAt) : Number.NaN;
  if (
    pin.schema !== "fleet-snapshot-pin/v1" ||
    pin.snapshotId !== expectedSnapshotId ||
    pin.repoId !== expectedRepoId ||
    !isBaseBackupMetadata(pin.metadata) ||
    !isReplicationPosition(pin.position) ||
    !Number.isSafeInteger(pin.size) ||
    (pin.size ?? -1) < 0 ||
    typeof pin.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(pin.sha256) ||
    typeof pin.archiveFile !== "string" ||
    pin.archiveFile.length === 0 ||
    path.isAbsolute(pin.archiveFile) ||
    pin.archiveFile.includes("..") ||
    Number.isNaN(createdAtMs) ||
    Number.isNaN(expiresAtMs) ||
    expiresAtMs <= nowMs
  ) {
    return null;
  }
  const mode: BaseBackupMode = pin.mode === "split" ? "split" : "monolithic";
  if (mode === "split" && !Array.isArray(pin.objects)) return null;
  const format: BaseBackupFormat = pin.format === "v4" || pin.metadata.schema === "fleet-basebackup/v4" ? "v4" : "v3";
  const segmentRevision =
    typeof pin.segmentRevision === "number" && Number.isSafeInteger(pin.segmentRevision) && pin.segmentRevision >= 0
      ? pin.segmentRevision
      : null;
  return {
    pin: pin as SnapshotPinRecord,
    mode,
    format,
    segmentRevision,
    createdAtMs,
    expiresAtMs,
  };
}

export interface CachedBackupEntry {
  readonly snapshotId: string;
  readonly repoId: string;
  readonly mode: BaseBackupMode;
  readonly format: BaseBackupFormat;
  readonly segmentRevision: number | null;
  readonly archive: Promise<import("@harness-anything/storage").BaseBackupArchive>;
  readonly directory: string;
  readonly controller: AbortController;
  readonly queueListeners: Map<
    string,
    (status: import("../../fleet-sync/fleet/basebackup-queue.ts").BaseBackupQueueStatus | null) => void
  >;
  users: number;
  building: boolean;
  retired: boolean;
  acked: boolean;
  createdAtMs: number;
  expiresAtMs: number;
  size: number;
  positionHistory: string | null;
  positionSequence: number | null;
  queueStatus: import("../../fleet-sync/fleet/basebackup-queue.ts").BaseBackupQueueStatus | null;
  releaseRetention: () => void;
}

export function buildCachedBackupFromPin(input: {
  readonly validated: ValidatedSnapshotPin;
  readonly repoId: string;
  readonly snapshotDir: string;
  readonly archivePath: string;
  readonly unpin: () => void;
}): CachedBackupEntry {
  const { pin, mode: pinMode, format: pinFormat, segmentRevision, createdAtMs, expiresAtMs } = input.validated;
  let retained = true;
  const archiveValue: import("@harness-anything/storage").BaseBackupArchive = {
    metadata: pin.metadata,
    file: input.archivePath,
    size: pin.size,
    sha256: pin.sha256,
    mode: pinMode,
    ...(pin.objects ? { objects: pin.objects } : {}),
    ...(typeof pin.objectCount === "number" ? { objectCount: pin.objectCount } : {}),
    ...(segmentRevision !== null ? { segmentRevision } : {}),
  };
  return {
    snapshotId: pin.snapshotId,
    repoId: input.repoId,
    mode: pinMode,
    format: pinFormat,
    segmentRevision,
    archive: Promise.resolve(archiveValue),
    directory: input.snapshotDir,
    controller: new AbortController(),
    queueListeners: new Map(),
    users: 0,
    building: false,
    retired: false,
    acked: false,
    createdAtMs,
    expiresAtMs,
    size: pin.size,
    positionHistory: pin.position.history,
    positionSequence: pin.position.sequence,
    queueStatus: null,
    releaseRetention: () => {
      if (!retained) return;
      retained = false;
      input.unpin();
    },
  };
}

export function selectIdlePinsForEviction(
  pinnedSnapshots: ReadonlyMap<string, CachedBackupEntry>,
  snapshotMaxPins: number,
  snapshotMaxBytes: number,
): readonly CachedBackupEntry[] {
  const active = [...pinnedSnapshots.values()].filter((cached) => !cached.retired);
  let totalPins = active.length;
  let totalBytes = active.reduce((sum, cached) => sum + cached.size, 0);
  const idle = active
    .filter((cached) => !cached.building && cached.users === 0)
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  const victims: CachedBackupEntry[] = [];
  for (const candidate of idle) {
    if (totalPins <= snapshotMaxPins && totalBytes <= snapshotMaxBytes) break;
    totalPins -= 1;
    totalBytes -= candidate.size;
    victims.push(candidate);
  }
  return victims;
}

export function segmentBoundaryForRevision(revision: number, boundaryRevisions: number): number {
  if (!Number.isSafeInteger(boundaryRevisions) || boundaryRevisions <= 0) return 0;
  return Math.floor(Math.max(0, revision) / boundaryRevisions) * boundaryRevisions;
}

export function snapshotCacheKey(
  repoId: string,
  format: BaseBackupFormat,
  mode: BaseBackupMode,
  segmentRevision?: number,
): string {
  return format === "v4" && segmentRevision !== undefined
    ? `${repoId}:${format}:${mode}:seg:${segmentRevision}`
    : `${repoId}:${format}:${mode}`;
}

export interface ImmutableSegmentCandidate {
  readonly format: BaseBackupFormat;
  readonly mode: BaseBackupMode;
  readonly repoId: string;
  readonly segmentRevision: number | null;
  readonly positionHistory: string | null;
  readonly positionSequence: number | null;
  readonly expiresAtMs: number;
  readonly retired: boolean;
  readonly building: boolean;
  readonly acked: boolean;
}

/**
 * Determines whether a sealed v4 immutable snapshot segment remains eligible for reuse by
 * subsequent joining edges without rebuilding from scratch.
 */
export function reusableImmutableSegment(input: {
  readonly candidate: ImmutableSegmentCandidate;
  readonly currentHead: ReplicationPosition;
  readonly boundaryRevisions: number;
  readonly retentionWindowCommits: number;
  readonly nowMs: number;
}): boolean {
  const { candidate, currentHead, boundaryRevisions, retentionWindowCommits, nowMs } = input;
  const activeBoundary = segmentBoundaryForRevision(currentHead.revision, boundaryRevisions);
  const withinRetention =
    candidate.positionSequence === null || currentHead.sequence - candidate.positionSequence <= retentionWindowCommits;
  const sameHistory = candidate.positionHistory === null || candidate.positionHistory === currentHead.history;
  return (
    candidate.format === "v4" &&
    candidate.segmentRevision !== null &&
    !candidate.retired &&
    nowMs < candidate.expiresAtMs &&
    sameHistory &&
    candidate.segmentRevision === activeBoundary &&
    withinRetention
  );
}

/**
 * Ephemeral v3 snapshots are retired as soon as their last user finishes and ACKs.
 * Immutable v4 segments stay cached across edge joins until their revision boundary advances,
 * their WAL suffix falls outside retention, or TTL/LRU eviction reclaims them.
 */
export function retireableIdleBackup(input: {
  readonly candidate: ImmutableSegmentCandidate;
  readonly currentHead: ReplicationPosition | null;
  readonly boundaryRevisions: number;
  readonly retentionWindowCommits: number;
  readonly nowMs: number;
}): boolean {
  const { candidate, currentHead, boundaryRevisions, retentionWindowCommits, nowMs } = input;
  if (candidate.building || candidate.retired) return Boolean(false);
  if (nowMs >= candidate.expiresAtMs) return Boolean(true);
  if (candidate.format === "v4" && candidate.segmentRevision !== null) {
    return (
      currentHead !== null &&
      !reusableImmutableSegment({
        candidate,
        currentHead,
        boundaryRevisions,
        retentionWindowCommits,
        nowMs,
      })
    );
  }
  return candidate.acked;
}
