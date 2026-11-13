import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  openReplicaProjection,
  openReplicaStore,
  type ReplicationCommit,
  type ReplicationPosition,
  type SqliteEventRow,
} from "@harness-anything/storage";
import { TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel";
import { openReplicationCommitFile } from "./commit-file.ts";
import { daemonBuildStamp } from "../build-identity.ts";
import { ReplicationError, type ReplicationPeer } from "./protocol.ts";
import type { BaseBackupMetadata } from "@harness-anything/storage";
import type { ReplicaGeneration } from "./replica-generation.ts";
import { syncDirectory } from "@harness-anything/storage";

/** The receiver owns the only mutable ledger handle; projection application is the center's implementation. */
export function openWalReceiverGeneration(generation: ReplicaGeneration) {
  const store = openReplicaStore({
    databasePath: generation.ledgerPath,
    repoId: generation.metadata.repoId,
    generation: generation.metadata.ledgerGeneration,
  });
  try {
    const model = openReplicaProjection({
        ...generation,
        repoId: generation.metadata.repoId,
        generation: generation.metadata.ledgerGeneration,
      }),
      projection = model.projection;
    const objectRoot = path.join(path.dirname(generation.ledgerPath), "objects", "sha256");
    return {
      position: store.position,
      apply: (commit: ReplicationCommit<Iterable<SqliteEventRow>>) => store.apply(commit, []),
      /** Content-addressed and immutable: a verified object is published ahead of the commit claiming it. */
      installObject: async (sha256: string, file: string) => {
        const target = path.join(objectRoot, sha256.slice(0, 2), sha256.slice(2));
        await /* @gate-identity state-store/task.replica-wal-objects */ mkdir(path.dirname(target), {
          recursive: true,
        });
        await /* @gate-identity state-store/task.replica-wal-objects */ rename(file, target);
        syncDirectory(path.dirname(target));
      },
      project: async (_position: ReplicationPosition) => {
        await projection.catchUpAsync!();
      },
      close: async () => {
        model.close();
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
  readonly apply: (commit: ReplicationCommit<Iterable<SqliteEventRow>>) => void;
  readonly installObject: (sha256: string, file: string) => Promise<void>;
  /** Runs the common projection catchUp; resolves only once that position is queryable. */
  readonly project: (position: ReplicationPosition) => Promise<void>;
  readonly updatePosition?: (position: ReplicationPosition) => void;
  readonly changedPaths?: (paths: readonly string[]) => void;
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
    if (frame.type !== "replica.data" || frame.offset !== offset)
      throw new ReplicationError("replication byte offset differs", "replica_protocol_error");
    const bytes = Buffer.from(frame.data, "base64");
    if (bytes.length === 0 || offset + bytes.length > size)
      throw new ReplicationError("replication byte length differs", "replica_protocol_error");
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
  /** Bounds parser scratch space; events stream to a replayable staging file. */
  readonly maxBufferedBytes: number;
  readonly signal: AbortSignal;
}): Promise<void> {
  let frameSize: number | null = null;
  const { peer, target, signal } = input;
  const contextualize = (error: unknown): Error => {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!failure.message.includes("; replica="))
      failure.message += `; replica=${JSON.stringify({ repoId: input.repoId, size: frameSize, position: target.position() })}`;
    return failure;
  };
  try {
    await peer.send({
      type: "replica.start",
      repoId: input.repoId,
      position: target.position(),
      edgeBuildCommit: daemonBuildStamp().commit,
      taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
    });
    const rejectUnauthorizedRead = async (): Promise<never> => {
      await target.reset?.();
      await target.revoke?.();
      throw new ReplicationError(
        "authorization_denied: The node owner may not read this repository.",
        "authorization_denied",
      );
    };
    const handshake = await peer.receive(signal);
    if (handshake.type === "replica.reject")
      throw Object.assign(new Error(handshake.message), { code: handshake.code });
    if (handshake.type === "replica.resync" && handshake.reason === "authorization_denied")
      await rejectUnauthorizedRead();
    if (handshake.type !== "replica.accept")
      throw new ReplicationError("replication handshake acceptance required", "replica_protocol_error");
    if (handshake.taskEventShapeVersion > TASK_EVENT_SHAPE_COMPAT_VERSION)
      throw Object.assign(
        new Error(`Center requires task event shape ${handshake.taskEventShapeVersion}; upgrade this edge.`),
        { code: "edge_upgrade_required" },
      );
    const reportFailure = async (error: unknown): Promise<void> => {
      const failure = contextualize(error) as Error & { code?: unknown };
      if (typeof failure.code !== "string") failure.code = "replica_apply_failed";
      const code = String(failure.code),
        message = failure.message.slice(0, 512);
      await peer.send({ type: "replica.failure", code, message });
      // The sender may still be writing the rest of its bounded page. Drain without applying until
      // it reads this failure and closes the session, so the report is not lost behind that page.
      for (;;) {
        try {
          await peer.receive(signal);
        } catch (drainError) {
          if (signal.aborted) throw drainError;
          throw failure;
        }
      }
    };
    const ack = async (position: ReplicationPosition) => {
      try {
        await target.project(position);
      } catch (error) {
        await reportFailure(error);
        throw error;
      }
      await peer.send({ type: "replica.ack", durable: position, applied: position });
    };
    const expect = async (type: "replica.backup.end" | "replica.commit.end" | "replica.object.end") => {
      if ((await peer.receive(signal)).type !== type)
        throw new ReplicationError(`expected ${type}`, "replica_protocol_error");
    };
    for (;;) {
      signal.throwIfAborted();
      const frame = await peer.receive(signal);
      if (frame.type === "replica.commit" || frame.type === "replica.backup") frameSize = frame.size;
      if (frame.type === "replica.resync") {
        // A denied replica is withdrawn and the stream fails: the owner and doctor see the denial, and
        // the reconnect loop re-admits the replica once the grant returns.
        if (frame.reason === "authorization_denied") await rejectUnauthorizedRead();
        await target.reset?.();
        continue;
      }
      if (frame.type === "replica.backup") {
        if (frame.size > input.quotaBytes)
          throw new ReplicationError("base backup exceeds disk quota", "replica_quota_exceeded");
        await /* @gate-identity non-state/environment-io.4f62e1d5a38603ae */ mkdir(input.directory, {
          recursive: true,
        });
        const file = path.join(input.directory, `${randomUUID()}.tar.gz`);
        const handle = await /* @gate-identity non-state/environment-io.86c097b43a2b67a1 */ open(file, "wx");
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
          await /* @gate-identity non-state/environment-io.4d1cb7398be78de6 */ rm(file, { force: true });
        }
      } else if (frame.type === "replica.commit") {
        if (frame.size > input.quotaBytes)
          throw new ReplicationError("replication commit exceeds disk quota", "replica_quota_exceeded");
        const envelopeFile = path.join(input.directory, `${randomUUID()}.commit`);
        const stagedCommit = openReplicationCommitFile(envelopeFile, Math.min(input.maxBufferedBytes, 64 * 1024));
        try {
          await receiveBytes(peer, frame.size, signal, async (bytes) => stagedCommit.write(bytes));
          const commit = stagedCommit.finish();
          let staged = frame.size;
          for (;;) {
            const object = await peer.receive(signal);
            if (object.type === "replica.commit.end") break;
            if (object.type !== "replica.object")
              throw new ReplicationError("expected replication content object", "replica_protocol_error");
            staged += object.size;
            if (staged > input.quotaBytes)
              throw new ReplicationError("replication commit exceeds disk quota", "replica_quota_exceeded");
            await /* @gate-identity non-state/environment-io.b3f141dd21d8d0b1 */ mkdir(input.directory, {
              recursive: true,
            });
            const file = path.join(input.directory, `${randomUUID()}.object`),
              handle = await /* @gate-identity non-state/environment-io.cf6e8fcf123657de */ open(file, "wx"),
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
              if (digest.digest("hex") !== object.sha256)
                throw new ReplicationError("replication content object digest differs", "replica_protocol_error");
              await target.installObject(object.sha256, file);
            } finally {
              await /* @gate-identity non-state/environment-io.5eeaceccac6eef1d */ rm(file, { force: true });
            }
          }
          try {
            target.apply({
              ...commit,
              events: (function* () {
                try {
                  yield* commit.events;
                } finally {
                  // Iteration ends inside the accepting SQLite transaction, before COMMIT exposes
                  // its revision to another process. The outer finally covers unconsumed commits.
                  stagedCommit.close();
                }
              })(),
            });
            // Replayed prefixes may return without consuming events.
            stagedCommit.close();
          } catch (error) {
            await reportFailure(error);
            throw error;
          }
          try {
            await target.project(commit.position);
          } catch (error) {
            await reportFailure(error);
            throw error;
          }
          target.changedPaths?.(stagedCommit.changedPaths());
          target.updatePosition?.(commit.position);
        } finally {
          stagedCommit.close();
        }
      } else if (frame.type === "replica.progress") {
        const position = target.position();
        if (
          position === null ||
          position.history !== frame.head.history ||
          position.sequence !== frame.head.sequence ||
          position.revision !== frame.head.revision
        )
          throw new ReplicationError("replication progress differs from durable position", "replica_protocol_error");
        target.updatePosition?.(position);
        await ack(position);
      } else throw new ReplicationError("unexpected replication stream frame", "replica_protocol_error");
    }
  } catch (error) {
    if (signal.aborted) throw error;
    const failure = error instanceof Error ? error : new Error(String(error));
    contextualize(failure);
    throw failure;
  }
}
