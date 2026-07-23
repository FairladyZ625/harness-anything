// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ReplicaChangeRecord } from "../../application/src/index.ts";
import {
  AuthorityReadDownRequestError,
  AuthorityTransportDisconnectedError,
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
import { deferred, type Deferred } from "./remote-read-down-test-support.ts";

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

test("late renewal and stale fetch continuations cannot overwrite or clear a replacement generation", async () => {
  await withStateRoot(async (stateRoot) => {
    const now = Date.parse("2026-07-23T04:00:00.000Z");
    const first = makeSnapshot(1, { "one.md": Buffer.from("one\n") }, now + 1_000, now + 5_000);
    const second = makeSnapshot(2, { "two.md": Buffer.from("two\n") }, now + 2_000, now + 10_000);
    const client = new FakeReadDownClient([first, second]);
    const renewal = deferred<AuthoritySnapshotLease>();
    const fetch = deferred<AuthorityChangesAfterResult>();
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

    assert.equal((await session.latest())?.revision, 1);
    client.renewalGate = renewal;
    client.changesGate = fetch;
    const staleFetch = session.changesAfter(1);
    await waitFor(() => client.changesRequests === 2);
    scheduled.shift()!();
    await waitFor(() => client.renewRequests === 1);
    client.disconnect();
    await waitFor(() => client.beginRequests === 2);

    renewal.resolve({
      ...first.reservation.lease,
      expiresAt: new Date(now + 3_000).toISOString()
    });
    fetch.reject(new AuthorityTransportDisconnectedError("stale fetch disconnected"));
    client.changesGate = undefined;
    await assert.rejects(
      staleFetch,
      (error: unknown) => error instanceof RemoteReplicaResyncRequiredError && error.cutRevision === 2
    );
    assert.equal((await session.latest())?.revision, 2, "late continuations leave the replacement cut installed");
    assert.equal(client.beginRequests, 2, "stale catch does not clear and reopen the replacement generation");
    await session.close();
  });
});

test("same-epoch reconnect inherits the delivered cursor and keeps an existing subscription live", async () => {
  await withStateRoot(async (stateRoot) => {
    const base = makeSnapshot(0, {});
    const firstChange = makeChange(base, 1, { "one.md": Buffer.from("one\n") });
    base.forwardChanges.push(firstChange.change);
    const next = firstChange.snapshot;
    const secondChange = makeChange(next, 2, { "two.md": Buffer.from("two\n") });
    next.forwardChanges.push(secondChange.change);
    const client = new FakeReadDownClient([base, next]);
    const session = makeSession(client, stateRoot);
    const received: number[] = [];
    session.subscribe((change) => received.push(change.revision));

    await session.changesAfter(0);
    await waitFor(() => received.includes(1));
    client.disconnect();
    await waitFor(() => client.beginRequests === 2);
    client.notify(secondChange.change);
    await waitFor(() => received.includes(2));

    assert.deepEqual(received, [1, 2]);
    await session.close();
  });
});

test("epoch replacement and same-revision identity drift require explicit resync with a bootstrap cut", async () => {
  await withStateRoot(async (stateRoot) => {
    const before = makeSnapshot(1, { "value.md": Buffer.from("old\n") }, undefined, undefined, "7");
    const after = makeSnapshot(1, { "value.md": Buffer.from("new\n") }, undefined, undefined, "8");
    const client = new FakeReadDownClient([before, after]);
    const session = makeSession(client, stateRoot);

    const oldChange = await session.latest();
    await session.changesAfter(1);
    client.disconnect();
    await waitFor(() => client.beginRequests === 2);
    await assert.rejects(
      session.changesAfter(1),
      (error: unknown) => error instanceof RemoteReplicaResyncRequiredError
        && error.cut.epoch === "8"
        && error.cut.manifestDigest === after.reservation.cut.manifestDigest
        && error.cutChange?.revision === 1
    );
    await assert.rejects(
      session.snapshotAt(oldChange!),
      /CHANGE_EPOCH_MISMATCH/u
    );
    const replacement = await session.snapshotAt(after.cutChange!);
    assert.equal(Buffer.from(replacement.entries[0]!.content).toString("utf8"), "new\n");
    assert.deepEqual(await session.changesAfter(1), [], "retry at the bootstrap cut explicitly acknowledges resync");
    await session.close();
  });
});

test("close cancels recovery sleep and joins in-flight blob work before resolving", async () => {
  await withStateRoot(async (stateRoot) => {
    const snapshot = makeSnapshot(1, { "value.md": Buffer.from("value\n") });
    const sleeping = deferred<void>();
    const client = new FakeReadDownClient([snapshot]);
    client.connectFailures = 1;
    const session = new RemoteReadDownSession({
      client: client as unknown as PersistentSshAuthorityClient,
      workspaceId,
      stateRoot,
      sleep: () => sleeping.promise,
      backoff: { initialMs: 1, maximumMs: 1, multiplier: 1 }
    });
    const pending = session.latest();
    await waitFor(() => client.connectRequests === 1);
    await session.close();
    await assert.rejects(pending, /closed|connect failure/u);
    sleeping.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(client.reconnectRequests, 0, "recovery does not reconnect after close");
  });

  await withStateRoot(async (stateRoot) => {
    const snapshot = makeSnapshot(1, { "value.md": Buffer.from("value\n") });
    const blob = deferred<void>();
    const client = new FakeReadDownClient([snapshot]);
    client.blobGate = blob;
    const session = makeSession(client, stateRoot);
    const pending = session.latest();
    await waitFor(() => client.activeBlobRequests === 1);
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(closed, false, "close waits for an in-flight blob operation");
    blob.resolve();
    await closing;
    await assert.rejects(pending, /closed/u);
    assert.equal(client.activeBlobRequests, 0);
  });
});

test("a corrupted durable CAS object is a terminal integrity failure without reconnect", async () => {
  await withStateRoot(async (stateRoot) => {
    const bytes = Buffer.from("trusted\n");
    const snapshot = makeSnapshot(1, { "value.md": bytes });
    const firstClient = new FakeReadDownClient([snapshot]);
    const firstSession = makeSession(firstClient, stateRoot);
    await firstSession.latest();
    await firstSession.close();

    const objectDigest = digest(bytes).slice("sha256:".length);
    await writeFile(path.join(stateRoot, "cas", objectDigest.slice(0, 2), objectDigest.slice(2)), "corrupt");
    const client = new FakeReadDownClient([snapshot]);
    const session = makeSession(client, stateRoot);
    await assert.rejects(session.latest(), /CAS object corrupted/u);
    assert.equal(client.beginRequests, 1);
    assert.equal(client.reconnectRequests, 0, "deterministic local corruption is not retried as transport failure");
    await assert.rejects(session.latest(), /CAS object corrupted/u);
    assert.equal(client.beginRequests, 1, "terminal integrity failure is sticky for the session");
    await session.close();
  });
});

test("notification cache remains count and byte bounded under a large hint burst", async () => {
  await withStateRoot(async (stateRoot) => {
    const base = makeSnapshot(0, {});
    const client = new FakeReadDownClient([base]);
    const session = new RemoteReadDownSession({
      client: client as unknown as PersistentSshAuthorityClient,
      workspaceId,
      stateRoot,
      changeCache: { maxCount: 32, maxBytes: 32 * 1024 },
      backoff: { initialMs: 0, maximumMs: 0, multiplier: 1 }
    });
    await session.latest();
    for (let revision = 1; revision <= 50_000; revision += 1) {
      client.notify(recordFor(
        revision,
        revision.toString(16).padStart(40, "0"),
        digest(Buffer.from(`manifest-${revision}`)),
        0,
        []
      ));
    }
    const active = (session as unknown as {
      readonly active: { readonly changes: ReadonlyMap<number, ReplicaChangeRecord>; readonly changeBytes: number };
    }).active;
    assert.ok(active.changes.size <= 32);
    assert.ok(active.changeBytes <= 32 * 1024);
    assert.equal((await session.latest())?.revision, 32, "highest revision lookup does not spread the large input set");
    await session.close();
  });
});

test("blob warming deduplicates digest requests and all blob IO stays batch bounded", async () => {
  await withStateRoot(async (stateRoot) => {
    const shared = Buffer.from("shared\n");
    const duplicateFiles = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`shared-${index}.md`, shared])
    );
    const duplicateSnapshot = makeSnapshot(1, duplicateFiles);
    const duplicateClient = new FakeReadDownClient([duplicateSnapshot]);
    const duplicateSession = makeSession(duplicateClient, stateRoot);
    await duplicateSession.latest();
    assert.equal(duplicateClient.blobRequests.length, 1, "manifest warming pulls each digest once");
    await duplicateSession.close();
  });

  await withStateRoot(async (stateRoot) => {
    const files = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`file-${index}.md`, Buffer.from(`value-${index}\n`)])
    );
    const snapshot = makeSnapshot(1, files);
    const client = new FakeReadDownClient([snapshot]);
    client.delayBlobs = true;
    const session = makeSession(client, stateRoot);
    await session.latest();
    assert.ok(client.maximumBlobConcurrency <= 8, "manifest warming observes the batch limit");
    await rm(path.join(stateRoot, "cas"), { recursive: true, force: true });
    client.maximumBlobConcurrency = 0;
    await session.snapshotAt(snapshot.cutChange!);
    assert.ok(client.maximumBlobConcurrency <= 8, "snapshot materialization observes the batch limit");
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
  connectRequests = 0;
  changesRequests = 0;
  renewRequests = 0;
  reconnectRequests = 0;
  activeBlobRequests = 0;
  maximumBlobConcurrency = 0;
  connectFailures = 0;
  advanceOnReconnect = true;
  failRenewal = false;
  corruptBlob = false;
  delayBlobs = false;
  renewalGate: Deferred<AuthoritySnapshotLease> | undefined;
  changesGate: Deferred<AuthorityChangesAfterResult> | undefined;
  blobGate: Deferred<void> | undefined;
  private snapshotIndex = 0;
  private readonly notificationListeners = new Set<(change: ReplicaChangeRecord) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  constructor(snapshots: ReadonlyArray<SnapshotFixture>) {
    this.snapshots = snapshots;
  }

  async connect(): Promise<void> {
    this.connectRequests += 1;
    if (this.connectFailures > 0) {
      this.connectFailures -= 1;
      throw new AuthorityTransportDisconnectedError("scripted connect failure");
    }
  }

  async reconnect(): Promise<void> {
    this.reconnectRequests += 1;
    if (this.connectFailures > 0) {
      this.connectFailures -= 1;
      throw new AuthorityTransportDisconnectedError("scripted reconnect failure");
    }
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
    this.activeBlobRequests += 1;
    this.maximumBlobConcurrency = Math.max(this.maximumBlobConcurrency, this.activeBlobRequests);
    try {
      if (this.blobGate) await this.blobGate.promise;
      if (this.delayBlobs) await new Promise((resolve) => setTimeout(resolve, 1));
      const bytes = this.current().blobs.get(requested);
      if (!bytes) throw new Error(`missing scripted blob ${requested}`);
      return this.corruptBlob ? Buffer.from("changed") : Buffer.from(bytes);
    } finally {
      this.activeBlobRequests -= 1;
    }
  }

  async changesAfter(_streamToken: string, sinceRevision: number): Promise<AuthorityChangesAfterResult> {
    this.changesRequests += 1;
    if (this.changesGate) return this.changesGate.promise;
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
    if (this.renewalGate) return this.renewalGate.promise;
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
  renewableUntil = Date.now() + 3_600_000,
  epoch = "7"
): SnapshotFixture {
  const entries = Object.entries(files).map(([pathName, bytes]) => ({
    path: pathName,
    blobDigest: digest(bytes),
    mode: "100644" as const,
    tombstone: false as const
  })).sort((left, right) => left.path.localeCompare(right.path, "en"));
  const commitSha = revision.toString(16).padStart(40, "0");
  const cutBase = { workspaceId, epoch, revision, commitSha };
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
