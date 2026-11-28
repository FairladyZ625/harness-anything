import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createPostgresPool, resolveConfirmedRepoCut, withPostgresTransaction } from "./transaction.ts";
import { resolvePostgresEventStoreScope } from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";
import { TaskEventStoreError } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { syncFile, writeFileDurably } from "../durable-file.ts";
import { BASE_BACKUP_ARCHIVE_ROOT } from "../fleet-basebackup-layout.ts";
import { createHotSetTracker } from "../fleet-basebackup-hotset.ts";
import { taskProjectionSchemaVersion } from "../projection/projection-schema.ts";
import type { BaseBackupMetadata, BaseBackupObjectEntry, PostgresBaseBackupInput } from "../fleet-basebackup.ts";
import type { SqliteCommandOutcome, SqliteEventRow } from "../store/sqlite-event-store-types.ts";
import type { Pool, PoolClient } from "pg";

const PG_EXPORT_EVENT_BATCH_SIZE = 1000;
const PG_EXPORT_OUTCOME_BATCH_SIZE = 1000;
const PG_BLOB_QUERY_BATCH_SIZE = 4096;

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

async function* iteratePgEventBatches(
  client: PoolClient,
  scope: { readonly tenantId: string; readonly projectId: string },
  repoId: string,
  throughRevision: number,
  batchSize = PG_EXPORT_EVENT_BATCH_SIZE,
): AsyncGenerator<readonly SqliteEventRow[]> {
  let cursorRevision = 0;
  while (cursorRevision < throughRevision) {
    const result = await client.query<{
      revision: string;
      op_id: string;
      event_json: string;
      occurred_at: string;
      recorded_at: string;
      event_digest: `sha256:${string}`;
    }>(
      `SELECT revision,op_id,event_json,occurred_at,event_digest,COALESCE(recorded_at_text,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS recorded_at FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND revision>$4 AND revision<=$5 ORDER BY revision LIMIT $6`,
      [scope.tenantId, scope.projectId, repoId, cursorRevision, throughRevision, batchSize],
    );
    if (result.rows.length === 0) break;
    const rows: SqliteEventRow[] = result.rows.map((row) => ({
      revision: Number(row.revision),
      opId: row.op_id,
      eventJson: row.event_json,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      digest: row.event_digest,
    }));
    cursorRevision = rows.at(-1)!.revision;
    yield rows;
    if (rows.length < batchSize) break;
  }
}

async function* iteratePgOutcomeBatches(
  client: PoolClient,
  scope: { readonly tenantId: string; readonly projectId: string },
  repoId: string,
  throughSequence: number,
  batchSize = PG_EXPORT_OUTCOME_BATCH_SIZE,
): AsyncGenerator<readonly SqliteCommandOutcome[]> {
  let offset = 0;
  for (;;) {
    const result = await client.query<{
      op_id: string;
      status: "accepted_durable" | "rejected";
      first_revision: string | null;
      last_revision: string | null;
      intent_digest: `sha256:${string}`;
      intent_summary: string;
      rejection_code: string | null;
      recorded_at: string;
      member_op_ids: string[];
    }>(
      `SELECT op_id,status,first_revision,last_revision,intent_digest,intent_summary,rejection_code,member_op_ids,COALESCE(recorded_at_text,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS recorded_at FROM ha_command_outcomes WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND replication_sequence IS NOT NULL AND replication_sequence<=$4 ORDER BY first_revision NULLS LAST,op_id LIMIT $5 OFFSET $6`,
      [scope.tenantId, scope.projectId, repoId, throughSequence, batchSize, offset],
    );
    if (result.rows.length === 0) break;
    const rows: SqliteCommandOutcome[] = result.rows.map((row) => ({
      opId: row.op_id,
      status: row.status,
      firstRevision: row.first_revision === null ? null : Number(row.first_revision),
      lastRevision: row.last_revision === null ? null : Number(row.last_revision),
      intentDigest: row.intent_digest,
      summary: row.intent_summary,
      rejectionCode: row.rejection_code,
      recordedAt: row.recorded_at,
      memberOpIds: row.member_op_ids,
    }));
    offset += rows.length;
    yield rows;
    if (rows.length < batchSize) break;
  }
}

export async function prepareSqlBaseBackup(
  input: PostgresBaseBackupInput,
  pinned: (metadata: BaseBackupMetadata) => void,
  pool: Pool,
) {
  const scope = resolvePostgresEventStoreScope(input.storage.scope),
    format = input.format ?? "v3",
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
          schema: format === "v4" ? "fleet-basebackup/v4" : "fleet-basebackup/v3",
          repoId: input.repoId,
          readerProfile: input.readerProfile ?? null,
          position,
          ledgerGeneration: 3,
          projectionSchema: taskProjectionSchemaVersion,
        };
      pinned(metadata);
      const writerRow = (
        await client.query<{ writer_holder_id: string; writer_epoch: string }>(
          "SELECT writer_holder_id,writer_epoch FROM ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3",
          [scope.tenantId, scope.projectId, input.repoId],
        )
      ).rows[0]!;
      const writer = {
        repoId: input.repoId,
        holder: writerRow.writer_holder_id,
        epoch: Number(writerRow.writer_epoch),
      };

      const tracker = createHotSetTracker({
        coldThresholdBytes: input.hotSetThresholdBytes,
        requireTextDocumentsHot: true,
      });
      if (format === "v4") {
        // Streaming NDJSON export: never materializes the full snapshot in memory or calls whole-snapshot JSON.stringify.
        const seedPath = path.join(store, "canonical-seed.ndjson");
        async function* generateNdjsonChunks(): AsyncGenerator<string> {
          yield `${JSON.stringify({ kind: "header", schema: "canonical-seed-ndjson/v1", writer })}\n`;
          for await (const batch of iteratePgEventBatches(client, scope, input.repoId, position.revision)) {
            let chunk = "";
            for (const row of batch) {
              tracker.observeEvent(JSON.parse(row.eventJson) as PersistedCanonicalEventV1);
              chunk += `${JSON.stringify({ kind: "event", row })}\n`;
            }
            if (chunk.length > 0) yield chunk;
          }
          for await (const batch of iteratePgOutcomeBatches(client, scope, input.repoId, position.sequence)) {
            let chunk = "";
            for (const row of batch) {
              chunk += `${JSON.stringify({ kind: "outcome", row })}\n`;
            }
            if (chunk.length > 0) yield chunk;
          }
        }
        const out = /* @gate-identity state-store/task.backup-postgres */ createWriteStream(seedPath);
        await pipeline(Readable.from(generateNdjsonChunks()), out);
        syncFile(seedPath);
      } else {
        // Backward-compatible v3 canonical-seed.json, streamed incrementally to avoid whole-snapshot JSON.stringify OOM.
        const seedPath = path.join(store, "canonical-seed.json");
        async function* generateLegacyJsonChunks(): AsyncGenerator<string> {
          yield `{"writer":${JSON.stringify(writer)},"events":[`;
          let firstEvent = true;
          for await (const batch of iteratePgEventBatches(client, scope, input.repoId, position.revision)) {
            let chunk = "";
            for (const row of batch) {
              tracker.observeEvent(JSON.parse(row.eventJson) as PersistedCanonicalEventV1);
              chunk += `${firstEvent ? "" : ","}${JSON.stringify(row)}`;
              firstEvent = false;
            }
            if (chunk.length > 0) yield chunk;
          }
          yield `],"outcomes":[`;
          let firstOutcome = true;
          for await (const batch of iteratePgOutcomeBatches(client, scope, input.repoId, position.sequence)) {
            let chunk = "";
            for (const row of batch) {
              chunk += `${firstOutcome ? "" : ","}${JSON.stringify(row)}`;
              firstOutcome = false;
            }
            if (chunk.length > 0) yield chunk;
          }
          yield "]}";
        }
        const out = /* @gate-identity state-store/task.backup-postgres */ createWriteStream(seedPath);
        await pipeline(Readable.from(generateLegacyJsonChunks()), out);
        syncFile(seedPath);
      }

      // Only objects claimed by this repository's events belong to its archive.
      const claimed = tracker.claimedSha256s();
      if (input.mode === "split") {
        const sizeByHash = new Map<string, number>();
        for (let offset = 0; offset < claimed.length; offset += PG_BLOB_QUERY_BATCH_SIZE) {
          const slice = claimed.slice(offset, offset + PG_BLOB_QUERY_BATCH_SIZE);
          const rows = (
            await client.query<{ sha256: string; size: string | number }>(
              "SELECT sha256,octet_length(body)::bigint AS size FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=ANY($3::text[])",
              [scope.tenantId, scope.projectId, slice],
            )
          ).rows;
          for (const row of rows) sizeByHash.set(row.sha256, Number(row.size));
        }
        const objects: readonly BaseBackupObjectEntry[] =
          format === "v4"
            ? tracker.finalize((sha256) => sizeByHash.get(sha256) ?? 0).entries
            : claimed
                .filter((sha256) => sizeByHash.has(sha256))
                .map((sha256) => ({ sha256, size: sizeByHash.get(sha256)! }));
        writeFileDurably(path.join(payload, "objects.json"), JSON.stringify(objects));
      } else {
        for (let offset = 0; offset < claimed.length; offset += PG_BLOB_QUERY_BATCH_SIZE) {
          const slice = claimed.slice(offset, offset + PG_BLOB_QUERY_BATCH_SIZE);
          const objects = (
            await client.query<{ sha256: string; body: Buffer }>(
              "SELECT sha256,body FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=ANY($3::text[])",
              [scope.tenantId, scope.projectId, slice],
            )
          ).rows;
          for (const object of objects)
            writeFileDurably(
              path.join(store, "objects", "sha256", object.sha256.slice(0, 2), object.sha256.slice(2)),
              object.body,
            );
        }
      }
      return metadata;
    },
    scope,
    { isolationLevel: "repeatable read" },
  );
}
