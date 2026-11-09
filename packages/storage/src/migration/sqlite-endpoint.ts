import { localContentObjectFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { objectPath } from "../store/content-objects.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { parseCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import { openSqliteEventStore, resolveActiveGeneration } from "../store/sqlite-event-store.ts";
import { sqliteLedgerPath } from "../store/sqlite-ledger-layout.ts";
import { publishGenerationThreeActivation } from "../store/generation-three-activation.ts";
import { makeTaskProjection } from "../projection/rebuildable-task-projection.ts";
import { readSqliteMigrationControl, ensureSqliteMigrationControl } from "./sqlite-control.ts";
import { assertMigrationValue, validateStorageManifest } from "./manifest.ts";
import { auditMigrationProjection, migrationEventStream } from "./projection.ts";
import { StorageMigrationError, type MigrationEndpoint, type MigrationTuple } from "./types.ts";
import type { PostgresEventStoreScope } from "../postgres/pg-event-store.ts";

export function openSqliteMigrationEndpoint(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly scope: PostgresEventStoreScope;
  readonly role?: "source" | "target";
}): MigrationEndpoint {
  const databasePath = sqliteLedgerPath(input.rootDir, 3);
  if (
    input.role !== "target" &&
    (!existsSync(databasePath) ||
      !existsSync(`${databasePath}.activation.json`) ||
      resolveActiveGeneration({ rootInput: input.rootDir, repoId: input.repoId }) !== 3)
  )
    throw new StorageMigrationError(
      "storage_migration_source_not_active",
      "SQLite source must be the activated generation 3 authority",
    );
  const store = openSqliteEventStore({
      repoId: input.repoId,
      databasePath,
      generation: 3,
      conversionSourceGeneration: 2,
    }),
    db = /* @gate-identity state-store/legacy.a39420159c9e4a1e */ new DatabaseSync(databasePath);
  /* @gate-identity state-store/legacy.6e4de5c35e7d717b */ db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
  ensureSqliteMigrationControl(db);
  const state = () => readSqliteMigrationControl(db),
    currentCut = () =>
      canonicalLedgerCut(
        input.repoId,
        (() => {
          const row = store.eventRows().at(-1);
          return row ? { revision: row.revision, opId: row.opId, eventDigest: row.digest } : null;
        })(),
      );
  const readTuple = async (): Promise<MigrationTuple> => {
    const scopeRow = /* @gate-identity state-store/legacy.a6a2d6612179abca */ db
        .prepare("SELECT scope_json FROM storage_migration_scope WHERE singleton=1")
        .get(),
      scope = scopeRow ? (JSON.parse(String(scopeRow.scope_json)) as PostgresEventStoreScope) : input.scope,
      events = store.eventRows().map((row) => ({ ...row, readers: scope.readers, policyEpoch: scope.policyEpoch })),
      blobs = [...store.contentObjectDigests()].sort().map((sha256) => {
        const bytes = store.readContentObject(sha256)!;
        return {
          sha256,
          size: bytes.length,
          bodyBase64: Buffer.from(bytes).toString("base64"),
          readers: scope.readers,
          policyEpoch: scope.policyEpoch,
        };
      }),
      outcomes = [...store.outcomes()]
        .sort((a, b) => (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0))
        .map((row) => ({ ...row, readers: scope.readers, policyEpoch: scope.policyEpoch })),
      documentHeads = /* @gate-identity state-store/legacy.f54dd25e543f8feb */ db
        .prepare("SELECT * FROM document_head ORDER BY path")
        .all()
        .map((row) => ({
          path: String(row.path),
          sha256: row.sha256 as string | null,
          size: row.size == null ? null : Number(row.size),
          nodeKind: row.node_kind as string | null,
          revision: Number(row.revision),
          readers: scope.readers,
          policyEpoch: scope.policyEpoch,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      data = { scope, events, blobs, outcomes, documentHeads, cut: currentCut() },
      projection = makeTaskProjection({
        rootDir: input.rootDir,
        eventStore: migrationEventStream(input.repoId, data),
        now: () => "1970-01-01T00:00:00.000Z",
      });
    try {
      assertMigrationValue(store.revision(), data.cut.revision, "SQLite persisted head differs from event sequence");
      projection.catchUp?.();
      return { ...data, projection: await auditMigrationProjection(input.repoId, data, projection, true) };
    } finally {
      projection.close();
    }
  };
  return {
    id: `sqlite:${path.resolve(databasePath)}`,
    backend: "sqlite",
    state: async () => state(),
    marker: async (runId) =>
      !!(
        /* @gate-identity state-store/legacy.ab78a003d0081474 */ db
          .prepare("SELECT 1 FROM storage_activation_markers WHERE run_id=?")
          .get(runId)
      ),
    epoch: async () => store.writerFence()?.epoch ?? 0,
    export: async () => [await readTuple()],
    change: async (expected, next, activate) => {
      if (activate && !existsSync(`${databasePath}.activation.json`))
        publishGenerationThreeActivation(input.rootDir, {
          schema: "generation-activation/v3",
          repoId: input.repoId,
          generation: 3,
          sourceCut: null,
          // Cross-backend events are current canonical history, not a legacy generation prefix.
          importedPrefixRevision: 0,
          acceptedCut: next.cut,
        });
      /* @gate-identity state-store/legacy.4dec66a6c6d7778e */ db.exec("BEGIN IMMEDIATE");
      try {
        assertMigrationValue(state(), expected, "SQLite migration state changed concurrently");
        if (["freezing", "prepared"].includes(next.phase) && next.epoch <= (store.writerFence()?.epoch ?? 0))
          throw new StorageMigrationError("storage_migration_conflict", "writer epoch advanced before takeover");
        if (
          next.role === "target" &&
          next.phase === "prepared" &&
          (store.revision() !== 0 || store.outcomes().length !== 0)
        )
          throw new StorageMigrationError("storage_migration_target_not_empty", "target changed before prepare");
        if (next.phase === "freezing")
          assertMigrationValue(currentCut(), next.cut, "source changed before epoch takeover");
        /* @gate-identity state-store/legacy.b4eb18df790201a1 */ db.prepare(
          "INSERT INTO storage_migration_control VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET record_json=excluded.record_json",
        ).run(JSON.stringify(next));
        /* @gate-identity state-store/legacy.668e423d1b78ef50 */ db.prepare(
          "INSERT INTO writer_lease(repo_id,holder,epoch) VALUES(?,?,?) ON CONFLICT(repo_id) DO UPDATE SET holder=excluded.holder,epoch=excluded.epoch",
        ).run(input.repoId, `migration:${next.runId}`, next.epoch);
        if (activate)
          /* @gate-identity state-store/legacy.7f833ae8b114d961 */ db.prepare(
            "INSERT INTO storage_activation_markers VALUES(?,?)",
          ).run(next.runId, JSON.stringify(next));
        /* @gate-identity state-store/legacy.f0db4026c3726729 */ db.exec("COMMIT");
      } catch (error) {
        /* @gate-identity state-store/legacy.95beb80066672868 */ db.exec("ROLLBACK");
        throw error;
      }
    },
    import: async (manifest) => {
      validateStorageManifest(manifest);
      const control = state();
      if (
        control?.runId !== manifest.runId ||
        control.role !== "target" ||
        !["prepared", "activation_failed"].includes(control.phase)
      )
        throw new StorageMigrationError("storage_migration_conflict", "SQLite import requires its prepared run");
      const tuple = manifest.tuples[0]!;
      /* @gate-identity state-store/legacy.e00ca3b96fd60396 */ db.prepare(
        "INSERT INTO storage_migration_scope VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET scope_json=excluded.scope_json",
      ).run(JSON.stringify(tuple.scope));
      localContentObjectFileSystem.replaceMany(
        tuple.blobs.map((blob) => ({
          path: objectPath(path.join(path.dirname(databasePath), "objects", "sha256"), blob.sha256),
          body: Buffer.from(blob.bodyBase64, "base64"),
        })),
      );
      const importer = openSqliteEventStore({
        repoId: input.repoId,
        databasePath,
        generation: 3,
        conversionSourceGeneration: 2,
        migrationImportRunId: manifest.runId,
      });
      try {
        for (const outcome of [...tuple.outcomes].sort(
          (a, b) => (a.firstRevision ?? Infinity) - (b.firstRevision ?? Infinity),
        )) {
          const rows =
              outcome.firstRevision === null
                ? []
                : tuple.events.slice(outcome.firstRevision - 1, outcome.lastRevision!),
            events = rows.map((row) => parseCanonicalEvent(row.eventJson));
          importer.appendCommand({
            fence: { repoId: input.repoId, holder: `migration:${manifest.runId}`, epoch: control.epoch },
            intent: { opId: outcome.opId, intentDigest: outcome.intentDigest, summary: outcome.summary },
            events: events as never,
            blobs: tuple.blobs.map((blob) => ({
              sha256: blob.sha256,
              size: blob.size,
              mediaType: "application/octet-stream",
              body: Buffer.from(blob.bodyBase64, "base64"),
            })),
            ...(outcome.rejectionCode ? { rejectionCode: outcome.rejectionCode } : {}),
            historicalRecord: { recordedAt: outcome.recordedAt, eventRecordedAt: rows.map((row) => row.recordedAt) },
          });
        }
      } finally {
        importer.close();
      }
      // Scope stays with the authority rather than its configuration. It is kept in the control record.
    },
    close: async () => {
      store.close();
      db.close();
    },
  };
}
