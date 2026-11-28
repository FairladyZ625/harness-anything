import type { StorageWorkerContext } from "./storage-worker-context.ts";
import { parentPort, workerData } from "node:worker_threads";
import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";
import * as tar from "tar";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel";
import { syncFile, writeFileDurably } from "./durable-file.ts";
import type {
  BaseBackupArchive,
  BaseBackupFormat,
  BaseBackupInput,
  BaseBackupMetadata,
  BaseBackupObjectEntry,
  SqliteBaseBackupInput,
} from "./fleet-basebackup.ts";
import { createHotSetTracker } from "./fleet-basebackup-hotset.ts";
import { BASE_BACKUP_ARCHIVE_ROOT } from "./fleet-basebackup-layout.ts";
import { DEFAULT_REPLICA_LOG_WINDOW_COMMITS, openReplicaStore } from "./store/replica-store.ts";
import { sqliteDatabasePath } from "./store/sqlite-ledger-layout.ts";

const { storageContext, ...input } = workerData as BaseBackupInput & { readonly storageContext?: StorageWorkerContext };
if (storageContext) {
  const { installPGliteWorkerContext } = await import("./pglite/query-owner.ts");
  installPGliteWorkerContext(storageContext);
}
const sqlBackup = async () => {
  if (!("storage" in input)) throw new TypeError("SQL backup requires storage");
  const pinned = (metadata: BaseBackupMetadata) => parentPort!.postMessage({ kind: "pinned", metadata });
  if (input.storage.backend === "postgres") {
    const { preparePgBaseBackup } = await import("./postgres/pg-basebackup.ts");
    return preparePgBaseBackup(input, pinned);
  }
  const { pgliteOwnerService } = await import("./pglite/owner-service.ts");
  const service = pgliteOwnerService(input.repoId, input.storage);
  try {
    return await service.call<BaseBackupMetadata>({ service: "backup", input }, pinned);
  } finally {
    service.close();
  }
};
const mode = input.mode ?? "monolithic";
const format: BaseBackupFormat = input.format ?? "v3";
const metadata = "storage" in input ? await sqlBackup() : await prepareSqliteBackup(input, format);
const payload = path.join(input.directory, "payload");
const payloadObjectsPath = path.join(payload, "objects.json");
const splitObjects =
  mode === "split" && existsSync(payloadObjectsPath)
    ? (JSON.parse(readFileSync(payloadObjectsPath, "utf8")) as readonly BaseBackupObjectEntry[])
    : undefined;
writeFileDurably(path.join(payload, "backup.json"), JSON.stringify(metadata));
const file = path.join(input.directory, format === "v4" ? "base.tar.zst" : "base.tar.gz");
let sha256: string;
let archiveSize: number;
if (format === "v4") {
  const digest = createHash("sha256");
  let writtenBytes = 0;
  const hashTap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      writtenBytes += chunk.byteLength;
      Reflect.apply(digest.update, digest, [chunk]);
      callback(null, chunk);
    },
  });
  const tarStream = tar.c({ cwd: payload, gzip: false, portable: true, strict: true }, [
    "backup.json",
    BASE_BACKUP_ARCHIVE_ROOT,
  ]);
  const outputStream = /* @gate-identity state-store/task.backup-sqlite */ createWriteStream(file);
  await pipeline(tarStream, createZstdCompress(), hashTap, outputStream);
  syncFile(file);
  sha256 = digest.digest("hex");
  archiveSize = writtenBytes;
} else {
  await tar.create({ file, cwd: payload, gzip: true, portable: true, strict: true }, [
    "backup.json",
    BASE_BACKUP_ARCHIVE_ROOT,
  ]);
  syncFile(file);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  sha256 = digest.digest("hex");
  archiveSize = (await stat(file)).size;
}
await /* @gate-identity state-store/task.backup-sqlite */ rm(payload, { recursive: true, force: true });
const hotObjectCount =
  mode === "split" && splitObjects !== undefined
    ? splitObjects.filter((entry) => entry.tier !== "cold").length
    : undefined;
const coldObjectCount =
  mode === "split" && splitObjects !== undefined
    ? splitObjects.filter((entry) => entry.tier === "cold").length
    : undefined;
const splitMeta =
  mode === "split" && splitObjects !== undefined
    ? {
        mode: "split" as const,
        objects: splitObjects,
        objectCount: splitObjects.length,
        ...(format === "v4" ? { hotObjectCount, coldObjectCount } : {}),
      }
    : { mode: "monolithic" as const };
const archive: BaseBackupArchive = {
  metadata,
  file,
  size: archiveSize,
  sha256,
  ...splitMeta,
};
parentPort!.postMessage({ kind: "complete", archive });
async function prepareSqliteBackup(
  input: SqliteBaseBackupInput,
  format: BaseBackupFormat,
): Promise<BaseBackupMetadata> {
  const ledger = new DatabaseSync(sqliteDatabasePath(input.ledgerPath), { readOnly: true });
  const projection = new DatabaseSync(sqliteDatabasePath(input.projectionPath), { readOnly: true });
  try {
    ledger.exec("BEGIN");
    projection.exec("BEGIN");
    const state = ledger
      .prepare(
        "SELECT repo_id,generation,revision,history,sequence FROM ledger_meta JOIN replication_state USING(singleton)",
      )
      .get()!;
    const projected = projection
      .prepare("SELECT watermark,schema_version FROM projection_meta WHERE singleton=1")
      .get()!;
    if (state.revision !== projected.watermark)
      throw new Error("base backup requires the projection at the accepted ledger revision");
    const metadata: BaseBackupMetadata = {
      schema: format === "v4" ? "fleet-basebackup/v4" : "fleet-basebackup/v3",
      repoId: String(state.repo_id),
      readerProfile: input.readerProfile ?? null,
      position: { history: String(state.history), sequence: Number(state.sequence), revision: Number(state.revision) },
      ledgerGeneration: Number(state.generation),
      projectionSchema: Number(projected.schema_version),
    };
    parentPort!.postMessage({ kind: "pinned", metadata });
    const { contentClaims: replicationContentClaims } = await import(
      "@harness-anything/kernel/internal/ports/canonical-document-claims.ts"
    );
    const payload = path.join(input.directory, "payload"),
      store = path.join(payload, BASE_BACKUP_ARCHIVE_ROOT, "store", "generations", String(metadata.ledgerGeneration)),
      cache = path.join(payload, BASE_BACKUP_ARCHIVE_ROOT, "cache");
    await /* @gate-identity state-store/task.backup-sqlite */ mkdir(store, { recursive: true });
    await /* @gate-identity state-store/task.backup-sqlite */ mkdir(cache, { recursive: true });
    await backup(ledger, sqliteDatabasePath(path.join(store, "ledger.sqlite")));
    await backup(projection, sqliteDatabasePath(path.join(cache, "task.sqlite")));
    // Retain a bounded replication_log window so promotable replicas can serve lagging edges after Switchover.
    const replicaLedger = openReplicaStore({
      databasePath: path.join(store, "ledger.sqlite"),
      repoId: metadata.repoId,
      generation: metadata.ledgerGeneration,
      retentionWindowCommits: input.replicaLogWindowCommits ?? DEFAULT_REPLICA_LOG_WINDOW_COMMITS,
    });
    try {
      replicaLedger.position();
    } finally {
      replicaLedger.close();
    }
    syncFile(path.join(store, "ledger.sqlite"));
    const activation = `${input.ledgerPath}.activation.json`;
    if (existsSync(activation))
      await /* @gate-identity state-store/task.backup-sqlite */ copyFile(
        activation,
        path.join(store, "ledger.sqlite.activation.json"),
      );
    const ledgerDir = path.dirname(input.ledgerPath);
    if (mode === "split" && format === "v4") {
      const tracker = createHotSetTracker({ coldThresholdBytes: input.hotSetThresholdBytes });
      for (const row of ledger.prepare("SELECT event_json FROM event ORDER BY revision").iterate()) {
        const event = JSON.parse(String(row.event_json)) as PersistedCanonicalEventV1;
        tracker.observeEvent(event);
      }
      const { entries } = tracker.finalize((sha256) => {
        const sourcePath = path.join(ledgerDir, "objects", "sha256", sha256.slice(0, 2), sha256.slice(2));
        return statSync(sourcePath).size;
      });
      writeFileDurably(path.join(payload, "objects.json"), JSON.stringify(entries));
    } else {
      const copied = new Set<string>();
      const splitObjects: BaseBackupObjectEntry[] = [];
      for (const row of ledger.prepare("SELECT event_json FROM event ORDER BY revision").iterate()) {
        const event = JSON.parse(String(row.event_json)) as PersistedCanonicalEventV1;
        for (const claim of replicationContentClaims(event)) {
          if (copied.has(claim.sha256)) continue;
          const relative = path.join("objects", "sha256", claim.sha256.slice(0, 2), claim.sha256.slice(2));
          const sourcePath = path.join(ledgerDir, relative);
          if (mode === "split") {
            splitObjects.push({ sha256: claim.sha256, size: statSync(sourcePath).size });
          } else {
            const destination = path.join(store, relative);
            await /* @gate-identity state-store/task.backup-sqlite */ mkdir(path.dirname(destination), {
              recursive: true,
            });
            await /* @gate-identity state-store/task.backup-sqlite */ copyFile(sourcePath, destination);
          }
          copied.add(claim.sha256);
        }
      }
      if (mode === "split") {
        writeFileDurably(path.join(payload, "objects.json"), JSON.stringify(splitObjects));
      }
    }
    return metadata;
  } finally {
    projection.close();
    ledger.close();
  }
}
