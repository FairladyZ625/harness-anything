import { copyFile, link, mkdir, open, readdir, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  BASE_BACKUP_ARCHIVE_ROOT,
  openReplicaProjection,
  openReplicaStore,
  type ReplicationCommit,
  type ReplicationPosition,
  type SqliteEventRow,
} from "@harness-anything/storage";
import { consumeKnownError, TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel";
import { openReplicationCommitFile } from "../../fleet-sync/fleet/commit-file.ts";
import { daemonBuildStamp } from "../build-identity.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { recordReplicaHealth, type ReplicaSyncProgress } from "../../fleet-sync/fleet/replica-health.ts";
import { hostEnvironmentFilePath, writeHostEnvironmentFile } from "../host-environment-io.ts";
import {
  isBaseBackupMetadata,
  ReplicationError,
  SNAPSHOT_BINARY_WIRE_CAPABILITY,
  SNAPSHOT_OBJECT_PACK_CAPABILITY,
  SNAPSHOT_RESUME_CAPABILITY,
  type ReplicationPeer,
} from "../../fleet-sync/fleet/protocol.ts";
import type { BaseBackupMetadata } from "@harness-anything/storage";
import type { ReplicaGeneration } from "../../fleet-sync/fleet/replica-generation.ts";
import { syncDirectory } from "@harness-anything/storage";
import { REPOINT_RESUME_ONLY } from "./repoint-lineage.ts";

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
  readonly install: (
    archive: string,
    metadata: BaseBackupMetadata,
    size: number,
    sha256: string,
    options?: { readonly stagedObjectsDir?: string },
  ) => Promise<void>;
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

const SNAPSHOT_TRANSFER_FLUSH_BYTES = 4 * 1024 * 1024;

interface StagedSnapshotTransfer {
  readonly schema: "fleet-snapshot-transfer/v1";
  readonly snapshotId: string;
  readonly metadata: BaseBackupMetadata;
  readonly size: number;
  readonly sha256: string;
  readonly receivedBytes: number;
}

async function findResumableSnapshot(snapshotsRoot: string): Promise<{
  readonly snapshotId: string;
  readonly offset: number;
  readonly transfer: StagedSnapshotTransfer;
} | null> {
  let entries;
  try {
    entries = await readdir(snapshotsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      consumeKnownError(error);
      return null;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const snapshotDir = path.join(snapshotsRoot, entry.name);
    try {
      const raw = await readFile(hostEnvironmentFilePath("fleetSnapshotTransfer", snapshotDir), "utf8");
      const parsed = JSON.parse(raw) as Partial<StagedSnapshotTransfer>;
      if (
        parsed.schema !== "fleet-snapshot-transfer/v1" ||
        parsed.snapshotId !== entry.name ||
        !isBaseBackupMetadata(parsed.metadata) ||
        !Number.isSafeInteger(parsed.size) ||
        (parsed.size ?? 0) <= 0 ||
        typeof parsed.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(parsed.sha256) ||
        !Number.isSafeInteger(parsed.receivedBytes) ||
        (parsed.receivedBytes ?? -1) < 0 ||
        (parsed.receivedBytes ?? 0) > parsed.size!
      )
        continue;
      const partStat = await stat(path.join(snapshotDir, "archive.part"));
      const offset = Math.min(partStat.size, parsed.receivedBytes!);
      if (offset > 0 && offset <= parsed.size!) {
        return {
          snapshotId: parsed.snapshotId,
          offset,
          transfer: parsed as StagedSnapshotTransfer,
        };
      }
    } catch (error) {
      consumeKnownError(error);
      continue;
    }
  }
  return null;
}

async function clearStagedSnapshots(snapshotsRoot: string): Promise<void> {
  await /* @gate-identity non-state/environment-io.9c3e1a4d6f8b0234 */ rm(snapshotsRoot, {
    recursive: true,
    force: true,
  });
}

async function receiveBytes(
  peer: ReplicationPeer,
  size: number,
  signal: AbortSignal,
  write: (bytes: Buffer) => Promise<void>,
  initialOffset = 0,
): Promise<void> {
  let offset = initialOffset;
  while (offset < size) {
    const frame = await peer.receive(signal);
    if ((frame.type !== "replica.data" && frame.type !== "replica.data.bin") || frame.offset !== offset)
      throw new ReplicationError("replication byte offset differs", "replica_protocol_error");
    const bytes =
      frame.type === "replica.data.bin"
        ? Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)
        : Buffer.from(frame.data, "base64");
    if (bytes.length === 0 || offset + bytes.length > size)
      throw new ReplicationError("replication byte length differs", "replica_protocol_error");
    await write(bytes);
    offset += bytes.length;
  }
}

function findExistingObjectPaths(viewRoot: string): readonly string[] {
  const generationsDir = path.join(viewRoot, "generations");
  if (!existsSync(generationsDir)) return [];
  const roots: string[] = [];
  for (const genEntry of readdirSync(generationsDir, { withFileTypes: true })) {
    if (!genEntry.isDirectory()) continue;
    const storeGensDir = path.join(generationsDir, genEntry.name, BASE_BACKUP_ARCHIVE_ROOT, "store", "generations");
    if (!existsSync(storeGensDir)) continue;
    for (const ledgerGenEntry of readdirSync(storeGensDir, { withFileTypes: true })) {
      if (!ledgerGenEntry.isDirectory()) continue;
      const objectsDir = path.join(storeGensDir, ledgerGenEntry.name, "objects", "sha256");
      if (existsSync(objectsDir)) roots.push(objectsDir);
    }
  }
  return roots;
}

async function tryReuseExistingObject(
  stagedObjectsDir: string,
  existingRoots: readonly string[],
  sha256: string,
  expectedSize: number,
): Promise<boolean> {
  const prefix = sha256.slice(0, 2);
  const rest = sha256.slice(2);
  const stagedTarget = path.join(stagedObjectsDir, prefix, rest);
  if (existsSync(stagedTarget)) {
    const existing = statSync(stagedTarget);
    if (existing.isFile() && existing.size === expectedSize) return true;
  }
  for (const root of existingRoots) {
    const candidate = path.join(root, prefix, rest);
    if (!existsSync(candidate)) continue;
    const candidateStat = statSync(candidate);
    if (!candidateStat.isFile() || candidateStat.size !== expectedSize) continue;
    await /* @gate-identity non-state/environment-io.1a2b3c4d5e6f7081 */ mkdir(path.dirname(stagedTarget), {
      recursive: true,
    });
    try {
      await /* @gate-identity non-state/environment-io.2b3c4d5e6f708192 */ link(candidate, stagedTarget);
    } catch (error) {
      consumeKnownError(error);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return true;
      await /* @gate-identity non-state/environment-io.3c4d5e6f708192a3 */ copyFile(candidate, stagedTarget);
    }
    return true;
  }
  return false;
}

async function receivePackStream(input: {
  readonly peer: ReplicationPeer;
  readonly totalBytes: number;
  readonly expectedCount: number;
  readonly wantedSizes: ReadonlyMap<string, number>;
  readonly stagedObjectsDir: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (deltaBytes: number, objectsReceived: number) => void;
}): Promise<number> {
  const { peer, totalBytes, expectedCount, wantedSizes, stagedObjectsDir, signal, onProgress } = input;
  const headerBuf = Buffer.allocUnsafe(72);
  let headerBytes = 0;
  let currentSha = "";
  let currentRemaining = 0;
  let currentHandle: FileHandle | null = null;
  let currentTmpPath = "";
  let currentDigest = createHash("sha256");
  let objectsReceived = 0;

  const finalizeCurrentObject = async () => {
    const handle = currentHandle;
    if (!handle) return;
    const tmpPath = currentTmpPath;
    const sha = currentSha;
    const digest = currentDigest;
    currentHandle = null;
    currentTmpPath = "";
    // Object bytes are validated before publication and the install worker owns the
    // generation-level durability fence. A per-object fsync here turns a large pack into
    // hundreds of thousands of synchronous metadata operations.
    await handle.close();
    if (digest.digest("hex") !== sha) {
      await /* @gate-identity non-state/environment-io.0e61dbc95383ec54 */ rm(tmpPath, { force: true });
      throw new ReplicationError("replication pack object digest differs", "replica_protocol_error");
    }
    const targetPath = path.join(stagedObjectsDir, sha.slice(0, 2), sha.slice(2));
    await /* @gate-identity non-state/environment-io.05c64932e0127603 */ rename(tmpPath, targetPath);
    objectsReceived += 1;
  };

  try {
    await receiveBytes(peer, totalBytes, signal, async (bytes) => {
      let cursor = 0;
      while (cursor < bytes.length) {
        if (currentHandle === null) {
          const needHeader = 72 - headerBytes;
          const take = Math.min(needHeader, bytes.length - cursor);
          bytes.copy(headerBuf, headerBytes, cursor, cursor + take);
          headerBytes += take;
          cursor += take;
          if (headerBytes < 72) continue;
          headerBytes = 0;
          currentSha = headerBuf.toString("ascii", 0, 64);
          const expectedSize = wantedSizes.get(currentSha);
          const declaredSizeBig = headerBuf.readBigUInt64BE(64);
          if (
            expectedSize === undefined ||
            declaredSizeBig > BigInt(Number.MAX_SAFE_INTEGER) ||
            Number(declaredSizeBig) !== expectedSize
          ) {
            throw new ReplicationError("replication pack object header mismatch", "replica_protocol_error");
          }
          currentRemaining = expectedSize;
          const targetDir = path.join(stagedObjectsDir, currentSha.slice(0, 2));
          await /* @gate-identity non-state/environment-io.6f708192a3b4c5d6 */ mkdir(targetDir, {
            recursive: true,
          });
          currentTmpPath = path.join(targetDir, `${currentSha.slice(2)}.tmp-${randomUUID()}`);
          currentHandle = await /* @gate-identity non-state/environment-io.708192a3b4c5d6e7 */ open(
            currentTmpPath,
            "wx",
          );
          currentDigest = createHash("sha256");
          if (currentRemaining === 0) {
            await finalizeCurrentObject();
          }
        } else {
          const take = Math.min(currentRemaining, bytes.length - cursor);
          const slice = bytes.subarray(cursor, cursor + take);
          currentDigest.update(slice);
          await currentHandle.writeFile(slice);
          currentRemaining -= take;
          cursor += take;
          if (currentRemaining === 0) {
            await finalizeCurrentObject();
          }
        }
      }
      onProgress?.(bytes.length, objectsReceived);
    });
  } catch (error) {
    const openHandle = currentHandle as FileHandle | null;
    if (openHandle) {
      await openHandle.close().catch(() => undefined);
    }
    if (currentTmpPath) {
      await /* @gate-identity non-state/environment-io.4d5e6f708192a3b4 */ rm(currentTmpPath, { force: true }).catch(
        () => undefined,
      );
    }
    throw error;
  }
  if (headerBytes !== 0 || currentRemaining !== 0 || objectsReceived !== expectedCount) {
    throw new ReplicationError("replication pack truncated", "replica_protocol_error");
  }
  return objectsReceived;
}

export async function runWalReceiver(input: {
  readonly peer: ReplicationPeer;
  readonly resumeOnly?: boolean;
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
  const healthViewDir = path.basename(input.directory) === "staging" ? path.dirname(input.directory) : null;
  let lastProgressFlushAtMs = 0;
  let lastProgressFlushBytes = 0;
  const publishSyncProgress = (progress: Omit<ReplicaSyncProgress, "updatedAt"> | null, force = false): void => {
    if (!healthViewDir) return;
    if (progress === null) {
      lastProgressFlushAtMs = 0;
      lastProgressFlushBytes = 0;
      recordReplicaHealth(healthViewDir, { syncProgress: null });
      return;
    }
    const nowMs = Date.now();
    const byteAdvance = Math.abs(progress.receivedBytes - lastProgressFlushBytes);
    const flushIntervalMs = storageReadPolicy.defaultValue.backoff.followerMaximum;
    if (!force && byteAdvance < SNAPSHOT_TRANSFER_FLUSH_BYTES && nowMs - lastProgressFlushAtMs < flushIntervalMs) {
      return;
    }
    lastProgressFlushAtMs = nowMs;
    lastProgressFlushBytes = progress.receivedBytes;
    const updatedAt = new Date(nowMs).toISOString();
    recordReplicaHealth(healthViewDir, {
      syncProgress: { ...progress, updatedAt },
      syncFailure: null,
      lastHeartbeatAt: updatedAt,
    });
  };
  const contextualize = (error: unknown): Error => {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!failure.message.includes("; replica="))
      failure.message += `; replica=${JSON.stringify({ repoId: input.repoId, size: frameSize, position: target.position() })}`;
    return failure;
  };
  try {
    const snapshotsRoot = path.join(input.directory, "snapshots");
    const initialPosition = target.position();
    if (input.resumeOnly && initialPosition === null)
      throw new ReplicationError("Repoint requires an existing replica position.", "replication_resume_unavailable");
    const stagedResume = initialPosition === null ? await findResumableSnapshot(snapshotsRoot) : null;
    await peer.send({
      type: "replica.start",
      repoId: input.repoId,
      position: initialPosition,
      edgeBuildCommit: daemonBuildStamp().commit,
      taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
      capabilities: [
        SNAPSHOT_RESUME_CAPABILITY,
        SNAPSHOT_BINARY_WIRE_CAPABILITY,
        SNAPSHOT_OBJECT_PACK_CAPABILITY,
        ...(input.resumeOnly ? [REPOINT_RESUME_ONLY] : []),
      ],
      ...(stagedResume ? { resumeSnapshot: { snapshotId: stagedResume.snapshotId, offset: stagedResume.offset } } : {}),
    });
    const rejectUnauthorizedRead = async (): Promise<never> => {
      await clearStagedSnapshots(snapshotsRoot);
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
    if (handshake.type === "replica.resync" && handshake.reason === "authorization_denied") {
      if (!input.resumeOnly) await rejectUnauthorizedRead();
      throw new ReplicationError(
        "authorization_denied: The replacement center denied repository-read for this node.",
        "authorization_denied",
      );
    }
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
    const expect = async (
      type: "replica.backup.end" | "replica.commit.end" | "replica.object.end" | "replica.objects.pack.end",
    ) => {
      if ((await peer.receive(signal)).type !== type)
        throw new ReplicationError(`expected ${type}`, "replica_protocol_error");
    };
    const receiveSplitObjects = async (stagedObjectsDir: string) => {
      await /* @gate-identity non-state/environment-io.8192a3b4c5d6e7f8 */ mkdir(stagedObjectsDir, {
        recursive: true,
      });
      const existingRoots = findExistingObjectPaths(path.dirname(input.directory));
      let cumulativeObjectsReceived = 0;
      let cumulativeObjectsTarget = 0;
      let cumulativeBytesReceived = 0;
      let cumulativeBytesTarget = 0;
      for (;;) {
        const manifest = await peer.receive(signal);
        if (manifest.type !== "replica.objects.manifest")
          throw new ReplicationError("expected replica.objects.manifest", "replica_protocol_error");
        const wantedSizes = new Map<string, number>();
        const wantSha256s: string[] = [];
        for (const entry of manifest.entries) {
          const have = await tryReuseExistingObject(stagedObjectsDir, existingRoots, entry.sha256, entry.size);
          if (!have) {
            wantedSizes.set(entry.sha256, entry.size);
            wantSha256s.push(entry.sha256);
            cumulativeBytesTarget += entry.size + 72;
          }
        }
        cumulativeObjectsTarget += wantSha256s.length;
        publishSyncProgress(
          {
            step: "objects",
            receivedBytes: cumulativeBytesReceived,
            totalBytes: cumulativeBytesTarget > 0 ? cumulativeBytesTarget : null,
            receivedObjects: cumulativeObjectsReceived,
            totalObjects: cumulativeObjectsTarget,
          },
          true,
        );
        await peer.send({ type: "replica.objects.want", sha256s: wantSha256s });
        let receivedForBatch = 0;
        while (receivedForBatch < wantSha256s.length) {
          const pack = await peer.receive(signal);
          if (pack.type !== "replica.objects.pack")
            throw new ReplicationError("expected replica.objects.pack", "replica_protocol_error");
          if (pack.totalBytes > input.quotaBytes)
            throw new ReplicationError("replication object pack exceeds disk quota", "replica_quota_exceeded");
          const baseObjectsBeforePack = cumulativeObjectsReceived;
          receivedForBatch += await receivePackStream({
            peer,
            totalBytes: pack.totalBytes,
            expectedCount: pack.count,
            wantedSizes,
            stagedObjectsDir,
            signal,
            onProgress: (deltaBytes, packObjectsDone) => {
              cumulativeBytesReceived = Math.min(
                Math.max(cumulativeBytesTarget, cumulativeBytesReceived + deltaBytes),
                cumulativeBytesReceived + deltaBytes,
              );
              publishSyncProgress({
                step: "objects",
                receivedBytes: cumulativeBytesReceived,
                totalBytes: Math.max(cumulativeBytesTarget, cumulativeBytesReceived),
                receivedObjects: baseObjectsBeforePack + packObjectsDone,
                totalObjects: cumulativeObjectsTarget,
              });
            },
          });
          cumulativeObjectsReceived = baseObjectsBeforePack + pack.count;
          publishSyncProgress(
            {
              step: "objects",
              receivedBytes: cumulativeBytesReceived,
              totalBytes: Math.max(cumulativeBytesTarget, cumulativeBytesReceived),
              receivedObjects: cumulativeObjectsReceived,
              totalObjects: cumulativeObjectsTarget,
            },
            true,
          );
          await expect("replica.objects.pack.end");
        }
        if (manifest.done) break;
      }
    };
    for (;;) {
      signal.throwIfAborted();
      const frame = await peer.receive(signal);
      if (frame.type === "replica.failure") throw new ReplicationError(frame.message, frame.code);
      if (input.resumeOnly && (frame.type === "replica.backup" || frame.type === "replica.resync"))
        throw new ReplicationError("Repoint requires incremental replication.", "replication_resume_unavailable");
      if (frame.type === "replica.commit" || frame.type === "replica.backup") frameSize = frame.size;
      if (frame.type === "replica.resync") {
        // A denied replica is withdrawn and the stream fails: the owner and doctor see the denial, and
        // the reconnect loop re-admits the replica once the grant returns.
        if (frame.reason === "authorization_denied") await rejectUnauthorizedRead();
        await clearStagedSnapshots(snapshotsRoot);
        await target.reset?.();
        continue;
      }
      if (frame.type === "replica.backup") {
        if (frame.size > input.quotaBytes)
          throw new ReplicationError("base backup exceeds disk quota", "replica_quota_exceeded");
        if (frame.snapshotId) {
          const snapshotDir = path.join(snapshotsRoot, frame.snapshotId);
          const partFile = path.join(snapshotDir, "archive.part");
          const resumeOffset = frame.resumeOffset ?? 0;
          if (resumeOffset > 0) {
            const currentStaged =
              stagedResume?.snapshotId === frame.snapshotId ? stagedResume : await findResumableSnapshot(snapshotsRoot);
            if (
              !currentStaged ||
              currentStaged.snapshotId !== frame.snapshotId ||
              currentStaged.transfer.size !== frame.size ||
              currentStaged.transfer.sha256 !== frame.sha256 ||
              resumeOffset > currentStaged.offset
            ) {
              await clearStagedSnapshots(snapshotsRoot);
              throw new ReplicationError("resumed snapshot metadata mismatch", "replica_protocol_error");
            }
          } else {
            await clearStagedSnapshots(snapshotsRoot);
            await /* @gate-identity non-state/environment-io.ad4f2b5e7c9d1345 */ mkdir(snapshotDir, {
              recursive: true,
            });
          }
          const transferBase: Omit<StagedSnapshotTransfer, "receivedBytes"> = {
            schema: "fleet-snapshot-transfer/v1",
            snapshotId: frame.snapshotId,
            metadata: frame.metadata,
            size: frame.size,
            sha256: frame.sha256,
          };
          let receivedBytes = resumeOffset;
          let lastFlushedBytes = resumeOffset;
          publishSyncProgress({ step: "basebackup", receivedBytes: resumeOffset, totalBytes: frame.size }, true);
          const writeTransferState = (receivedBytes: number) =>
            writeHostEnvironmentFile(
              "fleetSnapshotTransfer",
              snapshotDir,
              JSON.stringify({ ...transferBase, receivedBytes }),
            );
          if (resumeOffset === 0) {
            await writeTransferState(0);
          }
          if (resumeOffset > 0) {
            const truncateHandle = await /* @gate-identity non-state/environment-io.be503c6f8dae2456 */ open(
              partFile,
              "r+",
            );
            try {
              await truncateHandle.truncate(resumeOffset);
            } finally {
              await truncateHandle.close();
            }
          }
          const handle = await /* @gate-identity non-state/environment-io.cf614d7e9fbf3567 */ open(
            partFile,
            resumeOffset > 0 ? "a" : "w+",
          );
          try {
            await receiveBytes(
              peer,
              frame.size,
              signal,
              async (bytes) => {
                await handle.writeFile(bytes);
                receivedBytes += bytes.length;
                publishSyncProgress({ step: "basebackup", receivedBytes, totalBytes: frame.size });
                if (receivedBytes - lastFlushedBytes >= SNAPSHOT_TRANSFER_FLUSH_BYTES) {
                  await writeTransferState(receivedBytes);
                  lastFlushedBytes = receivedBytes;
                }
              },
              resumeOffset,
            );
            await expect("replica.backup.end");
            await handle.sync();
            publishSyncProgress({ step: "basebackup", receivedBytes: frame.size, totalBytes: frame.size }, true);
          } finally {
            if (receivedBytes !== lastFlushedBytes) {
              await writeTransferState(receivedBytes).catch(() => undefined);
            }
            await handle.close();
          }
          let stagedObjectsDir: string | undefined;
          if (frame.objectsMode === "pack") {
            stagedObjectsDir = path.join(snapshotDir, "objects");
            await receiveSplitObjects(stagedObjectsDir);
          }
          try {
            publishSyncProgress({ step: "installing", receivedBytes: frame.size, totalBytes: frame.size }, true);
            await target.install(
              partFile,
              frame.metadata,
              frame.size,
              frame.sha256,
              stagedObjectsDir ? { stagedObjectsDir } : undefined,
            );
            // The install worker has verified the archive and durably published the generation.
            // Clear resumable bytes before waiting for the edge ACK to release peak disk space.
            await clearStagedSnapshots(snapshotsRoot);
          } catch (error) {
            publishSyncProgress(null, true);
            await clearStagedSnapshots(snapshotsRoot);
            throw error;
          }
          publishSyncProgress({ step: "projecting", receivedBytes: frame.size, totalBytes: frame.size }, true);
          await ack(frame.metadata.position);
          publishSyncProgress(null, true);
        } else {
          await /* @gate-identity non-state/environment-io.4f62e1d5a38603ae */ mkdir(input.directory, {
            recursive: true,
          });
          const file = path.join(input.directory, `${randomUUID()}.tar.gz`);
          const stagedObjectsDir =
            frame.objectsMode === "pack" ? path.join(input.directory, `${randomUUID()}-objects`) : undefined;
          const handle = await /* @gate-identity non-state/environment-io.86c097b43a2b67a1 */ open(file, "wx");
          let streamedBytes = 0;
          publishSyncProgress({ step: "basebackup", receivedBytes: 0, totalBytes: frame.size }, true);
          try {
            try {
              await receiveBytes(peer, frame.size, signal, async (bytes) => {
                await handle.writeFile(bytes);
                streamedBytes += bytes.length;
                publishSyncProgress({ step: "basebackup", receivedBytes: streamedBytes, totalBytes: frame.size });
              });
              await expect("replica.backup.end");
              await handle.sync();
              publishSyncProgress({ step: "basebackup", receivedBytes: frame.size, totalBytes: frame.size }, true);
            } finally {
              await handle.close();
            }
            if (stagedObjectsDir) {
              await receiveSplitObjects(stagedObjectsDir);
            }
            publishSyncProgress({ step: "installing", receivedBytes: frame.size, totalBytes: frame.size }, true);
            await target.install(
              file,
              frame.metadata,
              frame.size,
              frame.sha256,
              stagedObjectsDir ? { stagedObjectsDir } : undefined,
            );
            publishSyncProgress({ step: "projecting", receivedBytes: frame.size, totalBytes: frame.size }, true);
            await ack(frame.metadata.position);
          } finally {
            publishSyncProgress(null, true);
            await /* @gate-identity non-state/environment-io.4d1cb7398be78de6 */ rm(file, { force: true });
            if (stagedObjectsDir) {
              await /* @gate-identity non-state/environment-io.92a3b4c5d6e7f809 */ rm(stagedObjectsDir, {
                recursive: true,
                force: true,
              });
            }
          }
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
