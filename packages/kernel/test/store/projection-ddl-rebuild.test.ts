// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compileFactWrite, type FactEventDraftV1 } from "../../src/domain/fact-event.ts";
import { taskProjectionSchemaVersion } from "../../src/projection/projection-schema.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { lifecycleFixture } from "./task-lifecycle-fixture.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { withTempStoreAsync } from "./helpers.ts";

const previousProjectionSchemaVersion = 13;

test("a projection schema bump discards pre-first-class Fact DDL before replay", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const { projectionPath, eventStore } = tasklessFactLedger(rootDir, "automatic-ddl-rebuild", "F-ABE050B5");
    writeLegacyFactProjection(projectionPath, previousProjectionSchemaVersion);
    const logged = t.mock.method(console, "error", (line: string) => {
      assert.equal(existsSync(projectionPath), true, "report the old cache before removing it");
      return JSON.parse(line);
    });

    const projection = makeTaskProjection({ rootDir, eventStore });
    assert.equal(logged.mock.callCount(), 1);
    assert.deepEqual(logged.mock.calls[0]!.result, {
      event: "projection_discard_started",
      reason: "schema_mismatch",
      projectionPath,
      schemaVersion: previousProjectionSchemaVersion,
      supportedSchemaVersion: taskProjectionSchemaVersion,
      watermark: 0,
      scannedRevision: 0,
      eventStreamHead: 1,
    });
    projection.catchUp();
    assert.equal(projection.searchFacts({ query: "standalone" }).facts[0]?.factId, "F-ABE050B5");
    projection.close();
    assertCurrentFactSchema(projectionPath);
  });
});

test("explicit projection rebuild replaces stale DDL even when its version claims to be current", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const { projectionPath, eventStore } = tasklessFactLedger(rootDir, "explicit-ddl-rebuild", "F-C01DB01D");
    writeLegacyFactProjection(projectionPath, taskProjectionSchemaVersion);

    const projection = makeTaskProjection({ rootDir, eventStore });
    const logged = t.mock.method(console, "error", (line: string) => {
      assert.equal(existsSync(projectionPath), true, "report the old cache before removing it");
      return JSON.parse(line);
    });
    const rebuilt = projection.rebuild();
    assert.equal(logged.mock.callCount(), 1);
    assert.deepEqual(logged.mock.calls[0]!.result, {
      event: "projection_discard_started",
      reason: "explicit_rebuild",
      projectionPath,
      schemaVersion: taskProjectionSchemaVersion,
      supportedSchemaVersion: taskProjectionSchemaVersion,
      watermark: 0,
      scannedRevision: 0,
      eventStreamHead: 1,
    });
    assert.equal(rebuilt.watermark, 1);
    assert.equal(projection.searchFacts({ query: "standalone" }).facts[0]?.factId, "F-C01DB01D");
    projection.rebuild();
    assert.equal(logged.mock.callCount(), 2);
    assert.deepEqual(logged.mock.calls[1]!.result, {
      ...logged.mock.calls[0]!.result,
      watermark: 1,
      scannedRevision: 1,
    });
    projection.close();
    assertCurrentFactSchema(projectionPath);
  });
});

// A pure index needs no replay: every owner runs CREATE INDEX IF NOT EXISTS when it opens, so a
// current-version cache written before the index existed gains it in place.
test("an owner adds the relation owner index to a current-version cache in place", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const { projectionPath, eventStore } = tasklessFactLedger(rootDir, "owner-index", "F-0A1B2C3D");
    const projection = makeTaskProjection({ rootDir, eventStore });
    projection.catchUp();
    projection.close();
    const indexed = (db: DatabaseSync) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='relation_edge_owner'").get() !== undefined;
    const stale = new DatabaseSync(projectionPath);
    try {
      stale.exec("DROP INDEX relation_edge_owner");
      assert.equal(indexed(stale), false);
    } finally {
      stale.close();
    }
    const reopened = makeTaskProjection({ rootDir, eventStore });
    assert.equal(reopened.searchFacts({ query: "standalone" }).facts[0]?.factId, "F-0A1B2C3D");
    reopened.close();
    const current = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      assert.equal(indexed(current), true);
    } finally {
      current.close();
    }
  });
});

test("submission lookup survives later lifecycle events and adds its point-read index to an existing cache", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "submission-index", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      events = lifecycleFixture().events;
    for (const event of events) {
      const plan = taskLifecycleWritePlan(event);
      eventStore.append({ event, plan, blobs: [] });
      projection.apply(event, plan);
    }
    const submitted = events.find((event) => event.type === "execution_submitted")!;
    assert.equal(projection.readTaskSubmissionOperation("task-1", "execution-1"), submitted.opId);
    assert.equal(projection.readTaskSubmissionOperation("task-1", "missing"), null);
    assert.equal(projection.readTaskSubmissionOperation("missing", "execution-1"), null);
    projection.close();
    const stale = new DatabaseSync(projection.path);
    stale.exec("DROP INDEX event_index_submission_lookup");
    stale.close();
    const reopened = makeTaskProjection({ rootDir, eventStore });
    let lookupSql = "";
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (sql.startsWith("SELECT op_id FROM event_index")) lookupSql = sql;
      return prepare.call(this, sql);
    };
    try {
      assert.equal(reopened.readTaskSubmissionOperation("task-1", "execution-1"), submitted.opId);
    } finally {
      DatabaseSync.prototype.prepare = prepare;
      reopened.close();
    }
    assert.ok(lookupSql, "capture the actual production lookup");
    const db = new DatabaseSync(projection.path, { readOnly: true });
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${lookupSql}`).all("task-1", "execution-1");
      assert.match(JSON.stringify(plan), /SEARCH event_index USING INDEX event_index_submission_lookup/u);
      assert.doesNotMatch(JSON.stringify(plan), /SCAN |TEMP B-TREE/u);
    } finally {
      db.close();
    }
  });
});

function tasklessFactLedger(rootDir: string, repoId: string, factId: string) {
  initRepo(rootDir);
  const eventStore = makeTaskEventStore({ repoId, rootDir }),
    event: FactEventDraftV1 = {
      schema: "fact-event/v1",
      eventId: `event-${factId}`,
      workspaceRevision: 1,
      opId: `op-${factId}`,
      factId,
      type: "fact_recorded",
      actor: { principal: { personId: "projection-ddl-test" }, executor: null },
      source: "local",
      occurredAt: "2026-08-28T00:00:00.000Z",
      payload: {
        statement: "A standalone observation exercises the current Fact schema.",
        evidenceSource: "projection DDL regression fixture",
        observedAt: "2026-08-28T00:00:00.000Z",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
        provenance: [
          {
            runtime: "codex",
            sessionId: "projection-ddl-rebuild",
            transcriptReachability: "by_session_id",
            boundAt: "2026-08-28T00:00:00.000Z",
          },
        ],
      },
    };
  eventStore.append(compileFactWrite({ event }));
  return { eventStore, projectionPath: path.join(rootDir, ".harness/cache/task.sqlite") };
}

function writeLegacyFactProjection(projectionPath: string, schemaVersion: number): void {
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  const db = new DatabaseSync(projectionPath);
  try {
    db.exec(`
      CREATE TABLE projection_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL,
        watermark INTEGER NOT NULL, scan_cursor TEXT, scanned_revision INTEGER NOT NULL,
        head_digest TEXT, state_digest TEXT, squad_run_ready INTEGER NOT NULL CHECK(squad_run_ready IN (0, 1))
      );
      INSERT INTO projection_meta VALUES (1, ${schemaVersion}, 0, NULL, 0, NULL, NULL, 0);
      CREATE TABLE fact (
        task_id TEXT NOT NULL, fact_id TEXT NOT NULL, ref TEXT NOT NULL UNIQUE,
        statement TEXT NOT NULL, evidence_source TEXT NOT NULL, observed_at TEXT NOT NULL,
        confidence TEXT NOT NULL, memory_class TEXT NOT NULL, op_id TEXT NOT NULL UNIQUE,
        workspace_revision INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY(task_id, fact_id)
      );
      CREATE VIRTUAL TABLE fact_fts USING fts5(
        task_id UNINDEXED, fact_id UNINDEXED, statement, evidence_source,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE INDEX fact_filter ON fact(task_id, confidence, memory_class, observed_at);
    `);
  } finally {
    db.close();
  }
}

function assertCurrentFactSchema(projectionPath: string): void {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const factColumns = db.prepare("PRAGMA table_info(fact)").all() as unknown as readonly {
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }[],
      ftsColumns = db.prepare("PRAGMA table_info(fact_fts)").all() as unknown as readonly {
        readonly name: string;
      }[];
    assert.deepEqual(
      factColumns
        .filter(({ name }) => name === "task_id" || name === "fact_id")
        .map(({ name, notnull, pk }) => ({
          name,
          notnull,
          pk,
        })),
      [
        { name: "task_id", notnull: 0, pk: 0 },
        { name: "fact_id", notnull: 1, pk: 1 },
      ],
    );
    assert.deepEqual(
      ftsColumns.map(({ name }) => name),
      ["fact_id", "statement", "evidence_source"],
    );
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='fact_filter'").get(), undefined);
  } finally {
    db.close();
  }
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Projection DDL Test");
  git(rootDir, "config", "user.email", "projection-ddl@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
