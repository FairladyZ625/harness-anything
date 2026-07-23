// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "../../application/src/index.ts";
import {
  BrokerDurableStateStore,
  BrokerReplicaIntegrityError,
  RemoteBrokerRuntime,
  RemoteReplicaResyncRequiredError,
  ReplicaBroker,
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
import { deferred } from "./remote-read-down-test-support.ts";

const workspaceId = "workspace-remote-runtime-failures";

test("cold restart seeds the durable epoch and bootstraps when the first remote cut changed epoch", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const fixture = snapshotFixture(1, "epoch-2");
    const store = new BrokerDurableStateStore(stateRoot);
    const initial = await store.initialize(workspaceId);
    await store.save({
      ...initial,
      epoch: "epoch-1",
      receivedCursor: 1,
      resolvedCursor: 1,
      receivedCommit: fixture.reservation.cut.commitSha,
      resolvedCommit: fixture.reservation.cut.commitSha
    });
    const client = new ReadDownClient(fixture);
    const runtime = makeRuntime(client, viewRoot, stateRoot);

    const state = await runtime.start();

    assert.equal(state.mode, "READY");
    assert.equal(state.epoch, "epoch-2");
    assert.equal(state.resolvedCursor, 1);
    assert.ok(client.changeRequests.length > 0);
    assert.ok(client.changeRequests.every((revision) => revision === 1));
    await runtime.stop();
  });
});

test("remote parent mismatch is terminal and never creates targetless RESYNC", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const wrongParent = record(1, "commit-1", "wrong-parent");
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaGapPolicy: "TERMINAL",
      replicaChangeLog: changeLog(async () => [wrongParent]),
      snapshotSource: {
        snapshotAt: async () => ({
          workspaceId,
          revision: 1,
          commitSha: "commit-1",
          entries: []
        })
      }
    });

    await assert.rejects(broker.synchronize(), BrokerReplicaIntegrityError);
    assert.equal(broker.snapshotState().mode, "READY");
    assert.equal(broker.snapshotState().resyncTarget, undefined);
  });
});

test("all broker synchronization entrypoints share one in-flight synchronization", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const release = deferred<void>();
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: changeLog(async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await release.promise;
        active -= 1;
        return [];
      }),
      snapshotSource: {
        snapshotAt: async () => {
          throw new Error("unexpected snapshot");
        }
      }
    });
    const hint = record(1, "commit-1", null);

    const first = broker.synchronize();
    const second = broker.synchronize();
    const notified = broker.onNotification(hint);
    await waitFor(() => calls === 1);
    assert.equal(maximumActive, 1);
    release.resolve();
    await Promise.all([first, second, notified]);
    assert.equal(calls, 1);
    assert.equal(maximumActive, 1);
  });
});

test("repeated resync cut exits without rewriting the durable target indefinitely", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const cutChange = record(1, "commit-1", null);
    const resync = remoteResync(cutChange, "epoch-resync");
    let snapshotCalls = 0;
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: changeLog(async () => {
        throw resync;
      }),
      snapshotSource: {
        snapshotAt: async () => {
          snapshotCalls += 1;
          throw remoteResync(cutChange, "epoch-resync");
        }
      }
    });

    await assert.rejects(broker.synchronize(), RemoteReplicaResyncRequiredError);

    const state = broker.snapshotState();
    assert.equal(state.mode, "RESYNC_REQUIRED");
    assert.equal(state.resyncTarget?.revision, 1);
    assert.equal(state.nextJournalLSN, 2);
    assert.equal(snapshotCalls, 1);
  });
});

test("background deterministic failure becomes terminal, unsubscribes, and is observable through stop", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    const runtime = makeRuntime(client, viewRoot, stateRoot);
    await runtime.start();
    const failure = new BrokerReplicaIntegrityError("deterministic snapshot failure");
    runtime.broker.onNotification = async () => {
      throw failure;
    };

    notifyRuntime(runtime, record(1, "commit-1", null));
    await waitFor(() => runtime.health().status === "TERMINAL");

    const health = runtime.health();
    assert.equal(health.status, "TERMINAL");
    if (health.status === "TERMINAL") assert.equal(health.failure, failure);
    assert.equal(client.notificationListeners.size, 0);
    assert.equal(client.disconnectListeners.size, 0);
    await assert.rejects(runtime.stop(), failure);
  });
});

test("notification hints coalesce to one running synchronization and one latest rerun", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    const runtime = makeRuntime(client, viewRoot, stateRoot);
    await runtime.start();
    const release = deferred<void>();
    const revisions: number[] = [];
    runtime.broker.onNotification = async (change) => {
      revisions.push(change.revision);
      if (revisions.length === 1) await release.promise;
      return runtime.broker.snapshotState();
    };

    notifyRuntime(runtime, record(1, "commit-1", null));
    await waitFor(() => revisions.length === 1);
    for (let revision = 2; revision <= 100; revision += 1) {
      notifyRuntime(runtime, record(revision, `commit-${revision}`, `commit-${revision - 1}`));
    }
    assert.deepEqual(revisions, [1]);
    release.resolve();
    await waitFor(() => revisions.length === 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(revisions, [1, 100]);
    await runtime.stop();
  });
});

test("retryable initial synchronization failure rolls back and a later start creates a fresh session", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    const runtime = makeRuntime(client, viewRoot, stateRoot);
    const synchronize = runtime.broker.synchronize.bind(runtime.broker);
    let attempts = 0;
    runtime.broker.synchronize = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(emptyRemoteResync())
        : synchronize();
    };

    await assert.rejects(runtime.start(), RemoteReplicaResyncRequiredError);
    assert.deepEqual(runtime.health(), { status: "IDLE" });
    assert.equal(client.notificationListeners.size, 0);
    assert.equal(client.disconnectListeners.size, 0);
    assert.equal(client.closeRequests, 1);

    const state = await runtime.start();
    assert.equal(state.mode, "READY");
    assert.deepEqual(runtime.health(), { status: "RUNNING" });
    await runtime.stop();
    assert.equal(client.closeRequests, 2);
  });
});

class ReadDownClient {
  readonly notificationListeners = new Set<(change: ReplicaChangeRecord) => void>();
  readonly disconnectListeners = new Set<() => void>();
  readonly changeRequests: number[] = [];
  private readonly fixture: SnapshotFixture;
  closeRequests = 0;

  constructor(fixture: SnapshotFixture) {
    this.fixture = fixture;
  }

  async connect(): Promise<void> {}

  async reconnect(): Promise<void> {}

  async beginSnapshotAndSubscribe(): Promise<AuthoritySnapshotReservation> {
    return structuredClone(this.fixture.reservation);
  }

  async getSnapshotManifest(): Promise<AuthoritySnapshotManifest> {
    return structuredClone(this.fixture.manifest);
  }

  async getCutChange(): Promise<ReplicaChangeRecord | null> {
    return structuredClone(this.fixture.cutChange);
  }

  async getBlob(): Promise<never> {
    throw new Error("test snapshot has no blobs");
  }

  async changesAfter(_streamToken: string, sinceRevision: number): Promise<AuthorityChangesAfterResult> {
    this.changeRequests.push(sinceRevision);
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

interface SnapshotFixture {
  readonly reservation: AuthoritySnapshotReservation;
  readonly manifest: AuthoritySnapshotManifest;
  readonly cutChange: ReplicaChangeRecord | null;
}

function snapshotFixture(revision: number, epoch: string): SnapshotFixture {
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

function makeRuntime(
  client: ReadDownClient,
  viewRoot: string,
  stateRoot: string
): RemoteBrokerRuntime {
  return new RemoteBrokerRuntime({
    workspaceId,
    viewId: "view-remote",
    viewRoot,
    stateRoot,
    session: {
      client: client as unknown as PersistentSshAuthorityClient,
      backoff: { initialMs: 0, maximumMs: 0, multiplier: 1 }
    }
  });
}

function notifyRuntime(runtime: RemoteBrokerRuntime, change: ReplicaChangeRecord): void {
  const target = runtime as unknown as {
    readonly handleNotification: (value: ReplicaChangeRecord) => void;
  };
  target.handleNotification(change);
}

function changeLog(
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

function record(
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

function remoteResync(
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

function emptyRemoteResync(): RemoteReplicaResyncRequiredError {
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

async function withRoots(
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for remote broker condition");
}
