import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { makeTaskProjectionReader, openSqliteEventStore } from "@harness-anything/kernel";
import { syncDirectory, syncFile, writeFileDurably } from "../durable-file.ts";
import type { BaseBackupMetadata } from "./basebackup.ts";

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
      ".harness",
      "store",
      "generations",
      String(metadata.ledgerGeneration),
      "ledger.sqlite",
    ),
    projectionPath: path.join(rootDir, ".harness", "cache", "task.sqlite"),
  };
}

export function readReplicaGeneration(root: string): ReplicaGeneration | null {
  const pointer = path.join(root, "current.json");
  if (!existsSync(pointer)) return null;
  const current = JSON.parse(readFileSync(pointer, "utf8")) as { id: string; metadata: BaseBackupMetadata };
  return generation(root, current.id, current.metadata);
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
        if (name !== "backup.json" && name !== ".harness" && !name.startsWith(".harness/")) {
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

/** Existing query sessions own their generation until release; replacing current never closes their files. */
export function createReplicaGenerationReader(root: string) {
  const readers = new Map<string, number>();
  return {
    acquire() {
      const current = readReplicaGeneration(root);
      if (current === null) throw new Error("replica is not initialized");
      readers.set(current.id, (readers.get(current.id) ?? 0) + 1);
      return {
        generation: current,
        release: () => {
          readers.set(current.id, readers.get(current.id)! - 1);
        },
      };
    },
    async collect(): Promise<void> {
      const current = readReplicaGeneration(root);
      if (current === null) return;
      for (const entry of readdirSync(path.join(root, "generations"), { withFileTypes: true }))
        if (
          entry.isDirectory() &&
          entry.name !== current.id &&
          !entry.name.endsWith(".staging") &&
          !(readers.get(entry.name) ?? 0)
        )
          await rm(path.join(root, "generations", entry.name), { recursive: true, force: true });
    },
  };
}
