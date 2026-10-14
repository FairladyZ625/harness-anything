import { createReadStream } from "node:fs";
import {
  replicationContentClaims,
  type PersistedCanonicalEventV1,
  type ReplicationCommit,
  type ReplicationPosition,
} from "@harness-anything/kernel";
import { consumeKnownError } from "@harness-anything/kernel";
import type { BaseBackupArchive } from "./basebackup.ts";
import { REPLICATION_CHUNK_BYTES, type ReplicationPeer } from "./protocol.ts";
import type { ReplicationSlotLease, ReplicationSlots } from "./replication-slot.ts";

export interface ReplicationSource {
  readonly read: (after: ReplicationPosition) => {
    readonly commits: readonly ReplicationCommit[];
    readonly done: boolean;
    readonly head: ReplicationPosition;
  } | null;
  /** Register the waiter and recheck sequence under the same owner; never lose a commit between read and wait. */
  readonly wait: (after: ReplicationPosition, signal: AbortSignal) => Promise<void>;
  readonly backup: (signal: AbortSignal) => Promise<BaseBackupArchive & { readonly release: () => Promise<void> }>;
  readonly object: (sha256: string) => AsyncIterable<Uint8Array>;
}

async function sendBytes(
  peer: ReplicationPeer,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  let offset = 0;
  for await (const chunk of chunks) {
    for (let start = 0; start < chunk.byteLength; start += REPLICATION_CHUNK_BYTES) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk.subarray(start, start + REPLICATION_CHUNK_BYTES));
      await peer.send({ type: "replica.data", offset, data: bytes.toString("base64") });
      offset += bytes.length;
    }
  }
}

/** One bounded page in flight; transport backpressure and its ACK bound sender memory and cursor retention. */
export async function runWalSender(input: {
  readonly peer: ReplicationPeer;
  readonly source: ReplicationSource;
  readonly slots: ReplicationSlots;
  readonly lease: ReplicationSlotLease;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { peer, source, slots, lease, signal } = input;
  const assertOwner = () => {
    signal.throwIfAborted();
    if (!slots.current(lease)) throw new Error("replication session fenced");
  };
  const acknowledge = async (sent: ReplicationPosition) => {
    const frame = await peer.receive(signal);
    if (
      frame.type !== "replica.ack" ||
      frame.durable.sequence !== sent.sequence ||
      frame.durable.revision !== sent.revision ||
      frame.applied.sequence !== sent.sequence ||
      frame.applied.revision !== sent.revision
    )
      throw new Error("replication ACK does not match completed page");
    slots.acknowledge(lease, frame, sent);
  };
  const start = await peer.receive(signal);
  if (start.type !== "replica.start") throw new Error("replication start required");
  let position = start.position;
  for (;;) {
    assertOwner();
    let page: ReturnType<ReplicationSource["read"]>,
      reason = "replication window unavailable";
    try {
      page = position === null ? null : source.read(position);
    } catch (error) {
      // Only the store's revision_conflict verdict means the replica left this history; any other read failure is a fault.
      if ((error as { readonly code?: unknown }).code !== "revision_conflict") throw error;
      consumeKnownError(error);
      reason = "replication history mismatch";
      page = null;
    }
    if (page === null) {
      if (position !== null) await peer.send({ type: "replica.resync", reason });
      const archive = await source.backup(signal);
      try {
        assertOwner();
        if (archive.metadata.position.history !== lease.history)
          throw new Error("replication history changed during backup");
        await peer.send({
          type: "replica.backup",
          metadata: archive.metadata,
          size: archive.size,
          sha256: archive.sha256,
        });
        await sendBytes(peer, createReadStream(archive.file, { highWaterMark: REPLICATION_CHUNK_BYTES }), signal);
        await peer.send({ type: "replica.backup.end" });
        await acknowledge(archive.metadata.position);
        position = archive.metadata.position;
      } finally {
        await archive.release();
      }
      continue;
    }
    for (const commit of page.commits) {
      assertOwner();
      const bytes = Buffer.from(JSON.stringify(commit));
      await peer.send({ type: "replica.commit", size: bytes.length });
      await sendBytes(peer, [bytes], signal);
      const objects = new Map<string, number>();
      for (const row of commit.events)
        for (const claim of replicationContentClaims(JSON.parse(row.eventJson) as PersistedCanonicalEventV1))
          objects.set(claim.sha256, claim.size);
      for (const [sha256, size] of objects) {
        await peer.send({ type: "replica.object", sha256, size });
        await sendBytes(peer, source.object(sha256), signal);
        await peer.send({ type: "replica.object.end" });
      }
      await peer.send({ type: "replica.commit.end" });
      position = commit.position;
    }
    await peer.send({ type: "replica.progress", head: position! });
    await acknowledge(position!);
    // S advances on every commit, including eventless outcomes. Only the reader's done terminates a page walk.
    if (page.done) await source.wait(position!, signal);
  }
}
