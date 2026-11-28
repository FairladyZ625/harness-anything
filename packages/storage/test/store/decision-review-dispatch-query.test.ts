// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { insertEventIndexRow } from "../../src/projection/bulk-rebuild-state.ts";
import { createProjectionTables } from "../../src/projection/projection-tables.ts";
import { repositoryEventQueries } from "../../src/projection/repository-event-queries.ts";

test("SQLite seeks both decision dispatch indexes and reads the batch without outcome lookups", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  createProjectionTables(db);
  const eventsByRevision = new Map<number, PersistedCanonicalEventV1>();
  for (const [index, kind, decisionId] of [
    [1, "decision", "dec_B"],
    [2, "task", "dec_A"],
    [3, "decision", "dec_A"],
    [4, "decision", "dec_elsewhere"],
  ] as const) {
    const event = {
      schema: "agent-runtime-event/v1",
      type: "runtime_dispatch_requested",
      payload: { dispatchId: `dispatch-${index}`, reviewTarget: { kind, decisionId } },
    } as unknown as PersistedCanonicalEventV1;
    eventsByRevision.set(index, event);
    insertEventIndexRow(db, `op-${index}`, index, null, JSON.stringify(event), event);
  }
  const prepare = db.prepare.bind(db);
  const reads: Array<{ sql: string; args: unknown[] }> = [];
  t.mock.method(db, "prepare", (sql: string) => {
    const statement = prepare(sql);
    for (const method of ["all", "get"] as const) {
      const read = statement[method].bind(statement);
      t.mock.method(statement, method, (...args: Parameters<typeof read>) => {
        reads.push({ sql, args });
        return read(...args);
      });
    }
    return statement;
  });
  const queries = repositoryEventQueries(
    (read) => read(db, { status: "ready", watermark: 4, sourceRevision: 4 }),
    (revisions) =>
      new Map(revisions.flatMap((rev) => (eventsByRevision.has(rev) ? [[rev, eventsByRevision.get(rev)!]] : []))),
  );
  assert.deepEqual(queries.readRuntimeDispatchesByDecisions([]), []);
  assert.equal(reads.length, 0);
  const events = queries.readRuntimeDispatchesByDecisions([
    "dec_A",
    "dec_B",
    "dec_A",
    ...Array.from({ length: 1_001 }, (_, index) => `dec_missing_${index}`),
  ]);
  assert.deepEqual(
    events.map(({ payload }) => payload.dispatchId),
    ["dispatch-1", "dispatch-3"],
  );
  assert.equal(reads.length, 1);
  assert.deepEqual(
    queries.readRuntimeDispatchesByDecision("dec_A").map(({ event }) => event.payload.dispatchId),
    ["dispatch-2", "dispatch-3"],
  );
  const plans = reads.map(({ sql, args }) =>
    prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(args as Parameters<ReturnType<typeof prepare>["all"]>))
      .map(({ detail }) => detail)
      .join("\n"),
  );
  assert.match(
    plans[0]!,
    /SEARCH event_index USING (?:COVERING )?INDEX event_index_decision_review_dispatch \(review_target_decision_id=\?\)/u,
  );
  assert.match(
    plans[1]!,
    /SEARCH event_index USING (?:COVERING )?INDEX event_index_runtime_review_decision \(review_target_decision_id=\?\)/u,
  );
});
