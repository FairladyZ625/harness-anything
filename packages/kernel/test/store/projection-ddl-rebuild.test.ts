// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compileFactWrite, type FactEventDraftV1 } from "../../src/domain/fact-event.ts";
import { taskProjectionSchemaVersion } from "../../src/projection/projection-schema.ts";
import { makeTaskProjection } from "../../src/projection/task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

const previousProjectionSchemaVersion = 13;

test("a projection schema bump discards pre-first-class Fact DDL before replay", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const { projectionPath, eventStore } = tasklessFactLedger(rootDir, "automatic-ddl-rebuild", "F-ABE050B5");
    writeLegacyFactProjection(projectionPath, previousProjectionSchemaVersion);

    const projection = makeTaskProjection({ rootDir, eventStore });
    assert.equal(projection.searchFacts({ query: "standalone" }).facts[0]?.factId, "F-ABE050B5");
    projection.close();
    assertCurrentFactSchema(projectionPath);
  });
});

test("explicit projection rebuild replaces stale DDL even when its version claims to be current", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const { projectionPath, eventStore } = tasklessFactLedger(rootDir, "explicit-ddl-rebuild", "F-C01DB01D");
    writeLegacyFactProjection(projectionPath, taskProjectionSchemaVersion);

    const projection = makeTaskProjection({ rootDir, eventStore });
    const rebuilt = projection.rebuild();
    assert.equal(rebuilt.watermark, 1);
    assert.equal(projection.searchFacts({ query: "standalone" }).facts[0]?.factId, "F-C01DB01D");
    projection.close();
    assertCurrentFactSchema(projectionPath);
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
