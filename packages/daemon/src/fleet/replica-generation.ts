import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { makeTaskProjectionReader, openSqliteEventStore } from "@harness-anything/kernel";
import { syncDirectory, syncFile, writeFileDurably } from "../durable-file.ts";
import type { BaseBackupMetadata } from "./basebackup.ts";
import { BASE_BACKUP_ARCHIVE_ROOT } from "./basebackup-layout.ts";

export interface ReplicaGeneration {
  readonly id: string;
  readonly rootDir: string;
  readonly ledgerPath: string;
  readonly projectionPath: string;
  readonly metadata: BaseBackupMetadata;
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
  (value as { metadata?: { schema?: unknown } | null }).metadata?.schema === "fleet-basebackup/v2";

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
  rmSync(pointer);
  syncDirectory(root);
}

export function updateReplicaGenerationPosition(root: string, position: BaseBackupMetadata["position"]): void {
  const pointer = path.join(root, "current.json");
  if (!existsSync(pointer)) throw new Error("replica generation is unavailable");
  const current = JSON.parse(readFileSync(pointer, "utf8")) as { id: string; metadata: BaseBackupMetadata };
  writeFileDurably(pointer, JSON.stringify({ id: current.id, metadata: { ...current.metadata, position } }));
}

/** The caller has decoded metadata; this verifies bytes written after the center's acceptance boundary. */
export async function installReplicaGeneration(input: {
  readonly root: string;
  readonly archive: string;
  readonly metadata: BaseBackupMetadata;
  readonly sha256: string;
  readonly size: number;
  readonly quotaBytes: number;
}): Promise<ReplicaGeneration> {
  const hash = createHash("sha256");
  let received = 0;
  for await (const chunk of createReadStream(input.archive)) {
    received += chunk.length;
    hash.update(chunk);
  }
  if (received !== input.size || hash.digest("hex") !== input.sha256)
    throw new Error("base backup archive is incomplete or corrupt");
  const next = generation(input.root, randomUUID(), input.metadata),
    temporary = `${next.rootDir}.staging`;
  await mkdir(temporary, { recursive: true });
  let expandedBytes = 0;
  try {
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
          unpack.abort(new Error("invalid base backup archive member"));
          return false;
        }
        if (
          name !== "backup.json" &&
          name !== BASE_BACKUP_ARCHIVE_ROOT &&
          !name.startsWith(`${BASE_BACKUP_ARCHIVE_ROOT}/`)
        ) {
          unpack.abort(new Error("unexpected base backup archive member"));
          return false;
        }
        expandedBytes += entry.size;
        if (expandedBytes > input.quotaBytes) {
          unpack.abort(new Error("base backup exceeds disk quota"));
          return false;
        }
        return true;
      },
    });
    await pipeline(createReadStream(input.archive), unpack);
    // The archive can be intact but belong to another offer or an unsupported database schema.
    // Open the actual common readers before publishing a generation; do not invent an edge schema check.
    const stagedLedger = path.join(temporary, path.relative(next.rootDir, next.ledgerPath));
    const stagedProjection = path.join(temporary, path.relative(next.rootDir, next.projectionPath));
    if (!existsSync(stagedLedger) || !existsSync(stagedProjection)) throw new Error("base backup database missing");
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
      )
        throw new Error("base backup position differs from offer");
      const projection = makeTaskProjectionReader({ rootDir: temporary, projectionPath: stagedProjection });
      try {
        if (projection.withSession((queries) => queries.readCut().watermark) !== position.revision)
          throw new Error("base backup projection position differs");
      } finally {
        projection.close();
      }
    } finally {
      ledger.close();
    }
    const flush = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) flush(target);
        else syncFile(target);
      }
      syncDirectory(directory);
    };
    flush(temporary);
    // Publication cannot yield between making the directory collectible and publishing its pointer.
    renameSync(temporary, next.rootDir);
    syncDirectory(path.dirname(next.rootDir));
    writeFileDurably(path.join(input.root, "current.json"), JSON.stringify({ id: next.id, metadata: next.metadata }));
    return next;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

/**
 * One pin registry per replica root in this process: the receiver that installs and collects
 * generations and the edge reads that open them share it. A pinned generation outlives a newer
 * install; the last release of a superseded generation collects it.
 */
const generationReaders = new Map<string, ReturnType<typeof createGenerationReaders>>();
export function replicaGenerationReaders(root: string) {
  const key = path.resolve(root);
  let readers = generationReaders.get(key);
  if (!readers) generationReaders.set(key, (readers = createGenerationReaders(key)));
  return readers;
}

/** Runs one synchronous read against the current generation (null before the first install) while it is pinned. */
export function withReplicaGeneration<T>(root: string, read: (generation: ReplicaGeneration | null) => T): T {
  const pin = replicaGenerationReaders(root).acquire();
  try {
    return read(pin?.generation ?? null);
  } finally {
    pin?.release();
  }
}

function createGenerationReaders(root: string) {
  const pins = new Map<string, number>();
  const collect = (): void => {
    const current = readReplicaGeneration(root),
      directory = path.join(root, "generations");
    if (!existsSync(directory)) return;
    // Staging belongs to an install in flight; only unpinned generations other than the published one
    // go (all of them once a revocation withdrew the pointer).
    const superseded = readdirSync(directory, { withFileTypes: true }).filter(
      (entry) =>
        entry.isDirectory() && entry.name !== current?.id && !entry.name.endsWith(".staging") && !pins.get(entry.name),
    );
    for (const entry of superseded) rmSync(path.join(directory, entry.name), { recursive: true, force: true });
  };
  /**
   * Removes what a crashed install left behind (unpublished generation staging and received base
   * backup archives) and what the retired cut/pull replica left at this view. Only the single
   * installer of this root calls it, before it can install again.
   */
  const discardStaging = async (): Promise<void> => {
    const directory = path.join(root, "generations");
    if (existsSync(directory))
      for (const entry of readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory() && entry.name.endsWith(".staging"))
          await rm(path.join(directory, entry.name), { recursive: true, force: true });
    await rm(path.join(root, "staging"), { recursive: true, force: true });
    // An edge upgraded in place still holds the retired layout under the same view path.
    const pointer = path.join(root, "current.json");
    if (existsSync(pointer) && readReplicaGeneration(root) === null) await rm(pointer, { force: true });
    for (const name of RETIRED_VIEW_ENTRIES) await rm(path.join(root, name), { recursive: true, force: true });
    const repository = path.dirname(path.dirname(root));
    for (const name of RETIRED_REPOSITORY_ENTRIES)
      await rm(path.join(repository, name), { recursive: true, force: true });
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
          if (readReplicaGeneration(root)?.id !== current.id) collect();
        },
      };
    },
    collect,
    discardStaging,
  };
}
