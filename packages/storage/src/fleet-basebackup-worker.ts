import { preparePgBaseBackup } from "./postgres/pg-basebackup.ts";
import { installStorageWorkerContext, type StorageWorkerContext } from "./storage-worker-context.ts";
import { pgliteOwnerService } from "./pglite/owner-service.ts";
import { parentPort, workerData } from "node:worker_threads";
import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { contentClaims as replicationContentClaims } from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel";
import { syncFile, writeFileDurably } from "./durable-file.ts";
import type {
  BaseBackupArchive,
  BaseBackupInput,
  BaseBackupMetadata,
  SqliteBaseBackupInput,
} from "./fleet-basebackup.ts";
import { BASE_BACKUP_ARCHIVE_ROOT } from "./fleet-basebackup-layout.ts";

const { storageContext, ...input } = workerData as BaseBackupInput & { readonly storageContext?: StorageWorkerContext };
installStorageWorkerContext(storageContext);
const sqlBackup = async () => {
  if (!("storage" in input)) throw new TypeError("SQL backup requires storage");
  const pinned = (metadata: BaseBackupMetadata) => parentPort!.postMessage({ kind: "pinned", metadata });
  if (input.storage.backend === "postgres") return preparePgBaseBackup(input, pinned);
  const service = pgliteOwnerService(input.repoId, input.storage);
  try {
    return await service.call<BaseBackupMetadata>({ service: "backup", input }, pinned);
  } finally {
    service.close();
  }
};
const metadata = "storage" in input ? await sqlBackup() : await prepareSqliteBackup(input);
const payload = path.join(input.directory, "payload");
writeFileDurably(path.join(payload, "backup.json"), JSON.stringify(metadata));
const file = path.join(input.directory, "base.tar.gz");
await tar.create({ file, cwd: payload, gzip: true, portable: true, strict: true }, [
  "backup.json",
  BASE_BACKUP_ARCHIVE_ROOT,
]);
syncFile(file);
await /* @gate-identity state-store/execution.source.storage.src.fleet-basebackup-worker.filesystem-store */ rm(
  payload,
  { recursive: true, force: true },
);
const digest = createHash("sha256");
for await (const chunk of createReadStream(file)) digest.update(chunk);
const archive: BaseBackupArchive = { metadata, file, size: (await stat(file)).size, sha256: digest.digest("hex") };
parentPort!.postMessage({ kind: "complete", archive });
async function prepareSqliteBackup(input: SqliteBaseBackupInput): Promise<BaseBackupMetadata> {
  const ledger = new DatabaseSync(input.ledgerPath, { readOnly: true });
  const projection = new DatabaseSync(input.projectionPath, { readOnly: true });
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
      schema: "fleet-basebackup/v3",
      repoId: String(state.repo_id),
      readerProfile: input.readerProfile ?? null,
      position: { history: String(state.history), sequence: Number(state.sequence), revision: Number(state.revision) },
      ledgerGeneration: Number(state.generation),
      projectionSchema: Number(projected.schema_version),
    };
    parentPort!.postMessage({ kind: "pinned", metadata });
    const payload = path.join(input.directory, "payload"),
      store = path.join(payload, BASE_BACKUP_ARCHIVE_ROOT, "store", "generations", String(metadata.ledgerGeneration)),
      cache = path.join(payload, BASE_BACKUP_ARCHIVE_ROOT, "cache");
    await /* @gate-identity state-store/execution.source.storage.src.fleet-basebackup-worker.filesystem-store */ mkdir(
      store,
      { recursive: true },
    );
    await /* @gate-identity state-store/execution.source.storage.src.fleet-basebackup-worker.filesystem-store */ mkdir(
      cache,
      { recursive: true },
    );
    await backup(ledger, path.join(store, "ledger.sqlite"));
    await backup(projection, path.join(cache, "task.sqlite"));
    const activation = `${input.ledgerPath}.activation.json`;
    if (existsSync(activation))
      await /* @gate-identity state-store/execution.source.storage.src.fleet-basebackup-worker.filesystem-store */ copyFile(
        activation,
        path.join(store, "ledger.sqlite.activation.json"),
      );
    const copied = new Set<string>();
    for (const row of ledger.prepare("SELECT event_json FROM event ORDER BY revision").iterate()) {
      const event = JSON.parse(String(row.event_json)) as PersistedCanonicalEventV1;
      for (const claim of replicationContentClaims(event)) {
        if (copied.has(claim.sha256)) continue;
        const relative = path.join("objects", "sha256", claim.sha256.slice(0, 2), claim.sha256.slice(2));
        const destination = path.join(store, relative);
        await /* @gate-identity state-store/execution.source.storage.src.fleet-basebackup-worker.filesystem-store */ mkdir(
          path.dirname(destination),
          {
            recursive: true,
          },
        );
        await /* @gate-identity state-store/execution.source.storage.src.fleet-basebackup-worker.filesystem-store */ copyFile(
          path.join(path.dirname(input.ledgerPath), relative),
          destination,
        );
        copied.add(claim.sha256);
      }
    }
    return metadata;
  } finally {
    projection.close();
    ledger.close();
  }
}
