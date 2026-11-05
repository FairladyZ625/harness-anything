// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createProjectionTables } from "../../src/projection/projection-tables.ts";
import {
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
