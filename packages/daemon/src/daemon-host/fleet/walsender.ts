import type { ReplicaSyncPhase } from "./replica-status.ts";
import { REPOINT_RESUME_ONLY } from "./repoint-lineage.ts";
import { createReadStream } from "node:fs";
import {
  replicationCommitBytes,
  replicationCommitChunks,
  replicationContentClaims,
  type BaseBackupArchive,
  type BaseBackupMode,
  type BaseBackupObjectEntry,
  type ReplicationCommit,
  type ReplicationPosition,
  type ReplicationSlotLease,
  type ReplicationSlots,
} from "@harness-anything/storage";
import { type PersistedCanonicalEventV1 } from "@harness-anything/kernel";
import {
  REPLICATION_BINARY_CHUNK_BYTES,
  REPLICATION_CHUNK_BYTES,
  REPLICATION_OBJECT_MANIFEST_BATCH,
  REPLICATION_OBJECT_PACK_MAX_BYTES,
  SNAPSHOT_BINARY_WIRE_CAPABILITY,
  SNAPSHOT_OBJECT_PACK_CAPABILITY,
  SNAPSHOT_RESUME_CAPABILITY,
  type ReplicationFrame,
  type ReplicationPeer,
} from "../../fleet-sync/fleet/protocol.ts";

export interface ReplicationSource {
  readonly authorize?: () => Promise<void>;
  readonly read: (after: ReplicationPosition) => {
    readonly commits: readonly ReplicationCommit[];
    readonly done: boolean;
    readonly head: ReplicationPosition;
  } | null;
  /** Register the waiter and recheck sequence under the same owner; never lose a commit between read and wait. */
  readonly wait: (after: ReplicationPosition, signal: AbortSignal) => Promise<void>;
  /** The slot advanced; retention may release the log below the slowest slot. */
  readonly acknowledged: (sequence?: number) => Promise<void>;
  readonly backup: (
    signal: AbortSignal,
    resumeSnapshot?: { readonly snapshotId: string; readonly offset: number },
    options?: { readonly mode?: BaseBackupMode },
  ) => Promise<
    BaseBackupArchive & {
      readonly snapshotId?: string;
      readonly resumeOffset?: number;
      readonly release: () => Promise<void>;
    }
  >;
  readonly object: (sha256: string) => AsyncIterable<Uint8Array>;
}

async function sendBytes(
  peer: ReplicationPeer,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  signal: AbortSignal,
  onProgress?: (bytes: number) => void,
  initialOffset = 0,
  binaryWire = false,
): Promise<void> {
  const chunkBytes = binaryWire ? REPLICATION_BINARY_CHUNK_BYTES : REPLICATION_CHUNK_BYTES;
  let offset = initialOffset;
  for await (const chunk of chunks) {
    for (let start = 0; start < chunk.byteLength; start += chunkBytes) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk.subarray(start, start + chunkBytes));
      if (binaryWire) {
        await peer.send({ type: "replica.data.bin", offset, data: bytes });
      } else {
        await peer.send({ type: "replica.data", offset, data: bytes.toString("base64") });
      }
      offset += bytes.length;
      onProgress?.(offset);
    }
  }
}

async function* streamObjectPack(
  entries: readonly BaseBackupObjectEntry[],
  readObject: (sha256: string) => AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for (const entry of entries) {
    signal.throwIfAborted();
    const header = Buffer.allocUnsafe(72);
    Buffer.from(entry.sha256, "ascii").copy(header, 0);
    header.writeBigUInt64BE(BigInt(entry.size), 64);
    yield header;
    let written = 0;
    for await (const chunk of readObject(entry.sha256)) {
      signal.throwIfAborted();
      written += chunk.byteLength;
      yield chunk;
    }
    if (written !== entry.size) {
      throw new Error(
        `replication pack object size mismatch for ${entry.sha256}: expected ${entry.size}, got ${written}`,
      );
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
  readonly onFailure?: (failure: { readonly code: string; readonly message: string }) => void;
  readonly onAcknowledged?: () => void;
  readonly onActivity?: (
    phase: ReplicaSyncPhase,
    transfer?: { readonly bytesSent: number; readonly totalBytes: number },
  ) => void;
}): Promise<void> {
  const { peer, source, slots, lease, signal } = input;
  const assertOwner = () => {
    signal.throwIfAborted();
    if (!slots.current(lease)) throw new Error("replication session fenced");
  };
  const receiveExpecting = async (): Promise<ReplicationFrame> => {
    const frame = await peer.receive(signal);
    if (frame.type === "replica.failure") {
      input.onFailure?.({ code: frame.code, message: frame.message });
      const failure = new Error(frame.message) as Error & { code: string };
      failure.code = frame.code;
      throw failure;
    }
    return frame;
  };
  const acknowledge = async (sent: ReplicationPosition) => {
    input.onActivity?.("awaiting_ack");
    const frame = await receiveExpecting();
    if (
      frame.type !== "replica.ack" ||
      frame.durable.sequence !== sent.sequence ||
      frame.durable.revision !== sent.revision ||
      frame.applied.sequence !== sent.sequence ||
      frame.applied.revision !== sent.revision
    )
      throw new Error("replication ACK does not match completed page");
    slots.acknowledge(lease, frame, sent);
    await source.acknowledged(sent.sequence);
    input.onAcknowledged?.();
  };
  const start = await peer.receive(signal);
  if (start.type !== "replica.start") throw new Error("replication start required");
  const supportsSnapshotResume = start.capabilities?.includes(SNAPSHOT_RESUME_CAPABILITY) ?? false;
  const supportsBinaryWire = start.capabilities?.includes(SNAPSHOT_BINARY_WIRE_CAPABILITY) ?? false;
  const supportsObjectPack = start.capabilities?.includes(SNAPSHOT_OBJECT_PACK_CAPABILITY) ?? false;
  const wireChunkBytes = supportsBinaryWire ? REPLICATION_BINARY_CHUNK_BYTES : REPLICATION_CHUNK_BYTES;
  let position = start.position;
  let pendingResumeSnapshot = supportsSnapshotResume ? start.resumeSnapshot : undefined;
  for (;;) {
    assertOwner();
    input.onActivity?.("authorizing");
    await source.authorize?.();
    const read = readReplicationPage(source, position),
      page = read.page,
      reason = read.reason;
    if (page === null) {
      if (start.capabilities?.includes(REPOINT_RESUME_ONLY)) {
        await peer.send({ type: "replica.failure", code: "replication_resume_unavailable", message: reason });
        throw new Error(reason);
      }
      if (position !== null) await peer.send({ type: "replica.resync", reason });
      input.onActivity?.("waiting_backup");
      const resumeRequest = position === null ? pendingResumeSnapshot : undefined;
      pendingResumeSnapshot = undefined;
      const archive = await source.backup(signal, resumeRequest, supportsObjectPack ? { mode: "split" } : undefined);
      try {
        assertOwner();
        if (archive.metadata.position.history !== lease.history)
          throw new Error("replication history changed during backup");
        const isSplitPack = supportsObjectPack && archive.mode === "split";
        const resumeOffset =
          supportsSnapshotResume &&
          archive.resumeOffset !== undefined &&
          archive.resumeOffset > 0 &&
          archive.resumeOffset <= archive.size
            ? archive.resumeOffset
            : 0;
        await peer.send({
          type: "replica.backup",
          metadata: archive.metadata,
          size: archive.size,
          sha256: archive.sha256,
          ...(supportsSnapshotResume && archive.snapshotId ? { snapshotId: archive.snapshotId, resumeOffset } : {}),
          ...(isSplitPack ? { objectsMode: "pack" as const, objectCount: archive.objectCount ?? 0 } : {}),
        });
        const progress = (bytesSent: number) =>
          input.onActivity?.("sending_backup", { bytesSent, totalBytes: archive.size });
        progress(resumeOffset);
        if (resumeOffset < archive.size) {
          await sendBytes(
            peer,
            createReadStream(archive.file, { start: resumeOffset, highWaterMark: wireChunkBytes }),
            signal,
            progress,
            resumeOffset,
            supportsBinaryWire,
          );
        }
        await peer.send({ type: "replica.backup.end" });
        if (isSplitPack) {
          const allObjects: readonly BaseBackupObjectEntry[] = archive.objects ?? [];
          if (allObjects.length === 0) {
            await peer.send({ type: "replica.objects.manifest", entries: [], done: true });
            const want = await receiveExpecting();
            if (want.type !== "replica.objects.want") throw new Error("expected replica.objects.want");
          } else {
            for (let offset = 0; offset < allObjects.length; offset += REPLICATION_OBJECT_MANIFEST_BATCH) {
              assertOwner();
              const batch = allObjects.slice(offset, offset + REPLICATION_OBJECT_MANIFEST_BATCH);
              const done = offset + REPLICATION_OBJECT_MANIFEST_BATCH >= allObjects.length;
              await peer.send({ type: "replica.objects.manifest", entries: batch, done });
              const want = await receiveExpecting();
              if (want.type !== "replica.objects.want") throw new Error("expected replica.objects.want");
              if (want.sha256s.length === 0) continue;
              const byHash = new Map(batch.map((entry) => [entry.sha256, entry]));
              const wantedEntries: BaseBackupObjectEntry[] = [];
              for (const sha of want.sha256s) {
                const entry = byHash.get(sha);
                if (!entry) throw new Error(`replica.objects.want requested unexpected object ${sha}`);
                wantedEntries.push(entry);
              }
              let group: BaseBackupObjectEntry[] = [];
              let groupPayloadBytes = 0;
              const flushPack = async () => {
                if (group.length === 0) return;
                const totalBytes = group.reduce((sum, entry) => sum + 72 + entry.size, 0);
                await peer.send({ type: "replica.objects.pack", totalBytes, count: group.length });
                await sendBytes(
                  peer,
                  streamObjectPack(group, source.object, signal),
                  signal,
                  undefined,
                  0,
                  supportsBinaryWire,
                );
                await peer.send({ type: "replica.objects.pack.end" });
                group = [];
                groupPayloadBytes = 0;
              };
              for (const entry of wantedEntries) {
                if (group.length > 0 && groupPayloadBytes + 72 + entry.size > REPLICATION_OBJECT_PACK_MAX_BYTES) {
                  await flushPack();
                }
                group.push(entry);
                groupPayloadBytes += 72 + entry.size;
              }
              await flushPack();
            }
          }
        }
        await acknowledge(archive.metadata.position);
        position = archive.metadata.position;
      } finally {
        await archive.release();
      }
      continue;
    }
    const commitProgress = () => input.onActivity?.("sending_commits");
    commitProgress();
    for (const commit of page.commits) {
      assertOwner();
      await peer.send({ type: "replica.commit", size: replicationCommitBytes(commit) });
      await sendBytes(
        peer,
        (function* () {
          for (const chunk of replicationCommitChunks(commit)) yield Buffer.from(chunk);
        })(),
        signal,
        commitProgress,
        0,
        supportsBinaryWire,
      );
      const objects = new Map<string, number>();
      for (const row of commit.events)
        for (const claim of replicationContentClaims(JSON.parse(row.eventJson) as PersistedCanonicalEventV1))
          objects.set(claim.sha256, claim.size);
      for (const [sha256, size] of objects) {
        await peer.send({ type: "replica.object", sha256, size });
        await sendBytes(peer, source.object(sha256), signal, commitProgress, 0, supportsBinaryWire);
        await peer.send({ type: "replica.object.end" });
      }
      await peer.send({ type: "replica.commit.end" });
      position = commit.position;
    }
    commitProgress();
    await peer.send({ type: "replica.progress", head: position! });
    await acknowledge(position!);
    // S advances on every commit, including eventless outcomes. Only the reader's done terminates a page walk.
    if (page.done) {
      input.onActivity?.("waiting_for_commit");
      await source.wait(position!, signal);
    }
  }
}

function readReplicationPage(
  source: ReplicationSource,
  position: ReplicationPosition | null,
): {
  readonly page: ReturnType<ReplicationSource["read"]>;
  readonly reason: string;
} {
  try {
    return { page: position === null ? null : source.read(position), reason: "replication window unavailable" };
  } catch (error) {
    // A different history requires a new snapshot; every other read failure propagates.
    if ((error as { readonly code?: unknown }).code !== "revision_conflict") throw error;
    return { page: null, reason: "replication history mismatch" };
  }
}
