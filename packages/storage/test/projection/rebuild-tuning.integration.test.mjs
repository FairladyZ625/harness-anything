// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DOC_CODEC_ID,
  DOC_POLICY_ID,
  docSyncWritePlan,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { compileFactWrite } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import { compileTaskProgress } from "@harness-anything/kernel/internal/domain/task-progress-event.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { taskProjectionSchemaVersion } from "../../src/projection/projection-schema.ts";
import {
  closeQueryOnlyReader,
  withDatabase,
  withQueryOnlyDatabaseSession,
  withRebuildDatabase,
} from "../../src/projection/rebuildable-task-projection-database.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { canonicalEventWritePlan, makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskEventReader } from "../../src/store/task-event-store-factory.ts";
import { sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { initRepo } from "../store/task-event-store.fixtures.ts";

function normalizeSql(sql) {
  return sql.replace(/\s+/gu, " ").trim();
}

function readSchemaFingerprint(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
      .all()
      .map((row) => ({
        type: row.type,
        name: row.name,
        tbl_name: row.tbl_name,
        sql: normalizeSql(row.sql),
      }));
  } finally {
    db.close();
  }
}

function buildRichLedger(rootDir, repoId, extraTaskCount = 120) {
  initRepo(rootDir);
  const eventStore = makeTaskEventStore({ repoId, rootDir });
  let revision = 0;

  // 1. Task lifecycle with active lease (populated lease_interval) + task_progress + runtime session binding
  const baseLifecycle = lifecycleFixture({ complete: false }).events;
  const created = baseLifecycle[0];
  const started = baseLifecycle[1];
  assert.equal(created.type, "task_created");
  assert.equal(started.type, "execution_started");

  revision += 1;
  eventStore.append({
    event: { ...created, workspaceRevision: revision },
    plan: taskLifecycleWritePlan({ ...created, workspaceRevision: revision }),
    blobs: [],
  });

  revision += 1;
  const startedEvent = { ...started, workspaceRevision: revision };
  eventStore.append({ event: startedEvent, plan: taskLifecycleWritePlan(startedEvent), blobs: [] });

  // 2. Task progress row (exercises deferred index task_progress_task_revision)
  revision += 1;
  const progressBundle = compileTaskProgress({
    eventId: `progress-ev-${revision}`,
    opId: `progress-op-${revision}`,
    workspaceRevision: revision,
    taskId: startedEvent.taskId,
    executionId: startedEvent.payload.execution.executionId,
    packagePath: `tasks/${startedEvent.taskId}-fixture`,
    text: "Exercises task_progress deferred index during offline cold rebuild.",
    evidence: [],
    currentDocument: null,
    activeLease: startedEvent.payload.lease,
    startRecoveryAvailable: false,
    actor: startedEvent.payload.lease.actor,
    source: "local",
    occurredAt: "2026-11-27T00:01:00.000Z",
  });
  eventStore.append(progressBundle);

  // 3. Runtime session + task binding (exercises deferred index runtime_session_task_binding_session)
  revision += 1;
  const sessionStarted = {
    schema: "agent-runtime-event/v1",
    eventId: `rt-start-ev-${revision}`,
    workspaceRevision: revision,
    opId: `rt-start-op-${revision}`,
    type: "runtime_session_started",
    actor: { principal: { personId: "person-tuning" }, executor: { kind: "agent", id: "codex" } },
    source: { kind: "node", nodeId: "node-tuning" },
    occurredAt: "2026-11-27T00:02:00.000Z",
    payload: {
      runtimeSessionId: "rt-session-tuning-1",
      instanceId: "codex-fixture",
      installationId: "install-tuning-1",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
      launchGeneration: 1,
      attachable: false,
    },
  };
  eventStore.append({
    event: sessionStarted,
    plan: canonicalEventWritePlan(sessionStarted, "agent-runtime/v1", sessionStarted.opId),
    blobs: [],
  });

  revision += 1;
  const sessionTaskBound = {
    schema: "agent-runtime-event/v1",
    eventId: `rt-bind-ev-${revision}`,
    workspaceRevision: revision,
    opId: `rt-bind-op-${revision}`,
    type: "runtime_session_task_bound",
    actor: { principal: { personId: "person-tuning" }, executor: { kind: "agent", id: "codex" } },
    source: { kind: "node", nodeId: "node-tuning" },
    occurredAt: "2026-11-27T00:02:10.000Z",
    payload: {
      runtimeSessionId: "rt-session-tuning-1",
      taskId: startedEvent.taskId,
      executionId: startedEvent.payload.execution.executionId,
      providerSessionId: "provider-session-tuning-1",
      transcriptRef: "file:runtime-transcripts/codex/session.jsonl",
    },
  };
  eventStore.append({
    event: sessionTaskBound,
    plan: canonicalEventWritePlan(sessionTaskBound, "agent-runtime/v1", sessionTaskBound.opId),
    blobs: [],
  });

  // 4. Document write + Fact write
  revision += 1;
  const docBody = "# S1 Rebuild Tuning\n\nDeterministic stateDigest verification.\n";
  const docSha = sha256Text(docBody);
  const docEvent = {
    schema: "doc-event/v1",
    eventId: `doc-ev-${revision}`,
    workspaceRevision: revision,
    opId: `doc-op-${revision}`,
    type: "documents_written",
    actor: { principal: { personId: "person-tuning" }, executor: null },
    source: "local",
    occurredAt: "2026-11-27T00:03:00.000Z",
    payload: {
      executionId: null,
      baseLedgerSha: eventStore.currentCut(),
      changes: [
        {
          path: "context/s1-tuning.md",
          baseBlobSha256: null,
          candidate: { sha256: docSha, size: Buffer.byteLength(docBody), mediaType: "text/markdown" },
          policyId: DOC_POLICY_ID,
          regionProofs: [
            {
              regionId: "heading/s1-tuning",
              policyId: DOC_POLICY_ID,
              codecId: DOC_CODEC_ID,
              baseSha256: sha256Text(""),
              candidateSha256: docSha,
              insertBytes: Buffer.byteLength(docBody),
            },
          ],
        },
      ],
    },
  };
  eventStore.append({
    event: docEvent,
    plan: docSyncWritePlan(docEvent),
    blobs: [{ sha256: docSha, size: Buffer.byteLength(docBody), mediaType: "text/markdown", body: docBody }],
  });

  revision += 1;
  const factBundle = compileFactWrite({
    event: {
      schema: "fact-event/v1",
      eventId: `fact-ev-${revision}`,
      workspaceRevision: revision,
      opId: `fact-op-${revision}`,
      factId: "F-AABBCCDD",
      type: "fact_recorded",
      actor: { principal: { personId: "person-tuning" }, executor: null },
      source: "local",
      occurredAt: "2026-11-27T00:04:00.000Z",
      payload: {
        statement: "Offline rebuild tuning preserves byte-identical stateDigest.",
        evidenceSource: "packages/storage/test/projection/rebuild-tuning.integration.test.mjs",
        observedAt: "2026-11-27T00:04:00.000Z",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
        provenance: [
          {
            runtime: "codex",
            sessionId: "rt-session-tuning-1",
            transcriptReachability: "by_session_id",
            boundAt: "2026-11-27T00:04:00.000Z",
          },
        ],
      },
    },
  });
  eventStore.append(factBundle);

  // 5. Additional tasks so total events >> 32 (online catchUpLimit) to prove bulk 4096 batch override
  for (let i = 1; i <= extraTaskCount; i += 1) {
    revision += 1;
    const taskId = `s1-bulk-task-${i}`;
    const taskEvent = {
      ...created,
      eventId: `s1-bulk-ev-${revision}`,
      opId: `s1-bulk-op-${revision}`,
      taskId,
      workspaceRevision: revision,
      occurredAt: new Date(Date.UTC(2026, 10, 27, 1, 0, i)).toISOString(),
      payload: {
        ...created.payload,
        task: { ...created.payload.task, taskId, title: `Bulk Task ${i}` },
      },
    };
    eventStore.append({ event: taskEvent, plan: taskLifecycleWritePlan(taskEvent), blobs: [] });
  }

  return { eventStore, totalRevisions: revision };
}

test("tuned offline rebuild overrides catchUpLimit: 32 to bulk 4096 with byte-identical stateDigest and full index parity", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const { eventStore, totalRevisions } = buildRichLedger(rootDir, "s1-tuning-parity", 120);
    t.after(() => eventStore.drain());

    const incrementalPath = path.join(rootDir, ".harness/cache/incremental.sqlite");
    const rebuiltPath = path.join(rootDir, ".harness/cache/rebuilt.sqlite");
    const incremental = makeTaskProjection({
      rootDir,
      eventStore,
      projectionPath: incrementalPath,
      catchUpLimit: 32,
    });
    const rebuilt = makeTaskProjection({
      rootDir,
      eventStore,
      projectionPath: rebuiltPath,
      catchUpLimit: 32,
    });

    try {
      // Online catchUp must still honor caller catchUpLimit: 32.
      const catchUpReceipt = incremental.catchUp();
      assert.equal(catchUpReceipt.watermark, totalRevisions);
      assert.equal(catchUpReceipt.metrics.maxBatchItems, 32);
      assert.ok(
        catchUpReceipt.metrics.storeTransactions >= Math.ceil(totalRevisions / 32),
        `online catchUp must honor catchUpLimit=32, got ${catchUpReceipt.metrics.storeTransactions} transactions`,
      );

      // Offline rebuild must override catchUpLimit: 32 to bulk 4096 (single replay tx + verify tx = 2).
      const rebuildReceipt = rebuilt.rebuild();
      assert.equal(rebuildReceipt.watermark, totalRevisions);
      assert.equal(rebuildReceipt.metrics.reducedItems, totalRevisions);
      assert.equal(rebuildReceipt.metrics.maxBatchItems, totalRevisions);
      assert.equal(rebuildReceipt.metrics.storeTransactions, 2);

      // Byte-identical stateDigest and schema_version === 39.
      const incrementalDigest = incremental.readStateDigest();
      assert.ok(incrementalDigest !== null);
      assert.equal(rebuildReceipt.stateDigest, incrementalDigest);
      assert.equal(rebuilt.readStateDigest(), incrementalDigest);

      // Full sqlite_master parity including all 3 newly deferred indexes.
      const rebuiltSchema = readSchemaFingerprint(rebuiltPath);
      const incrementalSchema = readSchemaFingerprint(incrementalPath);
      assert.deepEqual(rebuiltSchema, incrementalSchema);

      const indexNames = new Set(rebuiltSchema.filter((row) => row.type === "index").map((row) => row.name));
      for (const expectedIndex of [
        "task_progress_task_revision",
        "runtime_session_task_binding_session",
        "lease_interval_current",
      ]) {
        assert.equal(indexNames.has(expectedIndex), true, `missing deferred index ${expectedIndex}`);
      }

      const verifyDb = new DatabaseSync(rebuiltPath, { readOnly: true });
      try {
        const meta = verifyDb.prepare("SELECT schema_version FROM projection_meta WHERE singleton = 1").get();
        assert.equal(Number(meta.schema_version), taskProjectionSchemaVersion);
        assert.equal(taskProjectionSchemaVersion, 39);
      } finally {
        verifyDb.close();
      }
      t.diagnostic(
        JSON.stringify({
          totalRevisions,
          stateDigest: rebuildReceipt.stateDigest,
          onlineTransactions: catchUpReceipt.metrics.storeTransactions,
          rebuildTransactions: rebuildReceipt.metrics.storeTransactions,
          rebuildMaxBatchItems: rebuildReceipt.metrics.maxBatchItems,
          indexCount: indexNames.size,
        }),
      );
    } finally {
      incremental.close();
      rebuilt.close();
    }
  });
});

test("post-rebuild adopted connection restores online PRAGMAs and releases EXCLUSIVE lock for concurrent readers and writers", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const { eventStore, totalRevisions } = buildRichLedger(rootDir, "s1-tuning-pragmas", 20);
    t.after(() => eventStore.drain());

    const projection = makeTaskProjection({
      rootDir,
      eventStore,
      catchUpLimit: 32,
    });
    try {
      const receipt = projection.rebuild();
      assert.equal(receipt.watermark, totalRevisions);

      // Keep projection open (connection is adopted) and inspect its live PRAGMA settings.
      const livePragmas = withDatabase(projection.path, eventStore.readHead, (db) => ({
        lockingMode: String(db.prepare("PRAGMA locking_mode").get().locking_mode).toLowerCase(),
        journalMode: String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase(),
        synchronous: Number(db.prepare("PRAGMA synchronous").get().synchronous),
        mmapSize: Number(db.prepare("PRAGMA mmap_size").get().mmap_size),
        cacheSize: Number(db.prepare("PRAGMA cache_size").get().cache_size),
        tempStore: Number(db.prepare("PRAGMA temp_store").get().temp_store),
      }));
      assert.deepEqual(livePragmas, {
        lockingMode: "normal",
        journalMode: "wal",
        synchronous: 2,
        mmapSize: 0,
        cacheSize: -2000,
        tempStore: 0,
      });

      // Concurrent query-only session on the same path while adopted connection remains open must not hit SQLITE_BUSY.
      const queryOnlyWatermark = withQueryOnlyDatabaseSession(projection.path, eventStore.readHead, (db) =>
        Number(db.prepare("SELECT watermark FROM projection_meta WHERE singleton = 1").get().watermark),
      );
      assert.equal(queryOnlyWatermark, totalRevisions);
      closeQueryOnlyReader(projection.path);

      // Independent read-only and read-write SQLite connections must also open and read/write cleanly.
      const ro = new DatabaseSync(projection.path, { readOnly: true });
      try {
        const count = Number(ro.prepare("SELECT COUNT(*) AS count FROM task_snapshot").get().count);
        assert.equal(count, 21);
      } finally {
        ro.close();
      }
      const rw = new DatabaseSync(projection.path);
      try {
        rw.exec("BEGIN IMMEDIATE; ROLLBACK");
      } finally {
        rw.close();
      }
    } finally {
      projection.close();
    }

    // Error path: if replay throws inside withRebuildDatabase, exclusive lock and handle are cleanly released.
    const failedPath = path.join(rootDir, ".harness/cache/failed-rebuild.sqlite");
    assert.throws(
      () =>
        withRebuildDatabase(
          failedPath,
          eventStore.readHead,
          () => {
            throw new Error("simulated replay abort");
          },
          () => undefined,
        ),
      /simulated replay abort/u,
    );
    const probe = new DatabaseSync(failedPath);
    try {
      const mode = String(probe.prepare("PRAGMA locking_mode").get().locking_mode).toLowerCase();
      assert.equal(mode, "normal");
      probe.exec("BEGIN IMMEDIATE; ROLLBACK");
    } finally {
      probe.close();
    }
  });
});

test("SQL continuity fast-path skips readBatch on contiguous ledgers and accurately rejects gaps across 3 negative controls plus fallback", async (t) => {
  t.mock.method(console, "error", () => undefined);

  // Positive control: contiguous SQLite ledger uses verifyRevisionContinuity without calling readBatch during discardDatabase.
  await withTempStoreAsync(async (rootDir) => {
    const { eventStore, totalRevisions } = buildRichLedger(rootDir, "s1-continuity-ok", 10);
    t.after(() => eventStore.drain());

    const seed = makeTaskProjection({ rootDir, eventStore });
    seed.catchUp();
    seed.close();

    let continuityCalls = 0;
    let readBatchCalls = 0;
    let readBatchCallsBeforeContinuityDone = 0;
    const validationProgress = [];
    const spyStore = {
      readHead: () => eventStore.readHead(),
      readBatch: (cursor, maxItems) => {
        readBatchCalls += 1;
        return eventStore.readBatch(cursor, maxItems);
      },
      readContentBlob: (sha256) => eventStore.readContentBlob(sha256),
      verifyRevisionContinuity: (throughRevision) => {
        continuityCalls += 1;
        const result = eventStore.verifyRevisionContinuity(throughRevision);
        readBatchCallsBeforeContinuityDone = readBatchCalls;
        return result;
      },
    };
    const projection = makeTaskProjection({
      rootDir,
      eventStore: spyStore,
      onValidationProgress: (p) => validationProgress.push(p),
    });
    try {
      const receipt = projection.rebuild();
      assert.equal(receipt.watermark, totalRevisions);
      assert.equal(continuityCalls, 1, "expected SQL fast-path verifyRevisionContinuity to run once");
      assert.equal(readBatchCallsBeforeContinuityDone, 0, "discard continuity check must not invoke readBatch");
      assert.equal(readBatchCalls, 1, "readBatch should only be called once for bulk replay");
      assert.deepEqual(validationProgress[0], { applied: totalRevisions, total: totalRevisions });
    } finally {
      projection.close();
    }
  });

  // Negative control 1: middle gap (delete revisions 5..7)
  await withTempStoreAsync(async (rootDir) => {
    const { eventStore, totalRevisions } = buildRichLedger(rootDir, "s1-continuity-mid-gap", 10);
    const projection = makeTaskProjection({ rootDir, eventStore });
    projection.catchUp();
    projection.close();
    const retained = readFileSync(projection.path);
    await eventStore.drain();

    const ledger = new DatabaseSync(sqliteLedgerPath(rootDir, 3));
    try {
      for (const rev of [5, 6, 7]) {
        ledger.prepare("DELETE FROM event_query_entity WHERE revision = ?").run(rev);
        ledger.prepare("DELETE FROM event WHERE revision = ?").run(rev);
      }
    } finally {
      ledger.close();
    }

    const reader = makeTaskEventReader({ repoId: "s1-continuity-mid-gap", rootDir });
    t.after(() => reader.drain());
    assert.deepEqual(reader.verifyRevisionContinuity(totalRevisions), {
      continuous: false,
      missingRange: { from: 5, to: 7 },
    });

    const brokenProjection = makeTaskProjection({ rootDir, eventStore: reader });
    try {
      assert.throws(
        () => brokenProjection.rebuild(),
        (error) => {
          assert.equal(error.code, "invalid_store");
          assert.deepEqual(error.missingRange, { from: 5, to: 7 });
          assert.equal(error.cacheWatermark, totalRevisions);
          assert.equal(error.eventStreamHead, totalRevisions);
          return true;
        },
      );
      assert.deepEqual(readFileSync(projection.path), retained, "original task.sqlite must be retained on gap");
    } finally {
      brokenProjection.close();
    }
  });

  // Negative control 2: missing starting revision 1 (delete revisions 1..2)
  await withTempStoreAsync(async (rootDir) => {
    const { eventStore, totalRevisions } = buildRichLedger(rootDir, "s1-continuity-start-gap", 5);
    const projection = makeTaskProjection({ rootDir, eventStore });
    projection.catchUp();
    projection.close();
    const retained = readFileSync(projection.path);
    await eventStore.drain();

    const ledger = new DatabaseSync(sqliteLedgerPath(rootDir, 3));
    try {
      for (const rev of [1, 2]) {
        ledger.prepare("DELETE FROM event_query_entity WHERE revision = ?").run(rev);
        ledger.prepare("DELETE FROM event WHERE revision = ?").run(rev);
      }
    } finally {
      ledger.close();
    }

    const reader = makeTaskEventReader({ repoId: "s1-continuity-start-gap", rootDir });
    t.after(() => reader.drain());
    assert.deepEqual(reader.verifyRevisionContinuity(totalRevisions), {
      continuous: false,
      missingRange: { from: 1, to: 2 },
    });

    const brokenProjection = makeTaskProjection({ rootDir, eventStore: reader });
    try {
      assert.throws(
        () => brokenProjection.rebuild(),
        (error) => {
          assert.equal(error.code, "invalid_store");
          assert.deepEqual(error.missingRange, { from: 1, to: 2 });
          return true;
        },
      );
      assert.deepEqual(readFileSync(projection.path), retained);
    } finally {
      brokenProjection.close();
    }
  });

  // Negative control 3: event stream head smaller than coverageRevision
  await withTempStoreAsync(async (rootDir) => {
    const { eventStore, totalRevisions } = buildRichLedger(rootDir, "s1-continuity-head-short", 5);
    let readable = eventStore;
    const delegatingStore = {
      readHead: () => readable.readHead(),
      readBatch: (cursor, maxItems) => readable.readBatch(cursor, maxItems),
      readContentBlob: (sha256) => readable.readContentBlob(sha256),
      verifyRevisionContinuity: (throughRevision) => readable.verifyRevisionContinuity(throughRevision),
    };
    const projection = makeTaskProjection({ rootDir, eventStore: delegatingStore });
    projection.catchUp();
    projection.close();

    // Advance projection_meta beyond ledger head to simulate truncated/lagging source.
    const inflatedCoverage = totalRevisions + 4;
    const db = new DatabaseSync(projection.path);
    try {
      db.prepare("UPDATE projection_meta SET watermark = ?, scanned_revision = ? WHERE singleton = 1").run(
        inflatedCoverage,
        inflatedCoverage,
      );
    } finally {
      db.close();
    }
    const retained = readFileSync(projection.path);
    await eventStore.drain();

    const reader = makeTaskEventReader({ repoId: "s1-continuity-head-short", rootDir });
    t.after(() => reader.drain());
    readable = reader;
    assert.deepEqual(reader.verifyRevisionContinuity(inflatedCoverage), {
      continuous: false,
      missingRange: { from: totalRevisions + 1, to: inflatedCoverage },
    });

    const rejectsShortHead = (error) => {
      assert.equal(error.code, "invalid_store");
      assert.deepEqual(error.missingRange, { from: totalRevisions + 1, to: inflatedCoverage });
      assert.equal(error.eventStreamHead, totalRevisions);
      return true;
    };
    assert.throws(() => projection.rebuild(), rejectsShortHead);
    assert.throws(() => makeTaskProjection({ rootDir, eventStore: reader }), rejectsShortHead);
    assert.deepEqual(readFileSync(projection.path), retained);
  });

  // Fallback control: EventStreamPort without verifyRevisionContinuity uses readBatch and detects gaps.
  await withTempStoreAsync(async (rootDir) => {
    const { eventStore, totalRevisions } = buildRichLedger(rootDir, "s1-continuity-fallback", 5);
    t.after(() => eventStore.drain());

    const seed = makeTaskProjection({ rootDir, eventStore });
    seed.catchUp();
    seed.close();
    const retained = readFileSync(seed.path);

    const allEvents = eventStore.read().events.filter((event) => event.workspaceRevision !== 4);
    let fallbackReadBatchCalls = 0;
    const fallbackStore = {
      readHead: () => eventStore.readHead(),
      readBatch: (cursor, maxItems) => {
        fallbackReadBatchCalls += 1;
        const start = cursor === null ? 0 : Number(cursor);
        const batch = allEvents.slice(start, start + maxItems);
        const next = start + batch.length;
        return {
          sourceRevision: totalRevisions,
          events: batch,
          cursor: String(next),
          done: next >= allEvents.length,
          accessedItems: batch.length,
        };
      },
      readContentBlob: (sha256) => eventStore.readContentBlob(sha256),
    };
    const projection = makeTaskProjection({ rootDir, eventStore: fallbackStore });
    try {
      assert.throws(
        () => projection.rebuild(),
        (error) => {
          assert.equal(error.code, "invalid_store");
          assert.deepEqual(error.missingRange, { from: 4, to: 4 });
          return true;
        },
      );
      assert.ok(fallbackReadBatchCalls >= 1, "fallback port without verifyRevisionContinuity must call readBatch");
      assert.deepEqual(readFileSync(seed.path), retained);
    } finally {
      projection.close();
    }
  });
});
