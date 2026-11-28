import { parentPort, workerData } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import {
  BASE_BACKUP_ARCHIVE_ROOT,
  hydrateReplicaSeed,
  openReplicaProjection,
  openSqliteEventStore,
  syncDirectory,
  syncFile,
  writeFileDurably,
  type BaseBackupMetadata,
} from "@harness-anything/storage";
import {
  installStagedObjects,
  prepareStagingDirectory,
  publishStagingGeneration,
  readResumableStagingCheckpoint,
  removeStagingDirectory,
  type ReplicaGeneration,
  type ReplicaStagingCheckpoint,
  type ReplicaStagingPhase,
} from "./replica-generation.ts";

export interface ReplicaInstallWorkerInput {
  readonly root: string;
  readonly archive: string;
  readonly metadata: BaseBackupMetadata;
  readonly sha256: string;
  readonly size: number;
  readonly quotaBytes: number;
  readonly stagedObjectsDir?: string;
  readonly preunpackedDir?: string;
}

class NonResumableInstallError extends Error {}

const STAGING_CHECKPOINT_FILE = "extract.checkpoint.json";
const IMMUTABLE_OBJECT_ENTRY_RE = /\/objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{62}$/u;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;

function buildGeneration(root: string, id: string, metadata: BaseBackupMetadata): ReplicaGeneration {
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

function readMatchingCheckpoint(
  stagingDir: string,
  stagingDirName: string,
  input: ReplicaInstallWorkerInput,
): ReplicaStagingCheckpoint | null {
  const parsed = readResumableStagingCheckpoint(stagingDir, stagingDirName);
  if (
    !parsed ||
    parsed.sha256 !== input.sha256 ||
    parsed.size !== input.size ||
    parsed.repoId !== input.metadata.repoId ||
    parsed.ledgerGeneration !== input.metadata.ledgerGeneration
  ) {
    return null;
  }
  return parsed;
}

function writeCheckpoint(checkpointPath: string, input: ReplicaInstallWorkerInput, phase: ReplicaStagingPhase): void {
  const checkpoint: ReplicaStagingCheckpoint = {
    schema: "fleet-replica-staging/v1",
    sha256: input.sha256,
    size: input.size,
    repoId: input.metadata.repoId,
    ledgerGeneration: input.metadata.ledgerGeneration,
    phase,
    updatedAt: new Date().toISOString(),
  };
  writeFileDurably(checkpointPath, JSON.stringify(checkpoint));
}

function flushDirectoryTree(directory: string, immutableObjects = false): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const isObjectsRoot = entry.name === "objects" && path.basename(path.dirname(directory)) === "generations";
      const isSha256Root = immutableObjects || (entry.name === "sha256" && path.basename(directory) === "objects");
      flushDirectoryTree(target, isObjectsRoot || isSha256Root);
    }
  }
  // Content-addressed objects are immutable and were validated at the write boundary. Their
  // directory entries are persisted once, while SQLite and mutable metadata keep their file-level
  // durability fence before current.json is published.
  if (!immutableObjects) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile()) syncFile(path.join(directory, entry.name));
    }
  }
  syncDirectory(directory);
}

async function runInstall(input: ReplicaInstallWorkerInput): Promise<void> {
  const preunpacked = typeof input.preunpackedDir === "string" && input.preunpackedDir.length > 0;
  if (!preunpacked) {
    const hash = createHash("sha256");
    let received = 0;
    for await (const chunk of createReadStream(input.archive)) {
      received += chunk.length;
      hash.update(chunk);
    }
    if (received !== input.size || hash.digest("hex") !== input.sha256) {
      throw new NonResumableInstallError("base backup archive is incomplete or corrupt");
    }
  }

  const stagingKey = SHA256_HEX_RE.test(input.sha256)
    ? input.sha256
    : createHash("sha256").update(input.sha256).digest("hex");
  const generationsDir = path.join(input.root, "generations");
  const stagingDirName = `${stagingKey}.staging`;
  const temporary = preunpacked ? input.preunpackedDir! : path.join(generationsDir, stagingDirName);
  const checkpointPath = path.join(temporary, STAGING_CHECKPOINT_FILE);

  await prepareStagingDirectory(generationsDir);
  for (const entry of readdirSync(generationsDir, { withFileTypes: true })) {
    const fullEntry = path.join(generationsDir, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".staging") && fullEntry !== temporary) {
      await removeStagingDirectory(fullEntry);
    }
  }

  const existingCheckpoint = preunpacked ? null : readMatchingCheckpoint(temporary, stagingDirName, input);
  if (!preunpacked && existsSync(temporary) && !existingCheckpoint) {
    await removeStagingDirectory(temporary);
  }
  await prepareStagingDirectory(temporary);

  let phase: ReplicaStagingPhase = preunpacked ? "hydrating" : (existingCheckpoint?.phase ?? "unpacking");
  let skippedObjects = 0;

  try {
    if (preunpacked && input.stagedObjectsDir) {
      const targetObjectsDir = path.join(
        temporary,
        BASE_BACKUP_ARCHIVE_ROOT,
        "store",
        "generations",
        String(input.metadata.ledgerGeneration),
        "objects",
        "sha256",
      );
      try {
        installStagedObjects(input.stagedObjectsDir, targetObjectsDir, input.quotaBytes);
      } catch (error) {
        if (error instanceof Error && error.message === "base backup exceeds disk quota") {
          throw new NonResumableInstallError(error.message);
        }
        throw error;
      }
      writeCheckpoint(checkpointPath, input, "hydrating");
    }
    if (phase === "unpacking") {
      writeCheckpoint(checkpointPath, input, "unpacking");
      parentPort!.postMessage({ kind: "progress", phase: "unpacking", skippedObjects });
      let expandedBytes = 0;
      const unpack = new tar.Unpack({
        cwd: temporary,
        strict: true,
        preservePaths: false,
        filter: (name, entry) => {
          const segments = name.split("/");
          if (
            name.startsWith("/") ||
            name.includes("\\") ||
            segments.includes("..") ||
            !("type" in entry) ||
            !["File", "Directory"].includes(entry.type)
          ) {
            unpack.abort(new NonResumableInstallError("invalid base backup archive member"));
            return false;
          }
          if (
            name !== "backup.json" &&
            name !== BASE_BACKUP_ARCHIVE_ROOT &&
            !name.startsWith(`${BASE_BACKUP_ARCHIVE_ROOT}/`)
          ) {
            unpack.abort(new NonResumableInstallError("unexpected base backup archive member"));
            return false;
          }
          expandedBytes += entry.size;
          if (expandedBytes > input.quotaBytes) {
            unpack.abort(new NonResumableInstallError("base backup exceeds disk quota"));
            return false;
          }
          if (entry.type === "File" && IMMUTABLE_OBJECT_ENTRY_RE.test(name)) {
            const dest = path.join(temporary, name);
            if (existsSync(dest)) {
              const existing = statSync(dest);
              if (existing.isFile() && existing.size === entry.size) {
                skippedObjects += 1;
                return false;
              }
            }
          }
          return true;
        },
      });
      await pipeline(createReadStream(input.archive), unpack);
      if (input.stagedObjectsDir) {
        const targetObjectsDir = path.join(
          temporary,
          BASE_BACKUP_ARCHIVE_ROOT,
          "store",
          "generations",
          String(input.metadata.ledgerGeneration),
          "objects",
          "sha256",
        );
        try {
          installStagedObjects(input.stagedObjectsDir, targetObjectsDir, input.quotaBytes - expandedBytes);
        } catch (error) {
          if (error instanceof Error && error.message === "base backup exceeds disk quota") {
            throw new NonResumableInstallError(error.message);
          }
          throw error;
        }
      }
      phase = "hydrating";
      writeCheckpoint(checkpointPath, input, phase);
    }

    const next = buildGeneration(input.root, randomUUID(), input.metadata);

    if (phase === "hydrating") {
      parentPort!.postMessage({ kind: "progress", phase: "hydrating", skippedObjects });
      // The archive can be intact but belong to another offer or an unsupported database schema.
      // Open the actual common readers before publishing a generation; do not invent an edge schema check.
      await hydrateReplicaSeed(temporary, input.metadata);
      const stagedLedger = path.join(temporary, path.relative(next.rootDir, next.ledgerPath));
      const stagedProjection = path.join(temporary, path.relative(next.rootDir, next.projectionPath));
      if (!existsSync(stagedLedger) || !existsSync(stagedProjection)) {
        throw new NonResumableInstallError("base backup database missing");
      }
      const ledger = openSqliteEventStore({
        databasePath: stagedLedger,
        repoId: input.metadata.repoId,
        generation: input.metadata.ledgerGeneration,
        readOnly: true,
      });
      try {
        const position = ledger.replicationPosition();
        if (
          position.history !== input.metadata.position.history ||
          position.sequence !== input.metadata.position.sequence ||
          position.revision !== input.metadata.position.revision
        ) {
          throw new NonResumableInstallError("base backup position differs from offer");
        }
        // A center may ship a cache from a newer read-schema generation. The ledger in
        // the same backup is authoritative, so discard that cache through the normal
        // replay path and rebuild it using this edge's projection schema.
        const projection = openReplicaProjection({
          repoId: input.metadata.repoId,
          rootDir: temporary,
          ledgerPath: stagedLedger,
          projectionPath: stagedProjection,
          generation: 3,
        });
        try {
          if (projection.projection.catchUpAsync === undefined)
            throw new NonResumableInstallError("projection catch-up unavailable");
          await projection.projection.catchUpAsync();
          if (projection.projection.readCut().watermark !== position.revision) {
            throw new NonResumableInstallError("base backup projection position differs");
          }
        } finally {
          projection.close();
        }
      } finally {
        ledger.close();
      }
      phase = "flushing";
      writeCheckpoint(checkpointPath, input, phase);
    }

    if (phase === "flushing") {
      parentPort!.postMessage({ kind: "progress", phase: "flushing", skippedObjects });
      flushDirectoryTree(temporary);
      phase = "ready";
      writeCheckpoint(checkpointPath, input, phase);
    }

    parentPort!.postMessage({ kind: "progress", phase: "ready", skippedObjects });
    publishStagingGeneration({
      root: input.root,
      temporary,
      checkpointPath,
      generationDir: next.rootDir,
      generationId: next.id,
      metadata: next.metadata,
    });
    parentPort!.postMessage({ kind: "complete", generation: next, skippedObjects });
  } catch (error) {
    if (error instanceof NonResumableInstallError) {
      await removeStagingDirectory(temporary);
    }
    throw error;
  }
}

await runInstall(workerData as ReplicaInstallWorkerInput);
