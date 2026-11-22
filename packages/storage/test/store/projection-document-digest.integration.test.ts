// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  canonicalJson,
  hashCanonicalJsonTextFieldChunks,
  prepareQuery,
  readStateDigest,
  withProjectionSqlHeartbeat,
} from "../../src/projection/rebuildable-task-projection-sql.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { initRepo } from "./task-event-store.fixtures.ts";
import { withTempStoreAsync } from "./helpers.ts";

const legacyStateDigestTables = [
  ["event_index", "op_id"],
  ["event_summary", "workspace_revision"],
  ["artifact_entity_state", "entity_kind, entity_id"],
  ["document", "path"],
  ["document_history", "path"],
  ["materialization_hold", "owner_ref, relation_id"],
  ["preset_snapshot", "digest"],
  ["runtime_installation", "installation_id"],
  ["runtime_session", "runtime_session_id"],
  ["task_snapshot", "task_id"],
  ["task_package", "task_id"],
  ["task_generation", "task_id"],
  ["task_relation", "relation_id"],
  ["task_progress", "workspace_revision"],
  ["entity_projection", "entity_kind, task_id, entity_id"],
  ["archived_entity", "entity_kind, entity_id"],
  ["edge", "task_id, edge_id, iteration"],
  ["lease_cas", "task_id"],
  ["lease_interval", "task_id, execution_id, acquired_revision"],
  ["fact", "fact_id"],
  ["relation_edge", "relation_id"],
  ["decision", "decision_id"],
  ["decision_option", "decision_id, kind, option_id"],
  ["decision_claim", "decision_id, claim_id"],
  ["decision_judgment_consent", "consent_id"],
  ["decision_amendment", "amendment_id"],
  ["decision_content_pin", "pin_id"],
  ["decision_review_event", "event_id"],
  ["dispatch_lifecycle_group", "attempt_group_id"],
  ["dispatch_lifecycle_attempt", "runtime_session_id"],
  ["dispatch_lifecycle_task_lease", "task_id"],
  ["inbox_item", "inbox_id, item_id"],
] as const;

const chunkBytes = 1024 * 1024;

test("overlapping projection opens cannot feed another repository's watchdog", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const first = new BigInt64Array(new SharedArrayBuffer(8)),
      second = new BigInt64Array(new SharedArrayBuffer(8)),
      resume = Promise.withResolvers<void>(),
      detached = Promise.withResolvers<void>(),
      query = () => prepareQuery(db, "SELECT 1").get();
    let delayedQuery: Promise<unknown> | undefined;
    const opening = withProjectionSqlHeartbeat(first.buffer as SharedArrayBuffer, async () => {
      await resume.promise;
      query();
      delayedQuery = detached.promise.then(query);
    });
    await withProjectionSqlHeartbeat(second.buffer as SharedArrayBuffer, query);
    const secondProgress = Atomics.load(second, 0);
    assert.ok(secondProgress > 0n);
    assert.equal(Atomics.load(first, 0), 0n);
    resume.resolve();
    await opening;
    const firstProgress = Atomics.load(first, 0);
    assert.ok(firstProgress > 0n);
    assert.equal(Atomics.load(second, 0), secondProgress);
    detached.resolve();
    await delayedQuery;
    assert.equal(Atomics.load(first, 0), firstProgress);
  } finally {
    db.close();
  }
});

test("SQLite state digest preserves legacy bytes with one ordered cursor per document table", async (context) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "state-digest-equivalence", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      initialized = projection.catchUp(),
      db = new DatabaseSync(projection.path),
      escaped = 'quotes" slash/ nul\0 newline\n snow 雪',
      large = JSON.stringify({ body: `${"x".repeat(chunkBytes - 10)}😀${escaped}${"y".repeat(chunkBytes)}` }),
      small = JSON.stringify({ body: escaped });
    try {
      assert.equal(Buffer.byteLength(large.slice(0, large.indexOf("😀"))), chunkBytes - 1);
      assert.equal(initialized.watermark, 0);
      for (const table of ["document", "document_history"]) {
        const insert = db.prepare(`INSERT INTO ${table}(path, workspace_revision, value_json) VALUES (?, ?, ?)`);
        insert.run("tasks/z-small.md", 3, small);
        insert.run("tasks/a-large.md", 4, large);
      }
      const prepared = context.mock.method(db, "prepare");
      const actual = readStateDigest(db, 0);
      const documentQueries = prepared.mock.calls
        .map(({ arguments: [sql] }) => sql)
        .filter((sql) => /\bFROM document(?:_history)?\b/iu.test(sql));
      prepared.mock.restore();
      assert.equal(documentQueries.length, 2, documentQueries.join("\n"));
      assert.match(documentQueries[0]!, /FROM document ORDER BY path$/u);
      assert.match(documentQueries[1]!, /FROM document_history ORDER BY path$/u);
      assert.ok(documentQueries.every((sql) => !/\bsubstr\s*\(/iu.test(sql)));
      assert.notEqual(actual, null);
      let legacy = sha256Text("task-projection-state/v1");
      for (const [table, order] of legacyStateDigestTables) {
        legacy = sha256Text(`${legacy}\n${table}`);
        if (table === "document" || table === "document_history") {
          const rows = db
            .prepare(
              `SELECT path, workspace_revision, length(CAST(value_json AS BLOB)) AS value_json_bytes FROM ${table} ORDER BY path`,
            )
            .all() as { path: string; workspace_revision: number; value_json_bytes: number }[];
          const chunks = db.prepare(
            `SELECT substr(CAST(value_json AS BLOB), ?, ?) AS chunk FROM ${table} WHERE path = ?`,
          );
          for (const row of rows) {
            function* readLegacyChunks(): Iterable<Uint8Array> {
              for (let offset = 0; offset < row.value_json_bytes; offset += chunkBytes)
                yield (chunks.get(offset + 1, chunkBytes, row.path) as { chunk: Uint8Array }).chunk;
            }
            legacy = hashCanonicalJsonTextFieldChunks(
              legacy,
              { path: row.path, workspace_revision: row.workspace_revision, value_json: "" },
              "value_json",
              readLegacyChunks(),
            );
          }
        } else {
          for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate())
            legacy = sha256Text(`${legacy}\n${canonicalJson(row)}`);
        }
      }
      assert.equal(actual, `sha256:${legacy}`);
    } finally {
      db.close();
      projection.close();
    }
  });
});
