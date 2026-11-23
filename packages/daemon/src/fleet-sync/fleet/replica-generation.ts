import { Worker } from "node:worker_threads";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";
import { syncDirectory, writeFileDurably } from "@harness-anything/storage";
import type { BaseBackupMetadata } from "@harness-anything/storage";
import { BASE_BACKUP_ARCHIVE_ROOT } from "@harness-anything/storage";

export interface ReplicaGeneration {
  readonly id: string;
  readonly rootDir: string;
  readonly ledgerPath: string;
  readonly projectionPath: string;
  readonly metadata: BaseBackupMetadata;
}

export type ReplicaStagingPhase = "unpacking" | "hydrating" | "flushing" | "ready";

export interface ReplicaStagingCheckpoint {
  readonly schema: "fleet-replica-staging/v1";
  readonly sha256: string;
  readonly size: number;
  readonly repoId: string;
  readonly ledgerGeneration: number;
  readonly phase: ReplicaStagingPhase;
  readonly updatedAt: string;
}

export interface ReplicaInstallProgress {
  readonly phase: ReplicaStagingPhase;
  readonly skippedObjects: number;
}

export interface InstallReplicaGenerationInput {
  readonly root: string;
  readonly archive: string;
  readonly metadata: BaseBackupMetadata;
  readonly sha256: string;
  readonly size: number;
  readonly quotaBytes: number;
  readonly stagedObjectsDir?: string;
  readonly onProgress?: (progress: ReplicaInstallProgress) => void;
}

function generation(root: string, id: string, metadata: BaseBackupMetadata): ReplicaGeneration {
  const rootDir = path.join(root, "generations", id);
  return {
    id,
    rootDir,
    metadata,
    ledgerPath: path.join(
      rootDir,
      BASE_BACKUP_ARCHIVE_ROOT,
      "store",
      "generations",
      String(metadata.ledgerGeneration),
      "ledger.sqlite",
    ),
    projectionPath: path.join(rootDir, BASE_BACKUP_ARCHIVE_ROOT, "cache", "task.sqlite"),
  };
}

// The base-backup schema marks a generation pointer; readers judge the rest of its metadata (a missing
// reader profile is an authorization refusal, not an absent replica).
const isGenerationPointer = (value: unknown): value is { id: string; metadata: BaseBackupMetadata } =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { id?: unknown }).id === "string" &&
  /^[A-Za-z0-9-]+$/u.test((value as { id: string }).id) &&
  (value as { metadata?: { schema?: unknown } | null }).metadata?.schema === "fleet-basebackup/v3";

/** A pointer of any other shape (the retired cut/pull replica's current.json) names no generation. */
export function readReplicaGeneration(root: string): ReplicaGeneration | null {
  const pointer = path.join(root, "current.json");
  if (!existsSync(pointer)) return null;
  const current: unknown = JSON.parse(readFileSync(pointer, "utf8"));
  return isGenerationPointer(current) ? generation(root, current.id, current.metadata) : null;
}

// What the retired cut/pull replica kept in a view directory and in its repository directory.
const RETIRED_VIEW_ENTRIES = [
  "cuts",
  ".staging",
  "read-model.sqlite",
  "read-model.sqlite-wal",
  "read-model.sqlite-shm",
  ".replica-pull.lock",
];
const RETIRED_REPOSITORY_ENTRIES = [
  "cas",
  "manifests.sqlite",
  "manifests.sqlite-wal",
  "manifests.sqlite-shm",
  ".mirror-round.lock",
];

/** A denied view stops answering at once; its generation files go with the next collect. */
export function revokeReplicaView(root: string): void {
  const pointer = path.join(root, "current.json");
  if (!existsSync(pointer)) return;
  /* @gate-identity state-store/task.replica-generation */ rmSync(pointer);
  syncDirectory(root);
}

export function updateReplicaGenerationPosition(root: string, position: BaseBackupMetadata["position"]): void {
  const pointer = path.join(root, "current.json");
  if (!existsSync(pointer)) throw new Error("replica generation is unavailable");
  const current = JSON.parse(readFileSync(pointer, "utf8")) as { id: string; metadata: BaseBackupMetadata };
  writeFileDurably(pointer, JSON.stringify({ id: current.id, metadata: { ...current.metadata, position } }));
}

/** The caller has decoded metadata; this verifies bytes and stages the generation off the main thread. */
export async function installReplicaGeneration(
  input: InstallReplicaGenerationInput,
  signal?: AbortSignal,
): Promise<ReplicaGeneration> {
  signal?.throwIfAborted();
  const { onProgress, ...workerInput } = input;
  return new Promise<ReplicaGeneration>((resolve, reject) => {
    const worker = new Worker(
      new URL(`./replica-install-worker${path.extname(import.meta.filename)}`, import.meta.url),
      { workerData: workerInput },
    );
    let settled = false;
    const abort = () => {
      void worker.terminate();
      if (!settled) {
        settled = true;
        reject(signal?.reason instanceof Error ? signal.reason : new Error("replica install aborted"));
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.on(
      "message",
      (
        message:
          | { readonly kind: "progress"; readonly phase: ReplicaStagingPhase; readonly skippedObjects: number }
          | { readonly kind: "complete"; readonly generation: ReplicaGeneration; readonly skippedObjects: number },
      ) => {
        if (message.kind === "progress") {
          onProgress?.({ phase: message.phase, skippedObjects: message.skippedObjects });
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve(message.generation);
      },
    );
    worker.on("error", (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    worker.on("exit", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(new Error(`replica install worker exited before completion (${code})`));
    });
  });
}

/**
 * One pin registry per replica root in this process: the receiver that installs and collects
 * generations and the edge reads that open them share it. A pinned generation outlives a newer
 * install; the last release of a superseded generation collects it.
 */
const generationReaders = new Map<string, ReturnType<typeof createGenerationReaders>>();
export interface BorrowedReplicaGeneration {
  readonly root: string;
  readonly generation: ReplicaGeneration | null;
}
let borrowedGeneration: BorrowedReplicaGeneration | undefined;

/** A query worker borrows the receiver owner's pin for one synchronous query, including nested blob reads. */
export function withBorrowedReplicaGeneration<T>(pin: BorrowedReplicaGeneration | undefined, read: () => T): T {
  const previous = borrowedGeneration;
  borrowedGeneration = pin;
  try {
    return read();
  } finally {
    borrowedGeneration = previous;
  }
}
export function replicaGenerationReaders(root: string) {
  const key = path.resolve(root);
  let readers = generationReaders.get(key);
  if (!readers) generationReaders.set(key, (readers = createGenerationReaders(key)));
  return readers;
}

/** Runs one synchronous read against the current generation (null before the first install) while it is pinned. */
export function withReplicaGeneration<T>(root: string, read: (generation: ReplicaGeneration | null) => T): T {
  if (borrowedGeneration?.root === path.resolve(root)) return read(borrowedGeneration.generation);
  const pin = replicaGenerationReaders(root).acquire();
  try {
    return read(pin?.generation ?? null);
  } finally {
    pin?.release();
  }
}

const STAGING_CHECKPOINT_FILE = "extract.checkpoint.json";
const SHA256_STAGING_DIR_RE = /^([0-9a-f]{64})\.staging$/u;

export function readResumableStagingCheckpoint(stagingDir: string, dirName: string): ReplicaStagingCheckpoint | null {
  const match = SHA256_STAGING_DIR_RE.exec(dirName);
  if (!match) return null;
  const checkpointPath = path.join(stagingDir, STAGING_CHECKPOINT_FILE);
  if (!existsSync(checkpointPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(checkpointPath, "utf8")) as Partial<ReplicaStagingCheckpoint>;
    if (
      parsed.schema !== "fleet-replica-staging/v1" ||
      parsed.sha256 !== match[1] ||
      typeof parsed.size !== "number" ||
      !Number.isFinite(parsed.size) ||
      parsed.size <= 0 ||
      typeof parsed.repoId !== "string" ||
      parsed.repoId.length === 0 ||
      typeof parsed.ledgerGeneration !== "number" ||
      !Number.isInteger(parsed.ledgerGeneration) ||
      (parsed.phase !== "unpacking" &&
        parsed.phase !== "hydrating" &&
        parsed.phase !== "flushing" &&
        parsed.phase !== "ready")
    ) {
      return null;
    }
    return parsed as ReplicaStagingCheckpoint;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

/** Staging directory mutation primitives owned by `task.replica-generation`. */
export async function prepareStagingDirectory(directory: string): Promise<void> {
  await /* @gate-identity state-store/task.replica-generation */ mkdir(directory, { recursive: true });
}

export async function removeStagingDirectory(directory: string): Promise<void> {
  await /* @gate-identity state-store/task.replica-generation */ rm(directory, { recursive: true, force: true });
}

export function installStagedObjects(
  stagedObjectsDir: string,
  targetObjectsDir: string,
  remainingQuotaBytes: number,
): number {
  if (!existsSync(stagedObjectsDir)) return 0;
  let totalBytes = 0;
  for (const prefixEntry of readdirSync(stagedObjectsDir, { withFileTypes: true })) {
    if (!prefixEntry.isDirectory() || !/^[0-9a-f]{2}$/u.test(prefixEntry.name)) continue;
    const srcPrefix = path.join(stagedObjectsDir, prefixEntry.name);
    const dstPrefix = path.join(targetObjectsDir, prefixEntry.name);
    /* @gate-identity state-store/task.replica-generation */ mkdirSync(dstPrefix, { recursive: true });
    for (const objEntry of readdirSync(srcPrefix, { withFileTypes: true })) {
      if (!objEntry.isFile() || !/^[0-9a-f]{62}$/u.test(objEntry.name)) continue;
      const srcFile = path.join(srcPrefix, objEntry.name);
      const dstFile = path.join(dstPrefix, objEntry.name);
      const size = statSync(srcFile).size;
      totalBytes += size;
      if (totalBytes > remainingQuotaBytes) {
        throw new Error("base backup exceeds disk quota");
      }
      if (existsSync(dstFile)) {
        const existing = statSync(dstFile);
        if (existing.isFile() && existing.size === size) continue;
      }
      try {
        /* @gate-identity state-store/task.replica-generation */ renameSync(srcFile, dstFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        consumeKnownError(error);
        /* @gate-identity state-store/task.replica-generation */ copyFileSync(srcFile, dstFile);
      }
    }
  }
  return totalBytes;
}

export function publishStagingGeneration(input: {
  readonly root: string;
  readonly temporary: string;
  readonly checkpointPath: string;
  readonly generationDir: string;
  readonly generationId: string;
  readonly metadata: BaseBackupMetadata;
}): void {
  if (existsSync(input.checkpointPath)) {
    /* @gate-identity state-store/task.replica-generation */ rmSync(input.checkpointPath, { force: true });
  }
  // Publication cannot yield between making the directory collectible and publishing its pointer.
  /* @gate-identity state-store/task.replica-generation */ renameSync(input.temporary, input.generationDir);
  syncDirectory(path.dirname(input.generationDir));
  writeFileDurably(
    path.join(input.root, "current.json"),
    JSON.stringify({ id: input.generationId, metadata: input.metadata }),
  );
}

function createGenerationReaders(root: string) {
  const pins = new Map<string, number>();
  let collection: Promise<void> | null = null;
  const collect = (): Promise<void> => {
    if (collection) return collection;
    collection = (async () => {
      const current = readReplicaGeneration(root),
        directory = path.join(root, "generations");
      if (!existsSync(directory)) return;
      // Rename the old generation out of the live namespace first. The recursive removal then runs
      // asynchronously and cannot hold the daemon event loop while readers continue on the new cut.
      const pending: string[] = [];
      const superseded = readdirSync(directory, { withFileTypes: true }).filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== current?.id &&
          !entry.name.endsWith(".staging") &&
          !entry.name.startsWith(".deleting-") &&
          !pins.get(entry.name),
      );
      for (const entry of superseded) {
        const source = path.join(directory, entry.name);
        const destination = path.join(directory, `.deleting-${entry.name}-${randomUUID()}`);
        try {
          /* @gate-identity state-store/task.replica-generation */ renameSync(source, destination);
          pending.push(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          consumeKnownError(error);
        }
      }
      if (pending.length > 0) syncDirectory(directory);
      await Promise.all(
        pending.map((directoryPath) =>
          removeStagingDirectory(directoryPath),
        ),
      );
    })().finally(() => {
      collection = null;
    });
    return collection;
  };
  /**
   * Removes corrupt/unrecognized staging and retired cut/pull artifacts, while preserving valid
   * resumable `<sha256>.staging` directories across daemon restarts unless `preserveResumable` is false.
   */
  const discardStaging = async (options?: { readonly preserveResumable?: boolean }): Promise<void> => {
    const preserveResumable = options?.preserveResumable !== false;
    const directory = path.join(root, "generations");
    if (existsSync(directory))
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith(".staging")) continue;
        const stagingDir = path.join(directory, entry.name);
        if (preserveResumable && readResumableStagingCheckpoint(stagingDir, entry.name) !== null) continue;
        await /* @gate-identity state-store/task.replica-generation */ rm(stagingDir, {
          recursive: true,
          force: true,
        });
      }
    await /* @gate-identity state-store/task.replica-generation */ rm(path.join(root, "staging"), {
      recursive: true,
      force: true,
    });
    // An edge upgraded in place still holds the retired layout under the same view path.
    const pointer = path.join(root, "current.json");
    if (existsSync(pointer) && readReplicaGeneration(root) === null)
      await /* @gate-identity state-store/task.replica-generation */ rm(pointer, { force: true });
    for (const name of RETIRED_VIEW_ENTRIES)
      await /* @gate-identity state-store/task.replica-generation */ rm(path.join(root, name), {
        recursive: true,
        force: true,
      });
    const repository = path.dirname(path.dirname(root));
    for (const name of RETIRED_REPOSITORY_ENTRIES)
      await /* @gate-identity state-store/task.replica-generation */ rm(path.join(repository, name), {
        recursive: true,
        force: true,
      });
  };
  return {
    acquire(): { readonly generation: ReplicaGeneration; readonly release: () => void } | null {
      const current = readReplicaGeneration(root);
      if (current === null) return null;
      pins.set(current.id, (pins.get(current.id) ?? 0) + 1);
      let released = false;
      return {
        generation: current,
        release: () => {
          if (released) return;
          released = true;
          const remaining = pins.get(current.id)! - 1;
          if (remaining > 0) {
            pins.set(current.id, remaining);
            return;
          }
          pins.delete(current.id);
          if (readReplicaGeneration(root)?.id !== current.id) void collect();
        },
      };
    },
    collect,
    discardStaging,
  };
}
