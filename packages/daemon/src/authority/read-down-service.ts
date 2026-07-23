import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ReplicaChangeLog, ReplicaChangeRecord } from "@harness-anything/application";
import type { AuthorityReadDownService } from "./forced-command-session.ts";
import type {
  AuthorityChangesAfterResult,
  AuthoritySnapshotManifest,
  AuthoritySnapshotReservation,
  Sha256Digest
} from "./protocol.ts";
import {
  digestSet,
  manifestDigest,
  type AuthorityReplicationContentStore
} from "./replication-content-store.ts";
import type { DurableAuthorityStateTable } from "./production/service-state.ts";
import { readAuthorityGitBytes } from "./production/publication-evidence.ts";

interface DurableSnapshotLease {
  readonly schema: "authority-snapshot-lease/v1";
  readonly reservation: AuthoritySnapshotReservation;
  readonly manifest: AuthoritySnapshotManifest;
  readonly cutChange: ReplicaChangeRecord | null;
}

const defaultLeaseTtlMs = 5 * 60 * 1000;
const defaultLeaseMaxLifetimeMs = 60 * 60 * 1000;

export function createAuthorityReadDownService(input: {
  readonly workspaceId: string;
  readonly epoch: string;
  readonly gitRoot: string;
  readonly state: DurableAuthorityStateTable;
  readonly replicaChangeLog: ReplicaChangeLog;
  readonly content: AuthorityReplicationContentStore;
  readonly publicationExecutor: {
    readonly run: <Result>(publication: () => Promise<Result>) => Promise<Result>;
  };
  readonly now?: () => Date;
  readonly leaseTtlMs?: number;
  readonly leaseMaxLifetimeMs?: number;
}): AuthorityReadDownService {
  const now = input.now ?? (() => new Date());
  const leaseTtlMs = input.leaseTtlMs ?? defaultLeaseTtlMs;
  const leaseMaxLifetimeMs = input.leaseMaxLifetimeMs ?? defaultLeaseMaxLifetimeMs;

  return {
    beginSnapshot: () => input.publicationExecutor.run(async () => {
      const latest = await input.replicaChangeLog.latest(input.workspaceId);
      const commitSha = gitHead(input.gitRoot);
      if (latest && latest.commitSha !== commitSha) {
        throw new Error(`RESYNC_REQUIRED:CHANGE_LOG_HEAD_MISMATCH:${latest.commitSha}:${commitSha}`);
      }
      const revision = latest?.revision ?? 0;
      const snapshot = input.content.snapshot(commitSha, revision);
      const issuedAt = now().getTime();
      const renewableUntil = issuedAt + leaseMaxLifetimeMs;
      const cut = {
        workspaceId: input.workspaceId,
        epoch: input.epoch,
        revision,
        commitSha,
        manifestDigest: snapshot.manifestDigest,
        provenanceDigest: provenanceDigest(input.workspaceId, input.epoch, revision, commitSha, snapshot.manifestDigest)
      };
      const reservation: AuthoritySnapshotReservation = {
        schema: "authority-snapshot-reservation/v1",
        cut,
        lease: {
          leaseId: randomUUID(),
          expiresAt: new Date(Math.min(issuedAt + leaseTtlMs, renewableUntil)).toISOString(),
          renewableUntil: new Date(renewableUntil).toISOString(),
          minRetainedRevision: revision + 1,
          pinnedBlobSetDigest: snapshot.pinnedBlobSetDigest
        },
        stream: {
          streamToken: randomBytes(32).toString("base64url"),
          fromRevision: revision + 1
        }
      };
      const manifest: AuthoritySnapshotManifest = {
        schema: "authority-snapshot-manifest/v1",
        cut,
        entries: snapshot.entries
      };
      writeLease(input.state, {
        schema: "authority-snapshot-lease/v1",
        reservation,
        manifest,
        cutChange: latest ?? null
      });
      return reservation;
    }),
    getCutChange: async (streamToken) => {
      const lease = readLiveLease(input.state, streamToken, now, input.workspaceId, input.epoch);
      return structuredClone(lease.cutChange);
    },
    releaseLease: async (streamToken) => {
      input.state.put(leaseStateKey(streamToken), {
        schema: "authority-snapshot-lease-released/v1"
      });
    },
    getManifest: async (streamToken, requestedDigest) => {
      const lease = readLiveLease(input.state, streamToken, now, input.workspaceId, input.epoch);
      const actualDigest = manifestDigest(lease.manifest.cut, lease.manifest.entries);
      if (requestedDigest !== lease.reservation.cut.manifestDigest || actualDigest !== requestedDigest) {
        throw new Error(`MANIFEST_DIGEST_MISMATCH:${requestedDigest}:${actualDigest}`);
      }
      return structuredClone(lease.manifest);
    },
    getBlob: async (streamToken, digest) => {
      const lease = readLiveLease(input.state, streamToken, now, input.workspaceId, input.epoch);
      const authorized = new Set(lease.manifest.entries.map((entry) => entry.blobDigest));
      for (const change of await changesAfterPinnedCut(input.replicaChangeLog, input.workspaceId, lease)) {
        for (const pathChange of change.paths) {
          if (!pathChange.tombstone && pathChange.blobDigest) authorized.add(pathChange.blobDigest);
        }
      }
      if (!authorized.has(digest)) throw new Error(`RESYNC_REQUIRED:BLOB_NOT_AUTHORIZED:${digest}`);
      return {
        schema: "authority-blob/v1",
        digest,
        encoding: "base64",
        bytes: Buffer.from(input.content.blob(digest)).toString("base64")
      };
    },
    renewLease: async (streamToken) => {
      const renewalTime = now().getTime();
      const current = readLiveLease(
        input.state,
        streamToken,
        () => new Date(renewalTime),
        input.workspaceId,
        input.epoch
      );
      const currentExpiry = Date.parse(current.reservation.lease.expiresAt);
      const renewableUntil = Date.parse(current.reservation.lease.renewableUntil);
      if (currentExpiry - renewalTime > leaseTtlMs / 2) {
        return structuredClone(current.reservation.lease);
      }
      const nextExpiry = Math.min(renewalTime + leaseTtlMs, renewableUntil);
      if (currentExpiry >= nextExpiry) return structuredClone(current.reservation.lease);
      const renewed: DurableSnapshotLease = {
        ...current,
        reservation: {
          ...current.reservation,
          lease: {
            ...current.reservation.lease,
            expiresAt: new Date(nextExpiry).toISOString()
          }
        }
      };
      writeLease(input.state, renewed);
      return structuredClone(renewed.reservation.lease);
    },
    changesAfter: async (streamToken, sinceRevision): Promise<AuthorityChangesAfterResult> => {
      const lease = readLiveLease(input.state, streamToken, now, input.workspaceId, input.epoch);
      if (sinceRevision < lease.reservation.cut.revision) {
        throw new Error(`RESYNC_REQUIRED:CURSOR_PRECEDES_PINNED_CUT:${sinceRevision}`);
      }
      const latest = await input.replicaChangeLog.latest(input.workspaceId);
      const latestRevision = latest?.revision ?? 0;
      if (latestRevision < lease.reservation.cut.revision) {
        throw new Error(`RESYNC_REQUIRED:CHANGE_LOG_BEHIND_PINNED_CUT:${latestRevision}`);
      }
      if (sinceRevision > latestRevision) {
        throw new Error(`RESYNC_REQUIRED:CURSOR_AHEAD_OF_AUTHORITY:${sinceRevision}:${latestRevision}`);
      }
      const changes = await input.replicaChangeLog.changesAfter(input.workspaceId, sinceRevision);
      let expected = sinceRevision + 1;
      for (const change of changes) {
        if (change.revision !== expected) {
          throw new Error(`RESYNC_REQUIRED:CHANGE_GAP:${expected}:${change.revision}`);
        }
        expected += 1;
      }
      return {
        schema: "authority-changes-after/v1",
        sinceRevision,
        throughRevision: changes.at(-1)?.revision ?? sinceRevision,
        changes
      };
    }
  };
}

function writeLease(state: DurableAuthorityStateTable, lease: DurableSnapshotLease): void {
  state.put(leaseStateKey(lease.reservation.stream.streamToken), lease);
}

function readLiveLease(
  state: DurableAuthorityStateTable,
  streamToken: string,
  now: () => Date,
  workspaceId: string,
  epoch: string
): DurableSnapshotLease {
  const lease = state.get<DurableSnapshotLease>(leaseStateKey(streamToken));
  if (!lease) throw new Error("RESYNC_REQUIRED:UNKNOWN_STREAM_TOKEN");
  if (lease.schema !== "authority-snapshot-lease/v1"
    || lease.reservation.schema !== "authority-snapshot-reservation/v1"
    || lease.manifest.schema !== "authority-snapshot-manifest/v1"
    || lease.reservation.stream.streamToken !== streamToken) {
    throw new Error("RESYNC_REQUIRED:SNAPSHOT_LEASE_DAMAGED");
  }
  const { cut } = lease.reservation;
  if (cut.workspaceId !== workspaceId || cut.epoch !== epoch) {
    throw new Error("RESYNC_REQUIRED:SNAPSHOT_LEASE_AUTHORITY_MISMATCH");
  }
  const expectedFromRevision = cut.revision + 1;
  if (typeof lease.reservation.lease.leaseId !== "string"
    || lease.reservation.lease.leaseId.trim().length === 0
    || lease.reservation.lease.minRetainedRevision !== expectedFromRevision
    || lease.reservation.stream.fromRevision !== expectedFromRevision) {
    throw new Error("RESYNC_REQUIRED:SNAPSHOT_LEASE_DAMAGED");
  }
  if ((cut.revision === 0 && lease.cutChange !== null)
    || (cut.revision > 0 && (
      lease.cutChange === null
      || lease.cutChange === undefined
      || lease.cutChange.workspaceId !== cut.workspaceId
      || lease.cutChange.revision !== cut.revision
      || lease.cutChange.commitSha !== cut.commitSha
    ))) {
    throw new Error("RESYNC_REQUIRED:SNAPSHOT_CUT_CHANGE_MISMATCH");
  }
  if (!sameCut(lease.manifest.cut, cut)) throw new Error("RESYNC_REQUIRED:SNAPSHOT_MANIFEST_CUT_MISMATCH");
  const actualManifestDigest = manifestDigest(cut, lease.manifest.entries);
  if (actualManifestDigest !== cut.manifestDigest
    || provenanceDigest(cut.workspaceId, cut.epoch, cut.revision, cut.commitSha, cut.manifestDigest) !== cut.provenanceDigest) {
    throw new Error("RESYNC_REQUIRED:SNAPSHOT_MANIFEST_AUTHENTICATION_FAILED");
  }
  if (digestSet(lease.manifest.entries.map((entry) => entry.blobDigest)) !== lease.reservation.lease.pinnedBlobSetDigest) {
    throw new Error("RESYNC_REQUIRED:SNAPSHOT_PINNED_BLOB_SET_MISMATCH");
  }
  const expiresAt = lease.reservation.lease.expiresAt;
  const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt) {
    throw new Error("RESYNC_REQUIRED:SNAPSHOT_LEASE_EXPIRY_DAMAGED");
  }
  const renewableUntil = lease.reservation.lease.renewableUntil;
  const renewalLimit = typeof renewableUntil === "string" ? Date.parse(renewableUntil) : Number.NaN;
  if (!Number.isFinite(renewalLimit)
    || new Date(renewalLimit).toISOString() !== renewableUntil
    || expiry > renewalLimit) {
    throw new Error("RESYNC_REQUIRED:SNAPSHOT_LEASE_RENEWAL_LIMIT_DAMAGED");
  }
  if (expiry <= now().getTime()) {
    throw new Error(`SNAPSHOT_EXPIRED:${lease.reservation.lease.leaseId}`);
  }
  return lease;
}

async function changesAfterPinnedCut(
  log: ReplicaChangeLog,
  workspaceId: string,
  lease: DurableSnapshotLease
): Promise<Awaited<ReturnType<ReplicaChangeLog["changesAfter"]>>> {
  const changes = await log.changesAfter(workspaceId, lease.reservation.cut.revision);
  let expected = lease.reservation.cut.revision + 1;
  for (const change of changes) {
    if (change.revision !== expected) throw new Error(`RESYNC_REQUIRED:CHANGE_GAP:${expected}:${change.revision}`);
    expected += 1;
  }
  return changes;
}

function sameCut(left: AuthoritySnapshotManifest["cut"], right: AuthoritySnapshotReservation["cut"]): boolean {
  return left.workspaceId === right.workspaceId
    && left.epoch === right.epoch
    && left.revision === right.revision
    && left.commitSha === right.commitSha
    && left.manifestDigest === right.manifestDigest
    && left.provenanceDigest === right.provenanceDigest;
}

function leaseStateKey(streamToken: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(streamToken)) throw new Error("RESYNC_REQUIRED:INVALID_STREAM_TOKEN");
  return `lease:${streamToken}`;
}

function gitHead(root: string): string {
  return readAuthorityGitBytes(root, "rev-parse", "--verify", "HEAD").toString("utf8").trim();
}

function provenanceDigest(
  workspaceId: string,
  epoch: string,
  revision: number,
  commitSha: string,
  manifest: Sha256Digest
): Sha256Digest {
  const bytes = JSON.stringify({ workspaceId, epoch, revision, commitSha, manifest });
  return `sha256:${createHash("sha256").update("ha/authority-snapshot-provenance/v1\0").update(bytes).digest("hex")}`;
}
