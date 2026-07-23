// harness-test-tier: integration
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { authorityProtocolTuple, type ReplicaChangeRecord } from "../../application/src/index.ts";
import {
  authorityWireFrameType,
  type AuthoritySnapshotLease,
  type AuthoritySnapshotManifest,
  type AuthoritySnapshotReservation
} from "../src/authority/protocol.ts";
import {
  PersistentSshAuthorityClient,
  type SshAuthorityChild,
  type SshAuthorityChildFactory
} from "../src/transport/persistent-ssh-authority-client.ts";
import {
  createLengthPrefixedFrameReader,
  encodeLengthPrefixedFrame
} from "../src/transport/length-frame-codec.ts";

const workspaceId = "workspace-read-down-client";
const digest = `sha256:${"1".repeat(64)}` as const;

test("persistent SSH client consumes all six frozen read-down request frames", async () => {
  const requested: Array<Record<string, unknown>> = [];
  const lease: AuthoritySnapshotLease = {
    leaseId: "lease-read-down",
    expiresAt: "2026-07-23T04:09:00.000Z",
    renewableUntil: "2026-07-23T05:00:00.000Z",
    minRetainedRevision: 2,
    pinnedBlobSetDigest: digest
  };
  const cutChange = change();
  const reservation: AuthoritySnapshotReservation = {
    schema: "authority-snapshot-reservation/v1",
    cut: {
      workspaceId,
      epoch: "7",
      revision: 1,
      commitSha: cutChange.commitSha,
      manifestDigest: digest,
      provenanceDigest: digest
    },
    lease,
    stream: { streamToken: "stream-token", fromRevision: 2 }
  };
  const manifest: AuthoritySnapshotManifest = {
    schema: "authority-snapshot-manifest/v1",
    cut: reservation.cut,
    entries: []
  };
  const changes = {
    schema: "authority-changes-after/v1" as const,
    sinceRevision: 1,
    throughRevision: 1,
    changes: []
  };
  const client = new PersistentSshAuthorityClient({
    target: { destination: "authority.internal", fixedCommand: "ha-authority-connect" },
    workspaceId,
    channelNonceDigest: () => "sha256:channel-generation",
    protocol: authorityProtocolTuple,
    childFactory: scriptedChildFactory(
      { lease, cutChange, reservation, manifest, changes, blob: Buffer.from("blob") },
      requested
    )
  });

  await client.connect();
  assert.deepEqual(await client.beginSnapshotAndSubscribe(), reservation);
  assert.deepEqual(await client.getSnapshotManifest("stream-token", digest), manifest);
  assert.deepEqual(await client.getBlob("stream-token", digest), Buffer.from("blob"));
  assert.deepEqual(await client.changesAfter("stream-token", 1), changes);
  assert.deepEqual(await client.renewLease("stream-token"), lease);
  assert.deepEqual(await client.getCutChange("stream-token"), cutChange);
  assert.deepEqual(requested, [
    { kind: "begin_snapshot_and_subscribe", workspaceId },
    { kind: "get_snapshot_manifest", streamToken: "stream-token", manifestDigest: digest },
    { kind: "get_blob", streamToken: "stream-token", digest },
    { kind: "changes_after", workspaceId, streamToken: "stream-token", sinceRevision: 1 },
    { kind: "renew_lease", workspaceId, streamToken: "stream-token" },
    { kind: "get_cut_change", streamToken: "stream-token" }
  ]);
  await client.close();
});

test("concurrent reconnects share one connection transition and reject the replaced generation", async () => {
  let spawnCount = 0;
  const client = new PersistentSshAuthorityClient({
    target: { destination: "authority.internal", fixedCommand: "ha-authority-connect" },
    workspaceId,
    channelNonceDigest: () => "sha256:channel-generation",
    protocol: authorityProtocolTuple,
    childFactory: frameHandlingChildFactory((frame, respond) => {
      if (frame.kind === "hello") respond({
        accepted: true,
        protocol: authorityProtocolTuple,
        capabilities: []
      });
    }, () => {
      spawnCount += 1;
    })
  });

  await client.connect();
  const pending = client.changesAfter("stream-token", 1);
  const firstReconnect = client.reconnect();
  const secondReconnect = client.reconnect();

  await assert.rejects(pending, /connection replaced/u);
  await Promise.all([firstReconnect, secondReconnect]);
  assert.equal(spawnCount, 2, "concurrent recovery creates exactly one replacement child");
  await client.close();
});

test("closing a negotiating child rejects its pending hello instead of leaving connect hung", async () => {
  let sawHello = false;
  const client = new PersistentSshAuthorityClient({
    target: { destination: "authority.internal", fixedCommand: "ha-authority-connect" },
    workspaceId,
    channelNonceDigest: () => "sha256:channel-generation",
    protocol: authorityProtocolTuple,
    childFactory: frameHandlingChildFactory((frame) => {
      if (frame.kind === "hello") sawHello = true;
    })
  });

  const connecting = client.connect();
  await waitFor(() => sawHello);
  await client.close();
  await assert.rejects(connecting, /connection closed/u);
});

function scriptedChildFactory(
  results: {
    readonly lease: AuthoritySnapshotLease;
    readonly cutChange: ReplicaChangeRecord;
    readonly reservation: AuthoritySnapshotReservation;
    readonly manifest: AuthoritySnapshotManifest;
    readonly changes: {
      readonly schema: "authority-changes-after/v1";
      readonly sinceRevision: number;
      readonly throughRevision: number;
      readonly changes: readonly [];
    };
    readonly blob: Buffer;
  },
  requested: Array<Record<string, unknown>>
): SshAuthorityChildFactory {
  return {
    spawn: () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const events = new EventEmitter();
      const reader = createLengthPrefixedFrameReader();
      stdin.on("data", (chunk: Buffer) => {
        const batch = reader.push(chunk);
        assert.equal(batch.error, undefined);
        for (const value of batch.frames) {
          const frame = value as Record<string, unknown> & {
            readonly kind: string;
            readonly requestId: string;
            readonly connectionGeneration: number;
          };
          if (frame.kind !== "hello") requested.push(selectRequestFields(frame));
          stdout.write(encodeLengthPrefixedFrame({
            type: authorityWireFrameType,
            kind: "response",
            requestId: frame.requestId,
            connectionGeneration: frame.connectionGeneration,
            ok: true,
            result: resultFor(frame.kind, frame, results)
          }));
        }
      });
      return {
        stdin,
        stdout,
        stderr,
        on: (event, listener) => events.on(event, listener),
        kill: () => {
          queueMicrotask(() => events.emit("exit", 0, null));
          return true;
        }
      } satisfies SshAuthorityChild;
    }
  };
}

function frameHandlingChildFactory(
  handle: (
    frame: Record<string, unknown> & {
      readonly kind: string;
      readonly requestId: string;
      readonly connectionGeneration: number;
    },
    respond: (result: unknown) => void
  ) => void,
  onSpawn: () => void = () => undefined
): SshAuthorityChildFactory {
  return {
    spawn: () => {
      onSpawn();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const events = new EventEmitter();
      const reader = createLengthPrefixedFrameReader();
      stdin.on("data", (chunk: Buffer) => {
        const batch = reader.push(chunk);
        assert.equal(batch.error, undefined);
        for (const value of batch.frames) {
          const frame = value as Record<string, unknown> & {
            readonly kind: string;
            readonly requestId: string;
            readonly connectionGeneration: number;
          };
          handle(frame, (result) => stdout.write(encodeLengthPrefixedFrame({
            type: authorityWireFrameType,
            kind: "response",
            requestId: frame.requestId,
            connectionGeneration: frame.connectionGeneration,
            ok: true,
            result
          })));
        }
      });
      return {
        stdin,
        stdout,
        stderr,
        on: (event, listener) => events.on(event, listener),
        kill: () => {
          queueMicrotask(() => events.emit("exit", 0, null));
          return true;
        }
      };
    }
  };
}

function resultFor(
  kind: string,
  frame: Readonly<Record<string, unknown>>,
  results: Parameters<typeof scriptedChildFactory>[0]
): unknown {
  if (kind === "hello") return { accepted: true, protocol: authorityProtocolTuple, capabilities: [] };
  if (kind === "begin_snapshot_and_subscribe") return results.reservation;
  if (kind === "get_snapshot_manifest") return results.manifest;
  if (kind === "get_blob") {
    return {
      schema: "authority-blob/v1",
      digest: frame.digest,
      encoding: "base64",
      bytes: results.blob.toString("base64")
    };
  }
  if (kind === "changes_after") return results.changes;
  if (kind === "get_cut_change") return results.cutChange;
  return results.lease;
}

function selectRequestFields(frame: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(frame).filter(([key]) => [
    "kind", "workspaceId", "streamToken", "manifestDigest", "digest", "sinceRevision"
  ].includes(key)));
}

function change(): ReplicaChangeRecord {
  return {
    schema: "replica-change/v2",
    workspaceId,
    revision: 1,
    opId: "op-cut",
    semanticDigest: "cut",
    operations: [{ opId: "op-cut", semanticDigest: "cut" }],
    commitSha: "1".repeat(40),
    previousCommit: null,
    changedAt: "2026-07-23T04:00:00.000Z",
    manifest: { digest, entryCount: 0 },
    paths: []
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for transport condition");
}
