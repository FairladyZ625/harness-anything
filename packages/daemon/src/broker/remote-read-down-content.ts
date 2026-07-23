import type { ReplicaChangeRecord } from "@harness-anything/application";
import { manifestDigest } from "../authority/replication-content-store.ts";
import type {
  AuthoritySnapshotManifest,
  AuthoritySnapshotManifestEntry,
  AuthoritySnapshotReservation
} from "../authority/protocol.ts";
import {
  AuthorityReadDownRequestError
} from "../transport/persistent-ssh-authority-client.ts";
import type {
  ActiveSnapshot,
  RemoteReadDownChangeCacheLimits,
  ResumeCursor
} from "./remote-read-down-contract.ts";
import { RemoteReadDownIntegrityError } from "./remote-read-down-failure.ts";

export function assertManifest(
  reservation: AuthoritySnapshotReservation,
  manifest: AuthoritySnapshotManifest,
  workspaceId: string
): void {
  if (manifest.cut.workspaceId !== workspaceId
    || !sameSnapshotCut(manifest.cut, reservation.cut)) {
    throw new RemoteReadDownIntegrityError("authority snapshot manifest cut mismatch");
  }
  const actual = manifestDigest(manifest.cut, manifest.entries);
  if (actual !== reservation.cut.manifestDigest) {
    throw new RemoteReadDownIntegrityError(`MANIFEST_DIGEST_MISMATCH:${reservation.cut.manifestDigest}:${actual}`);
  }
}

export function assertCutChange(
  reservation: AuthoritySnapshotReservation,
  change: ReplicaChangeRecord | null
): void {
  if (reservation.cut.revision === 0) {
    if (change !== null) {
      throw new RemoteReadDownIntegrityError("authority empty cut unexpectedly has a change");
    }
    return;
  }
  if (!change
    || change.workspaceId !== reservation.cut.workspaceId
    || change.revision !== reservation.cut.revision
    || change.commitSha !== reservation.cut.commitSha
    || change.manifest.digest !== reservation.cut.manifestDigest) {
    throw new RemoteReadDownIntegrityError("authority cut change does not match snapshot reservation");
  }
}

export async function mapInBatches<Value>(
  values: ReadonlyArray<Value>,
  batchSize: number,
  operation: (value: Value) => Promise<unknown>
): Promise<void> {
  for (let offset = 0; offset < values.length; offset += batchSize) {
    await Promise.all(values.slice(offset, offset + batchSize).map(operation));
  }
}

export function createActiveSnapshot(
  reservation: AuthoritySnapshotReservation,
  manifest: AuthoritySnapshotManifest,
  cutChange: ReplicaChangeRecord | null,
  resume: ResumeCursor | undefined
): ActiveSnapshot {
  const baseEntries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  if (baseEntries.size !== manifest.entries.length) {
    throw new RemoteReadDownIntegrityError(
      "authority snapshot manifest contains duplicate paths"
    );
  }
  const sameEpoch = resume?.epoch === reservation.cut.epoch;
  const canResume = Boolean(
    resume && sameEpoch && reservation.cut.revision <= resume.deliveredRevision
  );
  const resyncReason = resume && !sameEpoch
    ? `EPOCH_CHANGED:${resume.epoch}:${reservation.cut.epoch}`
    : resume && !canResume
      ? `CURSOR_PRECEDES_RECONNECTED_CUT:${resume.deliveredRevision}:${reservation.cut.revision}`
      : undefined;
  return {
    reservation,
    cutChange,
    baseEntries,
    changes: new Map(),
    changeSizes: new Map(),
    lossyHintRevisions: new Set(),
    changeBytes: 0,
    highestRevision: reservation.cut.revision,
    durableCursor: reservation.cut.revision,
    adopted: canResume || (!resume && reservation.cut.revision === 0),
    deliveredRevision: canResume ? resume!.deliveredRevision : reservation.cut.revision,
    ...(resyncReason ? { resyncReason } : {}),
    resyncSignaled: false,
    resyncReported: false
  };
}

export function validateChanges(
  changes: ReadonlyArray<ReplicaChangeRecord>,
  sinceRevision: number,
  workspaceId: string
): void {
  let expected = sinceRevision + 1;
  for (const change of changes) {
    if (change.workspaceId !== workspaceId || change.revision !== expected) {
      throw new RemoteReadDownIntegrityError(
        `remote replica change gap at revision ${change.revision}; expected ${expected}`
      );
    }
    expected += 1;
  }
}

export function applyChange(
  entries: Map<string, AuthoritySnapshotManifestEntry>,
  change: ReplicaChangeRecord
): void {
  for (const item of change.paths) {
    if (item.tombstone) {
      entries.delete(item.path);
    } else {
      if (!item.blobDigest || !item.mode) {
        throw new RemoteReadDownIntegrityError(`remote change lacks blob metadata for ${item.path}`);
      }
      entries.set(item.path, {
        path: item.path,
        blobDigest: item.blobDigest,
        mode: item.mode,
        tombstone: false
      });
    }
  }
}

export function assertChangeManifest(
  epoch: string,
  change: ReplicaChangeRecord,
  entries: ReadonlyMap<string, AuthoritySnapshotManifestEntry>
): void {
  const actual = manifestDigest({
    workspaceId: change.workspaceId,
    epoch,
    revision: change.revision,
    commitSha: change.commitSha
  }, [...entries.values()]);
  if (actual !== change.manifest.digest || entries.size !== change.manifest.entryCount) {
    throw new RemoteReadDownIntegrityError(`MANIFEST_DIGEST_MISMATCH:${change.manifest.digest}:${actual}`);
  }
}

export function pruneChanges(active: ActiveSnapshot, throughRevision: number): void {
  for (const revision of active.changes.keys()) {
    if (revision <= throughRevision) deleteCachedChange(active, revision);
  }
  recomputeHighestRevision(active);
}

export function sameChangeIdentity(left: ReplicaChangeRecord, right: ReplicaChangeRecord): boolean {
  return left.workspaceId === right.workspaceId
    && left.revision === right.revision
    && left.commitSha === right.commitSha
    && left.previousCommit === right.previousCommit
    && left.manifest.digest === right.manifest.digest
    && left.manifest.entryCount === right.manifest.entryCount;
}

export function storeCachedChange(
  active: ActiveSnapshot,
  change: ReplicaChangeRecord,
  limits: RemoteReadDownChangeCacheLimits,
  lossyHint: boolean
): boolean {
  const existing = active.changes.get(change.revision);
  if (existing) {
    if (!sameChangeIdentity(existing, change)) {
      throw new RemoteReadDownIntegrityError(
        `remote replica change identity conflict at revision ${change.revision}`
      );
    }
    if (!lossyHint) {
      active.lossyHintRevisions.delete(change.revision);
    }
    active.highestRevision = Math.max(active.highestRevision, change.revision);
    return false;
  }
  const byteSize = Buffer.byteLength(JSON.stringify(change));
  if (byteSize > limits.maxBytes) {
    throw new RemoteReadDownIntegrityError(
      `REMOTE_CHANGE_CACHE_LIMIT_EXCEEDED:bytes:${byteSize}:${limits.maxBytes}`
    );
  }
  if (lossyHint
    && (active.changes.size >= limits.maxCount
      || active.changeBytes + byteSize > limits.maxBytes)) {
    return false;
  }
  if (!lossyHint) evictLossyHints(active, limits, byteSize);
  if (active.changes.size >= limits.maxCount || active.changeBytes + byteSize > limits.maxBytes) {
    throw new RemoteReadDownIntegrityError(
      `REMOTE_CHANGE_CACHE_LIMIT_EXCEEDED:${active.changes.size + 1}:${active.changeBytes + byteSize}`
    );
  }
  active.changes.set(change.revision, change);
  active.changeSizes.set(change.revision, byteSize);
  if (lossyHint) active.lossyHintRevisions.add(change.revision);
  active.changeBytes += byteSize;
  active.highestRevision = Math.max(active.highestRevision, change.revision);
  return true;
}

export function compareManifestPaths(
  left: AuthoritySnapshotManifestEntry,
  right: AuthoritySnapshotManifestEntry
): number {
  return left.path.localeCompare(right.path, "en");
}

export function isResyncError(error: unknown): error is AuthorityReadDownRequestError {
  return error instanceof AuthorityReadDownRequestError
    && (error.code === "RESYNC_REQUIRED" || error.code === "SNAPSHOT_EXPIRED");
}

function sameSnapshotCut(
  left: AuthoritySnapshotReservation["cut"],
  right: AuthoritySnapshotReservation["cut"]
): boolean {
  return left.workspaceId === right.workspaceId
    && left.epoch === right.epoch
    && left.revision === right.revision
    && left.commitSha === right.commitSha
    && left.manifestDigest === right.manifestDigest
    && left.provenanceDigest === right.provenanceDigest;
}

function deleteCachedChange(active: ActiveSnapshot, revision: number): void {
  const byteSize = active.changeSizes.get(revision) ?? 0;
  active.changes.delete(revision);
  active.changeSizes.delete(revision);
  active.lossyHintRevisions.delete(revision);
  active.changeBytes -= byteSize;
}

function evictLossyHints(
  active: ActiveSnapshot,
  limits: RemoteReadDownChangeCacheLimits,
  incomingBytes: number
): void {
  const revisions = [...active.lossyHintRevisions].sort((left, right) => right - left);
  for (const revision of revisions) {
    if (active.changes.size < limits.maxCount
      && active.changeBytes + incomingBytes <= limits.maxBytes) {
      return;
    }
    deleteCachedChange(active, revision);
  }
}

function recomputeHighestRevision(active: ActiveSnapshot): void {
  let highest = active.reservation.cut.revision;
  for (const revision of active.changes.keys()) {
    if (revision > highest) highest = revision;
  }
  active.highestRevision = highest;
}
