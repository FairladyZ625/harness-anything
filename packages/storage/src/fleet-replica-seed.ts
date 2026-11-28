import path from "node:path";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { BaseBackupMetadata } from "./fleet-basebackup.ts";
import { BASE_BACKUP_ARCHIVE_ROOT } from "./fleet-basebackup-layout.ts";
import {
  openSqliteEventStore,
  type SqliteEventRow,
  type SqliteCommandOutcome,
  type SqliteWriterFence,
} from "./store/sqlite-event-store.ts";
import {
  parseCanonicalEvent,
  serializePersistedCanonicalEvent,
} from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import { canonicalEventContentClaims } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { openReplicaProjection } from "./replica-projection.ts";
import { removeFileDurably, writeFileDurably } from "./durable-file.ts";
import { sqliteDatabasePath } from "./store/sqlite-ledger-layout.ts";

interface SeedCheckpoint {
  readonly processedOutcomes: number;
}

interface ParsedReplicaSeed {
  readonly events: readonly SqliteEventRow[];
  readonly outcomes: readonly SqliteCommandOutcome[];
  readonly writer: SqliteWriterFence;
}

function readSeedCheckpoint(checkpointPath: string): number {
  if (!existsSync(checkpointPath)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(checkpointPath, "utf8")) as Partial<SeedCheckpoint>;
    return typeof parsed.processedOutcomes === "number" &&
      Number.isInteger(parsed.processedOutcomes) &&
      parsed.processedOutcomes >= 0
      ? parsed.processedOutcomes
      : 0;
  } catch {
    return 0;
  }
}

async function readNdjsonReplicaSeed(ndjsonPath: string): Promise<ParsedReplicaSeed> {
  const events: SqliteEventRow[] = [];
  const outcomes: SqliteCommandOutcome[] = [];
  let writer: SqliteWriterFence | null = null;
  const reader = createInterface({
    input: createReadStream(ndjsonPath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const rawLine of reader) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const record = JSON.parse(line) as
      | { readonly kind: "header"; readonly schema: string; readonly writer: SqliteWriterFence }
      | { readonly kind: "event"; readonly row: SqliteEventRow }
      | { readonly kind: "outcome"; readonly row: SqliteCommandOutcome };
    if (record.kind === "header") {
      if (record.schema !== "canonical-seed-ndjson/v1") {
        throw new Error(`unsupported canonical seed NDJSON schema: ${record.schema}`);
      }
      writer = record.writer;
    } else if (record.kind === "event") {
      events.push(record.row);
    } else if (record.kind === "outcome") {
      outcomes.push(record.row);
    } else {
      throw new Error("invalid canonical seed NDJSON record");
    }
  }
  if (!writer) throw new Error("canonical seed NDJSON is missing its header");
  return { events, outcomes, writer };
}

/** Runs only on the receiving edge, before its ordinary generation readers validate and publish. */
export async function hydrateReplicaSeed(rootDir: string, metadata: BaseBackupMetadata): Promise<void> {
  const ledgerPath = path.join(
      rootDir,
      BASE_BACKUP_ARCHIVE_ROOT,
      "store",
      "generations",
      String(metadata.ledgerGeneration),
      "ledger.sqlite",
    ),
    ndjsonSeedPath = path.join(path.dirname(ledgerPath), "canonical-seed.ndjson"),
    jsonSeedPath = path.join(path.dirname(ledgerPath), "canonical-seed.json"),
    checkpointPath = path.join(path.dirname(ledgerPath), "canonical-seed.checkpoint.json");
  const activeSeedPath = existsSync(ndjsonSeedPath) ? ndjsonSeedPath : existsSync(jsonSeedPath) ? jsonSeedPath : null;
  if (activeSeedPath === null) return;
  const seed: ParsedReplicaSeed =
    activeSeedPath === ndjsonSeedPath
      ? await readNdjsonReplicaSeed(ndjsonSeedPath)
      : (JSON.parse(readFileSync(jsonSeedPath, "utf8")) as ParsedReplicaSeed);
  const deferColdBlobs = metadata.schema === "fleet-basebackup/v4",
    deferredColdBlobSizes = new Map<string, number>(),
    startIndex = Math.min(readSeedCheckpoint(checkpointPath), seed.outcomes.length),
    importer = openSqliteEventStore({
      repoId: metadata.repoId,
      databasePath: ledgerPath,
      generation: 3,
      conversionSourceGeneration: 2,
      deferMissingObjects: deferColdBlobs,
    });
  try {
    for (let offset = startIndex; offset < seed.outcomes.length; offset += 100) {
      const batch = seed.outcomes.slice(offset, offset + 100);
      for (const outcome of batch) {
        const rows =
            outcome.firstRevision === null ? [] : seed.events.slice(outcome.firstRevision - 1, outcome.lastRevision!),
          events = rows.map((row) => parseCanonicalEvent(row.eventJson, { allowUnknownForwardFields: true })),
          claims = new Map(
            events.flatMap((event) =>
              canonicalEventContentClaims(event as never).map((claim) => [claim.sha256, claim] as const),
            ),
          );
        const blobs = [...claims.values()].flatMap((claim) => {
          const objectFile = path.join(
            path.dirname(ledgerPath),
            "objects",
            "sha256",
            claim.sha256.slice(0, 2),
            claim.sha256.slice(2),
          );
          if (deferColdBlobs && !existsSync(objectFile)) {
            deferredColdBlobSizes.set(claim.sha256, claim.size);
            return [];
          }
          return [
            {
              ...claim,
              mediaType: "application/octet-stream",
              body: readFileSync(objectFile),
            },
          ];
        });
        importer.appendCommand(
          {
            fence: seed.writer,
            intent: { opId: outcome.opId, intentDigest: outcome.intentDigest, summary: outcome.summary },
            events: events as never,
            rejectionCode: outcome.rejectionCode ?? undefined,
            blobs,
            historicalRecord: { recordedAt: outcome.recordedAt, eventRecordedAt: rows.map((row) => row.recordedAt) },
          },
          // Keep future event bytes verbatim. The receiving ledger is an archival copy and
          // must not force a newer edge to understand a schema it only needs to retain.
          events.map((event) => serializePersistedCanonicalEvent(event, { allowUnknownForwardFields: true })),
        );
      }
      const processedOutcomes = offset + batch.length;
      writeFileDurably(checkpointPath, JSON.stringify({ processedOutcomes }));
      if (processedOutcomes < seed.outcomes.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    importer.close();
  }
  const database = /* @gate-identity state-store/task.replica-seed */ new DatabaseSync(sqliteDatabasePath(ledgerPath));
  try {
    /* @gate-identity state-store/task.replica-seed */ database.exec("BEGIN IMMEDIATE");
    /* @gate-identity state-store/task.replica-seed */ database
      .prepare("UPDATE replication_state SET history=?,sequence=? WHERE singleton=1")
      .run(metadata.position.history, metadata.position.sequence);
    /* @gate-identity state-store/task.replica-seed */ database.exec("DELETE FROM replication_log");
    /* @gate-identity state-store/task.replica-seed */ database
      .prepare("INSERT INTO replication_log(sequence,revision,outcome_op_id,writer_json) VALUES(?,?,NULL,?)")
      .run(metadata.position.sequence, metadata.position.revision, JSON.stringify(seed.writer));
    /* @gate-identity state-store/task.replica-seed */ database.exec("COMMIT");
  } finally {
    database.close();
  }
  const model = openReplicaProjection({
    repoId: metadata.repoId,
    rootDir,
    ledgerPath,
    projectionPath: path.join(rootDir, BASE_BACKUP_ARCHIVE_ROOT, "cache", "task.sqlite"),
    generation: 3,
    ...(deferredColdBlobSizes.size > 0 ? { deferredColdBlobSizes } : {}),
  });
  try {
    await model.projection.catchUpAsync?.();
  } finally {
    model.close();
  }
  if (existsSync(checkpointPath)) removeFileDurably(checkpointPath);
  removeFileDurably(activeSeedPath);
}
