// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ReplicaChangeRecord } from "../../application/src/index.ts";
import {
  AuthorityReadDownRequestError,
  RemoteCanonicalSnapshotSource,
  RemoteReadDownSession,
  RemoteReplicaChangeLog,
  RemoteReplicaResyncRequiredError,
  type PersistentSshAuthorityClient
} from "../src/index.ts";
import {
  manifestDigest
} from "../src/authority/replication-content-store.ts";
import type {
  AuthorityChangesAfterResult,
  AuthoritySnapshotLease,
  AuthoritySnapshotManifest,
  AuthoritySnapshotReservation,
  Sha256Digest
} from "../src/authority/protocol.ts";

const workspaceId = "workspace-remote-adapter";

test("remote adapters are read-down only and materialize verified manifest blobs through durable CAS", async () => {
  await withStateRoot(async (stateRoot) => {
    const first = Buffer.from("first\n");
    const snapshot = makeSnapshot(1, { "notes.md": first });
    const client = new FakeReadDownClient([snapshot]);
    const session = makeSession(client, stateRoot);
    const log = new RemoteReplicaChangeLog(session);
    const source = new RemoteCanonicalSnapshotSource(session);

    await assert.rejects(
      log.append(snapshot.cutChange!),
      /REMOTE_REPLICA_CHANGE_LOG_READ_DOWN_ONLY/u
    );
    assert.deepEqual(await log.latest(workspaceId), snapshot.cutChange);
    const materialized = await source.snapshotAt(snapshot.cutChange!);
    assert.equal(Buffer.from(materialized.entries[0]!.content).toString("utf8"), "first\n");
    assert.equal(client.blobRequests.length, 1);

    await source.snapshotAt(snapshot.cutChange!);
    assert.equal(client.blobRequests.length, 1, "second snapshot read is served by durable CAS");
    await log.close();

    const reopenedClient = new FakeReadDownClient([snapshot]);
    const reopened = makeSession(reopenedClient, stateRoot);
    await reopened.latest();
    assert.equal(reopenedClient.blobRequests.length, 0, "reconnect manifest diff reuses CAS across process sessions");
    await reopened.close();
  });
});

test("blob digest mismatch fails closed instead of entering reconnect retry", async () => {
  await withStateRoot(async (stateRoot) => {
    const snapshot = makeSnapshot(1, { "notes.md": Buffer.from("trusted\n") });
    const client = new FakeReadDownClient([snapshot]);
    client.corruptBlob = true;
    const session = makeSession(client, stateRoot);

    await assert.rejects(session.latest(), /BLOB_DIGEST_MISMATCH/u);
    assert.equal(client.beginRequests, 1, "integrity failure is terminal for this read, not an infinite reconnect");
    await session.close();
  });
});

test("stateful reconnect opens a new cut, CAS-deduplicates its manifest, and requires explicit cursor resync", async () => {
  await withStateRoot(async (stateRoot) => {
    const shared = Buffer.from("shared\n");
    const before = makeSnapshot(1, { "shared.md": shared });
    const after = makeSnapshot(3, {
      "shared.md": shared,
      "new.md": Buffer.from("new\n")
    });
    const client = new FakeReadDownClient([before, after]);
    const session = makeSession(client, stateRoot);

    assert.deepEqual(await session.changesAfter(1), []);
    assert.equal(client.blobRequests.length, 1);
    client.disconnect();
    await waitFor(() => client.beginRequests === 2);

    await assert.rejects(
      session.changesAfter(1),
      (error: unknown) => error instanceof RemoteReplicaResyncRequiredError
        && error.cutRevision === 3
        && error.cutChange?.revision === 3
    );
    assert.deepEqual(
      client.blobRequests.map((request) => request.digest).sort(),
      [digest(Buffer.from("new\n")), digest(shared)].sort(),
      "new cut pulls only the blob absent from local CAS"
    );
    assert.deepEqual(await session.changesAfter(3), []);
    await session.close();
  });
});

test("notifications carry metadata only, fill forward gaps, and deliver revisions once in order", async () => {
  await withStateRoot(async (stateRoot) => {
    const base = makeSnapshot(0, {});
    const change1 = makeChange(base, 1, { "one.md": Buffer.from("one\n") });
    const change2 = makeChange(change1.snapshot, 2, { "two.md": Buffer.from("two\n") });
    for (const [digestKey, bytes] of change2.snapshot.blobs) {
      (base.blobs as Map<Sha256Digest, Buffer>).set(digestKey, bytes);
    }
    base.forwardChanges.push(change1.change, change2.change);
    const client = new FakeReadDownClient([base]);
    const session = makeSession(client, stateRoot);
    const received: number[] = [];
    const unsubscribe = session.subscribe((change) => received.push(change.revision));

    await session.changesAfter(0);
    client.notify(change2.change);
    await waitFor(() => received.length === 2);

    assert.deepEqual(received, [1, 2]);
    assert.equal(client.blobRequests.length, 0, "notification and log catch-up do not pull file bodies");
    const snapshot = await session.snapshotAt(change2.change);
    assert.deepEqual(snapshot.entries.map((entry) => entry.path), ["one.md", "two.md"]);
    assert.equal(client.blobRequests.length, 2, "content is fetched only through CAS snapshot reads");
    unsubscribe();
    await session.close();
  });
});

test("reconnect backoff is capped and lease renewal or absolute lifetime transitions are stateful", async () => {
  await withStateRoot(async (stateRoot) => {
    let now = Date.parse("2026-07-23T04:00:00.000Z");
    const first = makeSnapshot(0, {}, now + 1_000, now + 5_000);
    const second = makeSnapshot(0, {}, now + 2_000, now + 10_000);
    const client = new FakeReadDownClient([first, second]);
    client.advanceOnReconnect = false;
    client.connectFailures = 3;
    const sleeps: number[] = [];
    const scheduled: Array<() => void> = [];
    const session = new RemoteReadDownSession({
      client: client as unknown as PersistentSshAuthorityClient,
      workspaceId,
      stateRoot,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      schedule: (_milliseconds, callback) => {
        scheduled.push(callback);
        return { dispose: () => undefined };
      },
      backoff: { initialMs: 2, maximumMs: 5, multiplier: 2 }
    });

    await session.latest();
    assert.deepEqual(sleeps, [2, 4, 5]);
    client.advanceOnReconnect = true;
    scheduled.shift()!();
    await waitFor(() => client.renewRequests === 1);
    assert.ok(scheduled.length > 0, "successful renewal schedules the next keepalive");

    now = Date.parse(first.reservation.lease.renewableUntil);
    scheduled.at(-1)!();
    await waitFor(() => client.beginRequests === 2);
    assert.equal(client.reconnectRequests > 0, true, "absolute lease lifetime creates a new connection and snapshot");
    await session.close();
  });
});

test("lease renewal failure reconnects and begins a new snapshot instead of extending stale state", async () => {
  await withStateRoot(async (stateRoot) => {
    const now = Date.parse("2026-07-23T04:00:00.000Z");
    const first = makeSnapshot(1, { "one.md": Buffer.from("one\n") }, now + 1_000, now + 5_000);
    const second = makeSnapshot(2, { "two.md": Buffer.from("two\n") }, now + 2_000, now + 10_000);
    const client = new FakeReadDownClient([first, second]);
    client.failRenewal = true;
    const scheduled: Array<() => void> = [];
    const session = new RemoteReadDownSession({
      client: client as unknown as PersistentSshAuthorityClient,
      workspaceId,
      stateRoot,
      now: () => now,
      schedule: (_milliseconds, callback) => {
        scheduled.push(callback);
        return { dispose: () => undefined };
      },
      backoff: { initialMs: 0, maximumMs: 0, multiplier: 1 }
    });

    await session.latest();
    scheduled.shift()!();
    await waitFor(() => client.beginRequests === 2);
    assert.equal(client.renewRequests, 1);
    assert.equal(client.reconnectRequests, 1);
    await session.close();
  });
});

interface SnapshotFixture {
  readonly reservation: AuthoritySnapshotReservation;
  readonly manifest: AuthoritySnapshotManifest;
  readonly cutChange: ReplicaChangeRecord | null;
  readonly blobs: ReadonlyMap<Sha256Digest, Buffer>;
  readonly forwardChanges: ReplicaChangeRecord[];
}

class FakeReadDownClient {
  readonly snapshots: ReadonlyArray<SnapshotFixture>;
  readonly blobRequests: Array<{ readonly snapshot: number; readonly digest: Sha256Digest }> = [];
  beginRequests = 0;
  renewRequests = 0;
  reconnectRequests = 0;
  connectFailures = 0;
  advanceOnReconnect = true;
  failRenewal = false;
  corruptBlob = false;
  private snapshotIndex = 0;
  private readonly notificationListeners = new Set<(change: ReplicaChangeRecord) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  constructor(snapshots: ReadonlyArray<SnapshotFixture>) {
    this.snapshots = snapshots;
  }

  async connect(): Promise<void> {
    if (this.connectFailures > 0) {
      this.connectFailures -= 1;
      throw new Error("scripted connect failure");
    }
  }

  async reconnect(): Promise<void> {
    this.reconnectRequests += 1;
    if (this.advanceOnReconnect && this.snapshotIndex < this.snapshots.length - 1) this.snapshotIndex += 1;
  }

  async beginSnapshotAndSubscribe(): Promise<AuthoritySnapshotReservation> {
    this.beginRequests += 1;
    return structuredClone(this.current().reservation);
  }

  async getSnapshotManifest(): Promise<AuthoritySnapshotManifest> {
    return structuredClone(this.current().manifest);
  }

  async getCutChange(): Promise<ReplicaChangeRecord | null> {
    return structuredClone(this.current().cutChange);
  }

  async getBlob(_streamToken: string, requested: Sha256Digest): Promise<Uint8Array> {
    this.blobRequests.push({ snapshot: this.snapshotIndex, digest: requested });
    const bytes = this.current().blobs.get(requested);
    if (!bytes) throw new Error(`missing scripted blob ${requested}`);
    return this.corruptBlob ? Buffer.from("changed") : Buffer.from(bytes);
  }

  async changesAfter(_streamToken: string, sinceRevision: number): Promise<AuthorityChangesAfterResult> {
    const current = this.current();
    if (sinceRevision < current.reservation.cut.revision) {
      throw new AuthorityReadDownRequestError("RESYNC_REQUIRED", "CURSOR_PRECEDES_PINNED_CUT");
    }
    const changes = current.forwardChanges.filter((change) => change.revision > sinceRevision);
    return {
      schema: "authority-changes-after/v1",
      sinceRevision,
      throughRevision: changes.at(-1)?.revision ?? sinceRevision,
      changes: structuredClone(changes)
    };
  }

  async renewLease(): Promise<AuthoritySnapshotLease> {
    this.renewRequests += 1;
    if (this.failRenewal) throw new AuthorityReadDownRequestError("SNAPSHOT_EXPIRED", "scripted renewal failure");
    const current = this.current().reservation.lease;
    return {
      ...current,
      expiresAt: new Date(Date.parse(current.expiresAt) + 1_000).toISOString()
    };
  }

  onNotification(listener: (change: ReplicaChangeRecord) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async close(): Promise<void> {}

  notify(change: ReplicaChangeRecord): void {
    for (const listener of this.notificationListeners) listener(change);
  }

  disconnect(): void {
    if (this.snapshotIndex < this.snapshots.length - 1) this.snapshotIndex += 1;
    for (const listener of this.disconnectListeners) listener();
  }

  private current(): SnapshotFixture {
    return this.snapshots[this.snapshotIndex]!;
  }
}

function makeSession(client: FakeReadDownClient, stateRoot: string): RemoteReadDownSession {
  return new RemoteReadDownSession({
    client: client as unknown as PersistentSshAuthorityClient,
    workspaceId,
    stateRoot,
    backoff: { initialMs: 0, maximumMs: 0, multiplier: 1 }
  });
}

function makeSnapshot(
  revision: number,
  files: Readonly<Record<string, Buffer>>,
  expiresAt = Date.now() + 60_000,
  renewableUntil = Date.now() + 3_600_000
): SnapshotFixture {
  const entries = Object.entries(files).map(([pathName, bytes]) => ({
    path: pathName,
    blobDigest: digest(bytes),
    mode: "100644" as const,
    tombstone: false as const
  })).sort((left, right) => left.path.localeCompare(right.path, "en"));
  const commitSha = revision.toString(16).padStart(40, "0");
  const cutBase = { workspaceId, epoch: "7", revision, commitSha };
  const cut = {
    ...cutBase,
    manifestDigest: manifestDigest(cutBase, entries),
    provenanceDigest: digest(Buffer.from(`provenance-${revision}`))
  };
  const reservation: AuthoritySnapshotReservation = {
    schema: "authority-snapshot-reservation/v1",
    cut,
    lease: {
      leaseId: `lease-${revision}`,
      expiresAt: new Date(expiresAt).toISOString(),
      renewableUntil: new Date(renewableUntil).toISOString(),
      minRetainedRevision: revision + 1,
      pinnedBlobSetDigest: digest(Buffer.from(`set-${revision}`))
    },
    stream: { streamToken: `stream-${revision}`, fromRevision: revision + 1 }
  };
  const manifest: AuthoritySnapshotManifest = {
    schema: "authority-snapshot-manifest/v1",
    cut,
    entries
  };
  const cutChange = revision === 0 ? null : recordFor(revision, commitSha, cut.manifestDigest, entries.length, []);
  return {
    reservation,
    manifest,
    cutChange,
    blobs: new Map(Object.values(files).map((bytes) => [digest(bytes), bytes])),
    forwardChanges: []
  };
}

function makeChange(
  previous: SnapshotFixture,
  revision: number,
  additions: Readonly<Record<string, Buffer>>
): { readonly snapshot: SnapshotFixture; readonly change: ReplicaChangeRecord } {
  const files = Object.fromEntries(previous.manifest.entries.map((entry) => [
    entry.path,
    previous.blobs.get(entry.blobDigest)!
  ]));
  const snapshot = makeSnapshot(revision, { ...files, ...additions });
  const paths = Object.entries(additions).map(([pathName, bytes]) => ({
    path: pathName,
    blobDigest: digest(bytes),
    mode: "100644" as const,
    tombstone: false as const
  }));
  const change = recordFor(
    revision,
    snapshot.reservation.cut.commitSha,
    snapshot.reservation.cut.manifestDigest,
    snapshot.manifest.entries.length,
    paths
  );
  for (const [key, value] of snapshot.blobs) (previous.blobs as Map<Sha256Digest, Buffer>).set(key, value);
  return { snapshot, change };
}

function recordFor(
  revision: number,
  commitSha: string,
  manifest: Sha256Digest,
  entryCount: number,
  paths: ReplicaChangeRecord["paths"]
): ReplicaChangeRecord {
  return {
    schema: "replica-change/v2",
    workspaceId,
    revision,
    opId: `op-${revision}`,
    semanticDigest: `semantic-${revision}`,
    operations: [{ opId: `op-${revision}`, semanticDigest: `semantic-${revision}` }],
    commitSha,
    previousCommit: revision > 1 ? (revision - 1).toString(16).padStart(40, "0") : null,
    changedAt: "2026-07-23T04:00:00.000Z",
    manifest: { digest: manifest, entryCount },
    paths
  };
}

function digest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function withStateRoot(body: (stateRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ha-remote-read-down-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for remote read-down condition");
}
