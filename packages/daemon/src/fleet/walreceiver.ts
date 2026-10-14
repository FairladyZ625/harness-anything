import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  makeTaskEventReader,
  makeTaskProjection,
  openReplicaStore,
  type CanonicalContentBlob,
  type ReplicationCommit,
  type ReplicationPosition,
} from "@harness-anything/kernel";
import { parseReplicationCommit, type ReplicationPeer } from "./protocol.ts";
import type { BaseBackupMetadata } from "./basebackup.ts";
import type { ReplicaGeneration } from "./replica-generation.ts";

/** The receiver owns the only mutable ledger handle; projection application is the center's implementation. */
export function openWalReceiverGeneration(generation: ReplicaGeneration) {
  const store = openReplicaStore({
    databasePath: generation.ledgerPath,
    repoId: generation.metadata.repoId,
    generation: generation.metadata.ledgerGeneration,
  });
  try {
    const events = makeTaskEventReader({ rootDir: generation.rootDir, repoId: generation.metadata.repoId });
    const projection = makeTaskProjection({
      rootDir: generation.rootDir,
      projectionPath: generation.projectionPath,
      eventStore: events,
    });
    return {
      position: store.position,
      apply: store.apply,
      project: async (_position: ReplicationPosition) => {
        projection.catchUp!();
      },
      close: async () => {
        projection.close();
        await events.drain();
        store.close();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

export interface ReplicationTarget {
  readonly position: () => ReplicationPosition | null;
  readonly install: (archive: string, metadata: BaseBackupMetadata, size: number, sha256: string) => Promise<void>;
  readonly apply: (commit: ReplicationCommit, blobs: readonly CanonicalContentBlob[]) => void;
  /** Runs the common projection catchUp; resolves only once that position is queryable. */
  readonly project: (position: ReplicationPosition) => Promise<void>;
  readonly updatePosition?: (position: ReplicationPosition) => void;
  readonly reset?: () => Promise<void>;
}

async function receiveBytes(
  peer: ReplicationPeer,
  size: number,
  signal: AbortSignal,
  write: (bytes: Buffer) => Promise<void>,
): Promise<void> {
  let offset = 0;
  while (offset < size) {
    const frame = await peer.receive(signal);
    if (frame.type !== "replica.data" || frame.offset !== offset) throw new Error("replication byte offset differs");
    const bytes = Buffer.from(frame.data, "base64");
    if (bytes.length === 0 || offset + bytes.length > size) throw new Error("replication byte length differs");
    await write(bytes);
    offset += bytes.length;
  }
}

export async function runWalReceiver(input: {
  readonly peer: ReplicationPeer;
  readonly repoId: string;
  readonly target: ReplicationTarget;
  readonly directory: string;
  readonly quotaBytes: number;
  readonly maxBufferedBytes: number;
  readonly signal: AbortSignal;
  readonly stopAfterAck?: (position: ReplicationPosition) => boolean;
}): Promise<void> {
  const { peer, target, signal } = input;
  await peer.send({ type: "replica.start", repoId: input.repoId, position: target.position() });
  const ack = async (position: ReplicationPosition) => {
    await target.project(position);
    await peer.send({ type: "replica.ack", durable: position, applied: position });
  };
  const expect = async (type: "replica.backup.end" | "replica.commit.end" | "replica.object.end") => {
    if ((await peer.receive(signal)).type !== type) throw new Error(`expected ${type}`);
  };
  for (;;) {
    signal.throwIfAborted();
    const frame = await peer.receive(signal);
    if (frame.type === "replica.resync") {
      await target.reset?.();
      continue;
    }
    if (frame.type === "replica.backup") {
      if (frame.size > input.quotaBytes) throw new Error("base backup exceeds disk quota");
      await mkdir(input.directory, { recursive: true });
      const file = path.join(input.directory, `${randomUUID()}.tar.gz`);
      const handle = await open(file, "wx");
      try {
        try {
          await receiveBytes(peer, frame.size, signal, async (bytes) => {
            await handle.writeFile(bytes);
          });
          await expect("replica.backup.end");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await target.install(file, frame.metadata, frame.size, frame.sha256);
        await ack(frame.metadata.position);
        if (input.stopAfterAck?.(frame.metadata.position)) return;
      } finally {
        await rm(file, { force: true });
      }
    } else if (frame.type === "replica.commit") {
      if (frame.size > input.maxBufferedBytes) throw new Error("replication commit exceeds memory capacity");
      const chunks: Buffer[] = [];
      await receiveBytes(peer, frame.size, signal, async (bytes) => {
        chunks.push(bytes);
      });
      const commit = parseReplicationCommit(Buffer.concat(chunks));
      const blobs: CanonicalContentBlob[] = [];
      let buffered = frame.size;
      for (;;) {
        const object = await peer.receive(signal);
        if (object.type === "replica.commit.end") break;
        if (object.type !== "replica.object") throw new Error("expected replication content object");
        buffered += object.size;
        if (buffered > input.maxBufferedBytes) throw new Error("replication commit exceeds memory capacity");
        const content: Buffer[] = [];
        await receiveBytes(peer, object.size, signal, async (bytes) => {
          content.push(bytes);
        });
        await expect("replica.object.end");
        blobs.push({
          sha256: object.sha256,
          size: object.size,
          mediaType: "application/octet-stream",
          body: Buffer.concat(content),
        });
      }
      target.apply(commit, blobs);
      await target.project(commit.position);
      target.updatePosition?.(commit.position);
    } else if (frame.type === "replica.progress") {
      const position = target.position();
      if (
        position === null ||
        position.history !== frame.head.history ||
        position.sequence !== frame.head.sequence ||
        position.revision !== frame.head.revision
      )
        throw new Error("replication progress differs from durable position");
      await ack(position);
      if (input.stopAfterAck?.(position)) return;
    } else throw new Error("unexpected replication stream frame");
  }
}
