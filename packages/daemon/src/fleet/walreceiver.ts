import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  makeTaskEventReader,
  makeTaskProjection,
  openReplicaStore,
  type ReplicationCommit,
  type ReplicationPosition,
} from "@harness-anything/kernel";
import { parseReplicationCommit, type ReplicationPeer } from "./protocol.ts";
import type { BaseBackupMetadata } from "./basebackup.ts";
import type { ReplicaGeneration } from "./replica-generation.ts";
import { syncDirectory } from "../durable-file.ts";

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
    const objectRoot = path.join(path.dirname(generation.ledgerPath), "objects", "sha256");
    return {
      position: store.position,
      apply: (commit: ReplicationCommit) => store.apply(commit, []),
      /** Content-addressed and immutable: a verified object is published ahead of the commit claiming it. */
      installObject: async (sha256: string, file: string) => {
        const target = path.join(objectRoot, sha256.slice(0, 2), sha256.slice(2));
        await mkdir(path.dirname(target), { recursive: true });
        await rename(file, target);
        syncDirectory(path.dirname(target));
      },
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
  /** Applies a commit whose content objects were already installed through installObject. */
  readonly apply: (commit: ReplicationCommit) => void;
  readonly installObject: (sha256: string, file: string) => Promise<void>;
  /** Runs the common projection catchUp; resolves only once that position is queryable. */
  readonly project: (position: ReplicationPosition) => Promise<void>;
  readonly updatePosition?: (position: ReplicationPosition) => void;
  readonly reset?: () => Promise<void>;
  readonly revoke?: () => Promise<void>;
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
  /** Bounds the in-memory commit envelope; content objects stream to staging files instead. */
  readonly maxBufferedBytes: number;
  readonly signal: AbortSignal;
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
      // A denied replica is withdrawn and the stream fails: the owner and doctor see the denial, and
      // the reconnect loop re-admits the replica once the grant returns.
      if (frame.reason === "authorization_denied") {
        await input.target.revoke?.();
        throw Object.assign(new Error("authorization_denied: The node owner may not read this repository."), {
          code: "authorization_denied",
        });
      }
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
      let staged = 0;
      for (;;) {
        const object = await peer.receive(signal);
        if (object.type === "replica.commit.end") break;
        if (object.type !== "replica.object") throw new Error("expected replication content object");
        staged += object.size;
        if (staged > input.quotaBytes) throw new Error("replication commit exceeds disk quota");
        await mkdir(input.directory, { recursive: true });
        const file = path.join(input.directory, `${randomUUID()}.object`),
          handle = await open(file, "wx"),
          digest = createHash("sha256");
        try {
          try {
            await receiveBytes(peer, object.size, signal, async (bytes) => {
              digest.update(bytes);
              await handle.writeFile(bytes);
            });
            await handle.sync();
          } finally {
            await handle.close();
          }
          await expect("replica.object.end");
          if (digest.digest("hex") !== object.sha256) throw new Error("replication content object digest differs");
          await target.installObject(object.sha256, file);
        } finally {
          await rm(file, { force: true });
        }
      }
      target.apply(commit);
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
      target.updatePosition?.(position);
      await ack(position);
    } else throw new Error("unexpected replication stream frame");
  }
}
