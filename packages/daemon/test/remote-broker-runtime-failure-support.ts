import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "../../application/src/index.ts";
import {
  AuthorityTransportDisconnectedError,
  RemoteBrokerRuntime,
  RemoteReplicaResyncRequiredError,
  type PersistentSshAuthorityClient
} from "../src/index.ts";
import { manifestDigest } from "../src/authority/replication-content-store.ts";
import type {
  AuthorityChangesAfterResult,
  AuthoritySnapshotLease,
  AuthoritySnapshotManifest,
  AuthoritySnapshotReservation,
  Sha256Digest
} from "../src/authority/protocol.ts";
import type { Deferred } from "./remote-read-down-test-support.ts";

export const workspaceId = "workspace-remote-runtime-failures";

export class ReadDownClient {
  readonly notificationListeners = new Set<(change: ReplicaChangeRecord) => void>();
  readonly disconnectListeners = new Set<() => void>();
  readonly changeRequests: number[] = [];
  private readonly fixture: SnapshotFixture;
  authoritativeChanges: ReplicaChangeRecord[] = [];
  invalidEmptyCutChange = false;
  reconnectRequests = 0;
  fetchFailuresRemaining = 0;
  closeFailuresRemaining = 0;
  disconnectRegistrationFailure: Error | undefined;
  fetchGate: Deferred<void> | undefined;
  closeRequests = 0;

  constructor(fixture: SnapshotFixture) {
    this.fixture = fixture;
  }

  async connect(): Promise<void> {}

  async reconnect(): Promise<void> {
    this.reconnectRequests += 1;
  }

  async beginSnapshotAndSubscribe(): Promise<AuthoritySnapshotReservation> {
    return structuredClone(this.fixture.reservation);
  }

  async getSnapshotManifest(): Promise<AuthoritySnapshotManifest> {
    return structuredClone(this.fixture.manifest);
  }

  async getCutChange(): Promise<ReplicaChangeRecord | null> {
    if (this.invalidEmptyCutChange) return record(1, "commit-1", null);
    return structuredClone(this.fixture.cutChange);
  }

  async getBlob(): Promise<never> {
    throw new Error("test snapshot has no blobs");
  }

  async changesAfter(_streamToken: string, sinceRevision: number): Promise<AuthorityChangesAfterResult> {
    this.changeRequests.push(sinceRevision);
    if (this.fetchGate) await this.fetchGate.promise;
    if (this.fetchFailuresRemaining > 0) {
      this.fetchFailuresRemaining -= 1;
      throw new AuthorityTransportDisconnectedError("scripted fetch disconnect");
    }
    const changes = this.authoritativeChanges.filter(
      (change) => change.revision > sinceRevision
    );
    return {
      schema: "authority-changes-after/v1",
      sinceRevision,
      throughRevision: changes.at(-1)?.revision ?? sinceRevision,
      changes
    };
  }

  async renewLease(): Promise<AuthoritySnapshotLease> {
    return structuredClone(this.fixture.reservation.lease);
  }

  onNotification(listener: (change: ReplicaChangeRecord) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    if (this.disconnectRegistrationFailure) throw this.disconnectRegistrationFailure;
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closeRequests += 1;
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining -= 1;
      throw new Error("scripted close failure");
    }
  }

  emit(change: ReplicaChangeRecord): void {
    for (const listener of this.notificationListeners) listener(change);
  }
}

interface SnapshotFixture {
  readonly reservation: AuthoritySnapshotReservation;
  readonly manifest: AuthoritySnapshotManifest;
  readonly cutChange: ReplicaChangeRecord | null;
}

export function snapshotFixture(revision: number, epoch: string): SnapshotFixture {
  const commitSha = revision === 0 ? "0".repeat(40) : `commit-${revision}`;
  const cutBase = { workspaceId, epoch, revision, commitSha };
  const cut = {
    ...cutBase,
    manifestDigest: manifestDigest(cutBase, []),
    provenanceDigest: sha256(`provenance-${epoch}-${revision}`)
  };
  const now = Date.now();
  return {
    reservation: {
      schema: "authority-snapshot-reservation/v1",
      cut,
      lease: {
        leaseId: `lease-${epoch}-${revision}`,
        expiresAt: new Date(now + 60_000).toISOString(),
        renewableUntil: new Date(now + 3_600_000).toISOString(),
        minRetainedRevision: revision + 1,
        pinnedBlobSetDigest: sha256(`set-${epoch}-${revision}`)
      },
      stream: { streamToken: `stream-${epoch}-${revision}`, fromRevision: revision + 1 }
    },
    manifest: { schema: "authority-snapshot-manifest/v1", cut, entries: [] },
    cutChange: revision === 0
      ? null
      : {
          ...record(revision, commitSha, revision === 1 ? null : `commit-${revision - 1}`),
          manifest: { digest: cut.manifestDigest, entryCount: 0 }
        }
  };
}

export function makeRuntime(
  client: ReadDownClient,
  viewRoot: string,
  stateRoot: string,
  session: {
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly backoff?: {
      readonly initialMs: number;
      readonly maximumMs: number;
      readonly multiplier: number;
    };
  } = {}
): RemoteBrokerRuntime {
  return new RemoteBrokerRuntime({
    workspaceId,
    viewId: "view-remote",
    viewRoot,
    stateRoot,
    session: {
      client: client as unknown as PersistentSshAuthorityClient,
      backoff: session.backoff ?? { initialMs: 0, maximumMs: 0, multiplier: 1 },
      ...(session.sleep ? { sleep: session.sleep } : {})
    }
  });
}

export function notifyRuntime(runtime: RemoteBrokerRuntime, change: ReplicaChangeRecord): void {
  const target = runtime as unknown as {
    readonly handleNotification: (value: ReplicaChangeRecord) => void;
  };
  target.handleNotification(change);
}

export function changeLog(
  changesAfter: (revision: number) => Promise<ReadonlyArray<ReplicaChangeRecord>>
): ReplicaChangeLog {
  return {
    append: async () => {},
    latest: async () => undefined,
    getByOperation: async () => undefined,
    changesAfter: async (_workspace, revision) => changesAfter(revision),
    subscribe: () => () => {}
  };
}

export function record(
  revision: number,
  commitSha: string,
  previousCommit: string | null
): ReplicaChangeRecord {
  return {
    schema: "replica-change/v2",
    workspaceId,
    revision,
    opId: `op-${revision}`,
    semanticDigest: `semantic-${revision}`,
    operations: [{ opId: `op-${revision}`, semanticDigest: `semantic-${revision}` }],
    commitSha,
    previousCommit,
    changedAt: "2026-07-23T14:00:00.000Z",
    manifest: { digest: sha256(`manifest-${revision}`), entryCount: 0 },
    paths: []
  };
}

export function remoteResync(
  cutChange: ReplicaChangeRecord,
  epoch: string
): RemoteReplicaResyncRequiredError {
  return new RemoteReplicaResyncRequiredError("test resync", {
    workspaceId,
    epoch,
    revision: cutChange.revision,
    commitSha: cutChange.commitSha,
    manifestDigest: cutChange.manifest.digest,
    provenanceDigest: sha256(`provenance-${epoch}-${cutChange.revision}`)
  }, cutChange);
}

export function emptyRemoteResync(): RemoteReplicaResyncRequiredError {
  const fixture = snapshotFixture(0, "epoch-1");
  return new RemoteReplicaResyncRequiredError(
    "retryable start",
    fixture.reservation.cut,
    null
  );
}

function sha256(text: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export async function withRoots(
  body: (roots: { readonly viewRoot: string; readonly stateRoot: string }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ha-remote-runtime-failure-"));
  try {
    await body({
      viewRoot: path.join(root, "view"),
      stateRoot: path.join(root, "state")
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for remote broker condition");
}
