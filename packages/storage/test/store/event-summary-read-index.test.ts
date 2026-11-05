// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPOSITORY_READ_TABLES_SQL, createProjectionTables } from "../../src/projection/projection-tables.ts";
import {
  assertEventSummaryReadIndexReady,
  backfillEventSummaryReadIndex,
  ensureEventSummaryReadIndexColumns,
} from "../../src/projection/event-summary-read-index.ts";
import { readEventList } from "../../src/projection/event-list-query.ts";

const OLD_EVENT_SUMMARY = `
  CREATE TABLE event_summary (
    workspace_revision INTEGER PRIMARY KEY,
    summary_json TEXT NOT NULL,
    witness_json TEXT NOT NULL,
    row_json TEXT NOT NULL
  )`;

function row(revision: number, type: string, entityRefs: readonly string[], actor = "person-a"): string {
  return JSON.stringify({
    revision,
    opId: `op-${revision}`,
    eventId: `event-${revision}`,
    schema: "task-event/v1",
    type,
    occurredAt: `2026-09-01T00:00:0${revision}.000Z`,
    actor: { personId: actor, executorId: null },
    entityRefs,
  });
}

test("existing event summaries expand in place and answer the indexed filters", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(OLD_EVENT_SUMMARY);
    db.prepare("INSERT INTO event_summary VALUES (1, '{}', '{}', ?)").run(
      row(1, "entity_upserted", ["software/coding/adr@1/ADR-1"]),
    );
    db.prepare("INSERT INTO event_summary VALUES (2, '{}', '{}', ?)").run(row(2, "task_created", ["task/task_x"]));
    createProjectionTables(db);
    assert.deepEqual(
      db
        .prepare(
          "SELECT workspace_revision, event_type, read_index_version FROM event_summary ORDER BY workspace_revision",
        )
        .all()
        .map(({ workspace_revision, event_type, read_index_version }) => ({
          workspace_revision,
          event_type,
          read_index_version,
        }))
        .map((value) => ({ ...value })),
      [
        { workspace_revision: 1, event_type: "entity_upserted", read_index_version: 1 },
        { workspace_revision: 2, event_type: "task_created", read_index_version: 1 },
      ],
    );
    assert.deepEqual(
      readEventList(db, { type: "entity_upserted", limit: 10 }).rows.map(({ revision }) => revision),
      [1],
    );
    for (const entity of ["software/coding/adr@1/ADR-1", "coding/adr@1/ADR-1", "adr@1/ADR-1", "ADR-1"])
      assert.deepEqual(
        readEventList(db, { entity, limit: 10 }).rows.map(({ revision }) => revision),
        [1],
        entity,
      );
    assert.deepEqual(
      readEventList(db, { entity: "task/task_x", limit: 10 }).rows.map(({ revision }) => revision),
      [2],
    );
  } finally {
    db.close();
  }
});

test("a pre-expansion writer row is filled by the trigger instead of staying pending", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(OLD_EVENT_SUMMARY);
    createProjectionTables(db);
    db.prepare(
      "INSERT INTO event_summary(workspace_revision, summary_json, witness_json, row_json) VALUES (7, '{}', '{}', ?)",
    ).run(row(7, "task_created", ["task/task_late"]));
    assert.deepEqual(
      {
        ...(db
          .prepare(
            "SELECT event_type, actor_person_id, read_index_version FROM event_summary WHERE workspace_revision = 7",
          )
          .get() as object),
      },
      { event_type: "task_created", actor_person_id: "person-a", read_index_version: 1 },
    );
    assert.deepEqual(
      readEventList(db, { entity: "task/task_late", limit: 10 }).rows.map(({ revision }) => revision),
      [7],
    );
  } finally {
    db.close();
  }
});

test("backfill stops loudly instead of looping when the fill trigger is absent", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(OLD_EVENT_SUMMARY);
    db.prepare("INSERT INTO event_summary VALUES (1, '{}', '{}', ?)").run(row(1, "task_created", ["task/task_x"]));
    ensureEventSummaryReadIndexColumns(db);
    assert.throws(() => backfillEventSummaryReadIndex(db), /fill triggers are missing/u);
  } finally {
    db.close();
  }
});

test("readers fail closed before the migration has created the derived columns", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(OLD_EVENT_SUMMARY);
    db.prepare("INSERT INTO event_summary VALUES (1, '{}', '{}', ?)").run(row(1, "task_created", ["task/task_x"]));
    assert.throws(() => readEventList(db, { limit: 10 }), { code: "projection_pending" });
  } finally {
    db.close();
  }
});

test("readers fail closed during the backfill window and answer after it completes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(OLD_EVENT_SUMMARY);
    for (let revision = 1; revision <= 3; revision++)
      db.prepare("INSERT INTO event_summary VALUES (?, '{}', '{}', ?)").run(
        revision,
        row(revision, "task_created", [`task/task_${revision}`]),
      );
    ensureEventSummaryReadIndexColumns(db);
    db.exec(REPOSITORY_READ_TABLES_SQL);
    assert.throws(() => assertEventSummaryReadIndexReady(db), { code: "projection_pending" });
    assert.throws(() => readEventList(db, { limit: 10 }), { code: "projection_pending" });
    backfillEventSummaryReadIndex(db);
    assert.doesNotThrow(() => assertEventSummaryReadIndexReady(db));
    assert.deepEqual(
      readEventList(db, { limit: 10 }).rows.map(({ revision }) => revision),
      [3, 2, 1],
    );
  } finally {
    db.close();
  }
});

test("an interrupted backfill resumes from the remaining pending rows without losing refs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(OLD_EVENT_SUMMARY);
    for (let revision = 1; revision <= 130; revision++)
      db.prepare("INSERT INTO event_summary VALUES (?, '{}', '{}', ?)").run(
        revision,
        row(revision, "task_created", [`task/task_${revision}`]),
      );
    ensureEventSummaryReadIndexColumns(db);
    db.exec(REPOSITORY_READ_TABLES_SQL);
    // Simulate a process that committed the first batch (64 rows) and then died.
    for (let revision = 1; revision <= 64; revision++)
      db.prepare("UPDATE event_summary SET row_json = row_json WHERE workspace_revision = ?").run(revision);
    assert.throws(() => readEventList(db, { limit: 10 }), { code: "projection_pending" });
    backfillEventSummaryReadIndex(db);
    assert.doesNotThrow(() => assertEventSummaryReadIndexReady(db));
    assert.equal(readEventList(db, { limit: 200 }).rows.length, 130);
    assert.equal(
      (
        db.prepare("SELECT count(*) AS pending FROM event_summary WHERE read_index_version < 1").get() as {
          pending: number;
        }
      ).pending,
      0,
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT count(*) AS total, count(DISTINCT entity_ref) AS unique_refs FROM event_summary_entity_ref WHERE workspace_revision = 1",
          )
          .get() as { total: number; unique_refs: number }
      ).total,
      2,
    );
  } finally {
    db.close();
  }
});

test("backfill counts the pending set once, not once per batch", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(OLD_EVENT_SUMMARY);
    for (let revision = 1; revision <= 200; revision++)
      db.prepare("INSERT INTO event_summary VALUES (?, '{}', '{}', ?)").run(
        revision,
        row(revision, "task_created", [`task/task_${revision}`]),
      );
    ensureEventSummaryReadIndexColumns(db);
    db.exec(REPOSITORY_READ_TABLES_SQL);
    const instrumented = db as unknown as { prepare: (sql: string) => ReturnType<DatabaseSync["prepare"]> },
      originalPrepare = instrumented.prepare.bind(db);
    let countExecutions = 0;
    instrumented.prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      if (/count\(\*\)/u.test(sql)) {
        const all = statement.all.bind(statement);
        (statement as unknown as { all: typeof all }).all = (...args: Parameters<typeof all>) => {
          countExecutions += 1;
          return all(...args);
        };
      }
      return statement;
    };
    backfillEventSummaryReadIndex(db);
    assert.equal(countExecutions, 1);
    assert.equal(
      (
        db.prepare("SELECT count(*) AS pending FROM event_summary WHERE read_index_version < 1").get() as {
          pending: number;
        }
      ).pending,
      0,
    );
  } finally {
    db.close();
  }
});

test("a read-only connection fails closed during backfill and sees the complete cut afterward", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ha-event-summary-")),
    database = path.join(directory, "projection.sqlite");
  let writer: DatabaseSync | undefined, reader: DatabaseSync | undefined;
  try {
    writer = new DatabaseSync(database);
    writer.exec(OLD_EVENT_SUMMARY);
    for (let revision = 1; revision <= 70; revision++)
      writer
        .prepare("INSERT INTO event_summary VALUES (?, '{}', '{}', ?)")
        .run(revision, row(revision, "task_created", [`task/task_${revision}`]));
    ensureEventSummaryReadIndexColumns(writer);
    writer.exec(REPOSITORY_READ_TABLES_SQL);
    reader = new DatabaseSync(database, { readOnly: true });
    assert.throws(() => readEventList(reader!, { limit: 10 }), { code: "projection_pending" });
    reader.close();
    reader = undefined;
    backfillEventSummaryReadIndex(writer);
    reader = new DatabaseSync(database, { readOnly: true });
    assert.deepEqual(
      readEventList(reader, { limit: 2 }).rows.map(({ revision }) => revision),
      [70, 69],
    );
  } finally {
    reader?.close();
    writer?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
