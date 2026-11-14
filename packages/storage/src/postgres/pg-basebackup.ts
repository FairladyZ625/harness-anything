import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createPostgresPool, resolveConfirmedRepoCut, withPostgresTransaction } from "./transaction.ts";
import { resolvePostgresEventStoreScope } from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";
import { TaskEventStoreError } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { writeFileDurably } from "../durable-file.ts";
import { BASE_BACKUP_ARCHIVE_ROOT } from "../fleet-basebackup-layout.ts";
import { taskProjectionSchemaVersion } from "../projection/projection-schema.ts";
import type { BaseBackupMetadata, PostgresBaseBackupInput } from "../fleet-basebackup.ts";
import type { Pool } from "pg";

/** Portable seed for the existing edge generation installer. The center never creates SQLite. */
export async function preparePgBaseBackup(
  input: PostgresBaseBackupInput,
  pinned: (metadata: BaseBackupMetadata) => void,
) {
  if (input.storage.backend !== "postgres") throw new TypeError("Embedded backup must use its physical owner");
  const pool = createPostgresPool(input.storage.connectionString, { max: 1 });
  try {
    return await prepareSqlBaseBackup(input, pinned, pool);
  } finally {
    await pool.end();
  }
}

export async function prepareSqlBaseBackup(
  input: PostgresBaseBackupInput,
  pinned: (metadata: BaseBackupMetadata) => void,
  pool: Pool,
) {
  const scope = resolvePostgresEventStoreScope(input.storage.scope),
    payload = path.join(input.directory, "payload"),
    store = path.join(payload, BASE_BACKUP_ARCHIVE_ROOT, "store", "generations", "3");
  await /* @gate-identity state-store/task.backup-postgres */ mkdir(store, { recursive: true });
  return await withPostgresTransaction(
    pool,
    async (client) => {
      const cut = await resolveConfirmedRepoCut(client, scope, input.repoId);
      if (!cut) throw new TaskEventStoreError("invalid_store", "repository has no canonical PG head");
      const position = { history: cut.history, sequence: cut.confirmedSequence, revision: cut.confirmedRevision },
        metadata: BaseBackupMetadata = {
          schema: "fleet-basebackup/v3",
          repoId: input.repoId,
          readerProfile: input.readerProfile ?? null,
          position,
          ledgerGeneration: 3,
          projectionSchema: taskProjectionSchemaVersion,
        };
      pinned(metadata);
      // Export modules are only needed after the snapshot barrier has been released.
      const { pgEventRows, pgOutcomes } = await import("./pg-replication.ts");
      const { contentClaims } = await import("@harness-anything/kernel/internal/ports/canonical-document-claims.ts");
      const events = await pgEventRows(client, scope, input.repoId, 0, position.revision),
        outcomes = await pgOutcomes(client, scope, input.repoId, undefined, position.sequence),
        writer = (
          await client.query<{ writer_holder_id: string; writer_epoch: string }>(
            "SELECT writer_holder_id,writer_epoch FROM ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3",
            [scope.tenantId, scope.projectId, input.repoId],
          )
        ).rows[0]!;
      writeFileDurably(
        path.join(store, "canonical-seed.json"),
        JSON.stringify({
          events,
          outcomes,
          writer: { repoId: input.repoId, holder: writer.writer_holder_id, epoch: Number(writer.writer_epoch) },
        }),
      );
      // Only objects claimed by this repository's events belong to its archive.
      const claimed = [
          ...new Set(
            events.flatMap((row) =>
              contentClaims(JSON.parse(row.eventJson) as PersistedCanonicalEventV1).map((claim) => claim.sha256),
            ),
          ),
        ],
        objects = (
          await client.query<{ sha256: string; body: Buffer }>(
            "SELECT sha256,body FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=ANY($3::text[])",
            [scope.tenantId, scope.projectId, claimed],
          )
        ).rows;
      for (const object of objects)
        writeFileDurably(
          path.join(store, "objects", "sha256", object.sha256.slice(0, 2), object.sha256.slice(2)),
          object.body,
        );
      return metadata;
    },
    scope,
    { isolationLevel: "repeatable read" },
  );
}
