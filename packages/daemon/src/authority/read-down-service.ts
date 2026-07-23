import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ReplicaChangeLog } from "@harness-anything/application";
import type { AuthorityReadDownService } from "./forced-command-session.ts";
import type {
  AuthorityChangesAfterResult,
  AuthoritySnapshotManifest,
  AuthoritySnapshotReservation,
  Sha256Digest
} from "./protocol.ts";
import {
  manifestDigest,
  type AuthorityReplicationContentStore
} from "./replication-content-store.ts";
import type { DurableAuthorityStateTable } from "./production/service-state.ts";
import { readAuthorityGitBytes } from "./production/publication-evidence.ts";

interface DurableSnapshotLease {
  readonly schema: "authority-snapshot-lease/v1";
  readonly reservation: AuthoritySnapshotReservation;
  readonly manifest: AuthoritySnapshotManifest;
}

const defaultLeaseTtlMs = 5 * 60 * 1000;

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
}): AuthorityReadDownService {
  const now = input.now ?? (() => new Date());
  const leaseTtlMs = input.leaseTtlMs ?? defaultLeaseTtlMs;

  return {
    beginSnapshot: () => input.publicationExecutor.run(async () => {
      const latest = await input.replicaChangeLog.latest(input.workspaceId);
      const commitSha = gitHead(input.gitRoot);
      if (latest && latest.commitSha !== commitSha) {
        throw new Error(`RESYNC_REQUIRED:CHANGE_LOG_HEAD_MISMATCH:${latest.commitSha}:${commitSha}`);
      }
      const snapshot = input.content.snapshot(commitSha);
      const revision = latest?.revision ?? 0;
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
          expiresAt: new Date(now().getTime() + leaseTtlMs).toISOString(),
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
      writeLease(input.state, { schema: "authority-snapshot-lease/v1", reservation, manifest });
      return reservation;
    }),
    getManifest: async (streamToken, requestedDigest) => {
      const lease = readLiveLease(input.state, streamToken, now);
      const actualDigest = manifestDigest(lease.manifest.entries);
      if (requestedDigest !== lease.reservation.cut.manifestDigest || actualDigest !== requestedDigest) {
        throw new Error(`MANIFEST_DIGEST_MISMATCH:${requestedDigest}:${actualDigest}`);
      }
      return structuredClone(lease.manifest);
    },
    getBlob: async (streamToken, digest) => {
      readLiveLease(input.state, streamToken, now);
      return {
        schema: "authority-blob/v1",
        digest,
        bytes: Buffer.from(input.content.blob(digest)).toString("base64")
      };
    },
    changesAfter: async (streamToken, sinceRevision): Promise<AuthorityChangesAfterResult> => {
      const lease = readLiveLease(input.state, streamToken, now);
      if (sinceRevision < lease.reservation.cut.revision) {
        throw new Error(`RESYNC_REQUIRED:CURSOR_PRECEDES_PINNED_CUT:${sinceRevision}`);
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
  now: () => Date
): DurableSnapshotLease {
  const lease = state.get<DurableSnapshotLease>(leaseStateKey(streamToken));
  if (!lease) throw new Error("RESYNC_REQUIRED:UNKNOWN_STREAM_TOKEN");
  if (lease.schema !== "authority-snapshot-lease/v1"
    || lease.reservation.schema !== "authority-snapshot-reservation/v1"
    || lease.manifest.schema !== "authority-snapshot-manifest/v1"
    || lease.reservation.stream.streamToken !== streamToken) {
    throw new Error("RESYNC_REQUIRED:SNAPSHOT_LEASE_DAMAGED");
  }
  if (Date.parse(lease.reservation.lease.expiresAt) <= now().getTime()) {
    throw new Error(`SNAPSHOT_EXPIRED:${lease.reservation.lease.leaseId}`);
  }
  return lease;
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
