// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync, StatementSync } from "node:sqlite";
import test from "node:test";
import { openTodoValueEquals, type AgentRuntimeEventV1 } from "@harness-anything/kernel";
import { createProjectionTables } from "../../src/projection/projection-tables.ts";
import { repositoryEventQueries } from "../../src/projection/repository-event-queries.ts";
import { countEntityProjectionRows } from "../../src/projection/rebuildable-task-projection-entities.ts";

/** Count the rows the statements actually returned, proving the filter ran inside SQL. */
function countStatementRows(run: () => void): number {
  let rows = 0;
  const original = StatementSync.prototype.all;
  StatementSync.prototype.all = function all(this: StatementSync, ...args: unknown[]) {
    const result = original.apply(this, args as never) as unknown;
    rows += Array.isArray(result) ? result.length : result === undefined ? 0 : 1;
    return result;
  };
  try {
    run();
  } finally {
    StatementSync.prototype.all = original;
  }
  return rows;
}

function runtimeEvent(
  revision: number,
  type: AgentRuntimeEventV1["type"],
  runtimeSessionId: string,
): AgentRuntimeEventV1 {
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    actor: { principal: { personId: "person-bounded" }, executor: null },
    source: "local",
    occurredAt: new Date(Date.UTC(2026, 10, 7, 0, 0, revision)).toISOString(),
    type,
    payload: { runtimeSessionId } as never,
  } as AgentRuntimeEventV1;
}

test("type-filtered session event read returns one matching row, not the session's whole history", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createProjectionTables(db);
    const insert = db.prepare(
        "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)",
      ),
      sessionId = "runtime-session-bounded";
    let revision = 1;
    for (; revision <= 60; revision += 1) {
      const event = runtimeEvent(revision, "runtime_session_liveness_changed", sessionId);
      insert.run(event.opId, revision, null, JSON.stringify(event));
    }
    const outcome = runtimeEvent(revision, "runtime_session_outcome_observed", sessionId);
    insert.run(outcome.opId, revision, null, JSON.stringify(outcome));
    const otherSession = runtimeEvent(++revision, "runtime_session_outcome_observed", "runtime-session-other");
    insert.run(otherSession.opId, revision, null, JSON.stringify(otherSession));

    const queries = repositoryEventQueries((read) =>
        read(db, { status: "ready", watermark: revision, sourceRevision: revision }),
      ),
      legacy = queries.readRuntimeSessionEvents(sessionId, 0, Number.MAX_SAFE_INTEGER);

    assert.equal(legacy.length, 61, "the legacy full read sees every event in the session");
    let bounded: readonly AgentRuntimeEventV1[] = [],
      rowsRead = 0;
    rowsRead = countStatementRows(() => {
      bounded = queries.readRuntimeSessionEventsByType(sessionId, ["runtime_session_outcome_observed"]);
    });
    assert.equal(rowsRead, 1, "SQL returns only the requested type, not the session's history");
    assert.deepEqual(
      bounded.map(({ type, workspaceRevision }) => [type, workspaceRevision]),
      [["runtime_session_outcome_observed", revision - 1]],
    );
    assert.deepEqual(queries.readRuntimeSessionEventsByType(sessionId, ["runtime_session_exited"]), []);
  } finally {
    db.close();
  }
});

test("entity count filters in SQL and returns one aggregate row for a large todo collection", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE entity_projection (
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        workspace_revision INTEGER NOT NULL,
        freshness TEXT NOT NULL,
        current_version,
        value_json TEXT NOT NULL,
        PRIMARY KEY(entity_kind, task_id, entity_id)
      )`);
    const insert = db.prepare(
      "INSERT INTO entity_projection(entity_kind, entity_id, task_id, workspace_revision, freshness, current_version, value_json) VALUES ('todo', ?, '', 1, 'current', 1, ?)",
    );
    for (let index = 0; index < 500; index += 1)
      insert.run(
        `todo-${index}`,
        JSON.stringify({
          id: `todo-${index}`,
          text: "bounded",
          completed: index % 2 === 0,
          archived: index % 5 === 0,
        }),
      );
    let count = 0,
      rowsRead = 0;
    rowsRead = countStatementRows(() => {
      count = countEntityProjectionRows(db, "todo", openTodoValueEquals);
    });
    assert.equal(count, 200, "only unfinished, unarchived todos are open");
    assert.equal(rowsRead, 1, "an aggregate count is one row regardless of collection size");
    assert.equal(countEntityProjectionRows(db, "todo", {}), 500);
    assert.equal(countEntityProjectionRows(db, "todo", { completed: true }), 250);
    assert.throws(() => countEntityProjectionRows(db, "todo", { "completed; DROP TABLE todo": true }), /identifier/u);
  } finally {
    db.close();
  }
});
