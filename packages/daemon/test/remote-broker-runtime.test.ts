// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ReplicaChangeLog, ReplicaChangeRecord } from "../../application/src/index.ts";
import {
  BrokerDurableStateStore,
  RemoteBrokerRuntime,
  RemoteReplicaResyncRequiredError,
  ReplicaBroker,
  createProductionCompoundReceiptComposition,
  type BrokerDurableState,
  type CanonicalSnapshot,
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

const workspaceId = "workspace-remote-runtime";

test("synchronize persists a remote resync cut, bootstraps it, then resumes forward changes", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const cutChange = change(3, "commit-3", "commit-2");
    const forward = change(4, "commit-4", "commit-3");
    const snapshots = new Map<string, CanonicalSnapshot>([
      ["commit-3", snapshot(cutChange, { "notes.md": "cut\n" })],
      ["commit-4", snapshot(forward, { "notes.md": "forward\n" })]
    ]);
    const requested: number[] = [];
    let observedDurableResync: BrokerDurableState | undefined;
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: logWithChanges(async (revision) => {
        requested.push(revision);
        if (revision === 0) throw remoteResync(cutChange, "epoch-remote");
        return revision === 3 ? [forward] : [];
      }),
      snapshotSource: {
        snapshotAt: async (record) => {
          if (record.revision === 3) {
            observedDurableResync = await new BrokerDurableStateStore(stateRoot).load();
          }
          return structuredClone(snapshots.get(record.commitSha)!);
        }
      }
    });

    const state = await broker.synchronize();

    assert.equal(observedDurableResync?.mode, "RESYNC_REQUIRED");
    assert.equal(observedDurableResync?.resyncTarget?.revision, 3);
    assert.equal(state.mode, "READY");
    assert.equal(state.resyncTarget, undefined);
    assert.equal(state.epoch, "epoch-remote");
    assert.equal(state.receivedCursor, 4);
    assert.equal(state.resolvedCursor, 4);
    assert.deepEqual(requested, [0, 3]);
    assert.equal(await readFile(path.join(viewRoot, "notes.md"), "utf8"), "forward\n");
  });
});

test("onNotification consumes a resync raised by snapshotAt without an unhandled rejection", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const first = change(1, "commit-1", null);
    const cutChange = change(3, "commit-3", "commit-2");
    let snapshotRequests = 0;
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: logWithChanges(async (revision) => revision === 0 ? [first] : []),
      snapshotSource: {
        snapshotAt: async (record) => {
          snapshotRequests += 1;
          if (record.revision === 1) throw remoteResync(cutChange, "epoch-replaced");
          return snapshot(cutChange, { "notes.md": "replacement\n" });
        }
      }
    });

    const state = await broker.onNotification(first);

    assert.equal(state.mode, "READY");
    assert.equal(state.resolvedCursor, 3);
    assert.equal(snapshotRequests, 2);
    assert.equal(await readFile(path.join(viewRoot, "notes.md"), "utf8"), "replacement\n");
  });
});

test("restart resumes a durable resync target without querying below the cut", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const cutChange = change(5, "commit-5", "commit-4");
    const first = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: logWithChanges(async () => {
        throw remoteResync(cutChange, "epoch-restart");
      }),
      snapshotSource: {
        snapshotAt: async () => {
          throw new Error("CRASH_DURING_RESYNC_BOOTSTRAP");
        }
      }
    });
    await assert.rejects(first.synchronize(), /CRASH_DURING_RESYNC_BOOTSTRAP/u);
    assert.equal(first.snapshotState().mode, "RESYNC_REQUIRED");

    const requested: number[] = [];
    const restarted = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: logWithChanges(async (revision) => {
        requested.push(revision);
        assert.equal(revision, 5, "restart must not request the below-cut durable cursor");
        return [];
      }),
      snapshotSource: {
        snapshotAt: async () => snapshot(cutChange, { "notes.md": "recovered\n" })
      }
    });

    const recovered = await restarted.synchronize();

    assert.equal(recovered.mode, "READY");
    assert.equal(recovered.resolvedCursor, 5);
    assert.deepEqual(requested, [5]);
    assert.equal(await readFile(path.join(viewRoot, "notes.md"), "utf8"), "recovered\n");
  });
});

test("an empty revision-zero cut is a valid bootstrap target", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const existing = change(1, "commit-1", null);
    let resyncPending = true;
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: logWithChanges(async (revision) => {
        if (revision === 0 && !resyncPending) return [];
        if (revision === 0) return [existing];
        resyncPending = false;
        throw emptyRemoteResync();
      }),
      snapshotSource: {
        snapshotAt: async () => snapshot(existing, { "notes.md": "old\n" })
      }
    });

    await broker.synchronize();
    const state = await broker.synchronize();

    assert.equal(state.mode, "READY");
    assert.equal(state.epoch, "epoch-empty-replacement");
    assert.equal(state.resolvedCursor, 0);
    await assert.rejects(readFile(path.join(viewRoot, "notes.md")), /ENOENT/u);
  });
});

test("remote runtime and optional production composition start and stop their persistent session cleanly", async () => {
  await withRoots(async ({ root, viewRoot, stateRoot }) => {
    const directClient = new EmptyReadDownClient();
    const runtime = new RemoteBrokerRuntime({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      session: {
        client: directClient as unknown as PersistentSshAuthorityClient,
        backoff: { initialMs: 0, maximumMs: 0, multiplier: 1 }
      }
    });
    const started = await runtime.start();
    assert.equal(started.mode, "READY");
    assert.equal(directClient.connectRequests, 1);
    assert.equal(directClient.notificationListeners.size, 1);
    await runtime.stop();
    await runtime.stop();
    assert.equal(directClient.closeRequests, 1);
    assert.equal(directClient.notificationListeners.size, 0);
    assert.equal(directClient.disconnectListeners.size, 0);

    const composedClient = new EmptyReadDownClient();
    const composition = createProductionCompoundReceiptComposition({
      workspaceId,
      viewId: "view-composed",
      canonicalRoot: path.join(root, "composed-view"),
      stateDirectory: path.join(root, "composed-state"),
      remoteReadDown: {
        client: composedClient as unknown as PersistentSshAuthorityClient,
        backoff: { initialMs: 0, maximumMs: 0, multiplier: 1 }
      }
    });
    await composition.start();
    await composition.stop();
    assert.equal(composedClient.closeRequests, 1);
  });
});

test("non-resync failures still fail closed and do not manufacture a resync transition", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: logWithChanges(async () => {
        throw new Error("REMOTE_READ_FAILED");
      }),
      snapshotSource: { snapshotAt: async (record) => snapshot(record, {}) }
    });
    await assert.rejects(broker.synchronize(), /REMOTE_READ_FAILED/u);
    assert.equal(broker.snapshotState().mode, "READY");
  });
});

class EmptyReadDownClient {
  readonly notificationListeners = new Set<(change: ReplicaChangeRecord) => void>();
  readonly disconnectListeners = new Set<() => void>();
  readonly fixture = emptySnapshotFixture();
  connectRequests = 0;
  closeRequests = 0;

  async connect(): Promise<void> {
    this.connectRequests += 1;
  }

  async reconnect(): Promise<void> {
    this.connectRequests += 1;
  }

  async beginSnapshotAndSubscribe(): Promise<AuthoritySnapshotReservation> {
    return structuredClone(this.fixture.reservation);
  }

  async getSnapshotManifest(): Promise<AuthoritySnapshotManifest> {
    return structuredClone(this.fixture.manifest);
  }

  async getCutChange(): Promise<null> {
    return null;
  }

  async getBlob(): Promise<never> {
    throw new Error("empty snapshot has no blobs");
  }

  async changesAfter(_streamToken: string, sinceRevision: number): Promise<AuthorityChangesAfterResult> {
    return {
      schema: "authority-changes-after/v1",
      sinceRevision,
      throughRevision: sinceRevision,
      changes: []
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
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closeRequests += 1;
  }
}

function logWithChanges(
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

function change(revision: number, commitSha: string, previousCommit: string | null): ReplicaChangeRecord {
  return {
    schema: "replica-change/v2",
    workspaceId,
    revision,
    opId: `op-${revision}`,
    semanticDigest: `semantic-${revision}`,
    operations: [{ opId: `op-${revision}`, semanticDigest: `semantic-${revision}` }],
    commitSha,
    previousCommit,
    changedAt: "2026-07-23T08:00:00.000Z",
    manifest: { digest: sha256(`manifest-${revision}`), entryCount: 1 },
    paths: []
  };
}

function snapshot(
  record: ReplicaChangeRecord,
  files: Readonly<Record<string, string>>
): CanonicalSnapshot {
  return {
    workspaceId,
    revision: record.revision,
    commitSha: record.commitSha,
    entries: Object.entries(files).map(([pathName, content]) => ({
      path: pathName,
      content: Buffer.from(content),
      logicalMode: 0o644
    }))
  };
}

function remoteResync(
  cutChange: ReplicaChangeRecord,
  epoch: string
): RemoteReplicaResyncRequiredError {
  return new RemoteReplicaResyncRequiredError("test cut", {
    workspaceId,
    epoch,
    revision: cutChange.revision,
    commitSha: cutChange.commitSha,
    manifestDigest: cutChange.manifest.digest,
    provenanceDigest: sha256(`provenance-${cutChange.revision}`)
  }, cutChange);
}

function emptyRemoteResync(): RemoteReplicaResyncRequiredError {
  return new RemoteReplicaResyncRequiredError("empty test cut", {
    workspaceId,
    epoch: "epoch-empty-replacement",
    revision: 0,
    commitSha: "0".repeat(40),
    manifestDigest: sha256("empty-manifest"),
    provenanceDigest: sha256("empty-provenance")
  }, null);
}

function emptySnapshotFixture(): {
  readonly reservation: AuthoritySnapshotReservation;
  readonly manifest: AuthoritySnapshotManifest;
} {
  const now = Date.now();
  const cutBase = {
    workspaceId,
    epoch: "epoch-empty",
    revision: 0,
    commitSha: "0".repeat(40)
  };
  const cut = {
    ...cutBase,
    manifestDigest: manifestDigest(cutBase, []),
    provenanceDigest: sha256("empty-provenance")
  };
  const reservation: AuthoritySnapshotReservation = {
    schema: "authority-snapshot-reservation/v1",
    cut,
    lease: {
      leaseId: "lease-empty",
      expiresAt: new Date(now + 60_000).toISOString(),
      renewableUntil: new Date(now + 3_600_000).toISOString(),
      minRetainedRevision: 0,
      pinnedBlobSetDigest: sha256("empty-set")
    },
    stream: { streamToken: "stream-empty", fromRevision: 1 }
  };
  return {
    reservation,
    manifest: { schema: "authority-snapshot-manifest/v1", cut, entries: [] }
  };
}

function sha256(text: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function withRoots(
  body: (roots: {
    readonly root: string;
    readonly viewRoot: string;
    readonly stateRoot: string;
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ha-remote-broker-runtime-"));
  try {
    await body({
      root,
      viewRoot: path.join(root, "view"),
      stateRoot: path.join(root, "state")
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
