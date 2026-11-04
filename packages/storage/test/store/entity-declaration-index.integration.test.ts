// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { openSqliteEventStore, sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { readSqliteEntityDeclarations } from "../../src/store/sqlite-entity-declarations.ts";
import { openEntityStore } from "../../src/store/entity-store.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { assertEntityFactory } from "../entity-factory.assertions.ts";
import { bundle, eventAt } from "./task-event-store.fixtures.ts";

test("SQLite current declarations skip tombstones and writer catch-up repairs an old index", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const repoId = "sqlite-entity-index",
      store = makeTaskEventStore({ rootDir, repoId });
    const database = new DatabaseSync(sqliteLedgerPath(rootDir));
    let reopened: ReturnType<typeof openSqliteEventStore> | undefined;
    try {
      assertEntityFactory({ store, open: () => openEntityStore(rootDir) });
      database.exec(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<100000)
        INSERT INTO entity_declaration_head SELECT 'agent','deleted-' || value,'{"declaration":null,"retirement":null}',0 FROM n`);
      database.exec("ANALYZE entity_declaration_head");
      const plans: unknown[] = [];
      const query = (sql: string, values: readonly (string | number | null)[] = []) => {
        if (sql.includes("SELECT state_json")) plans.push(database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values));
        return database.prepare(sql).all(...values);
      };
      const before = readSqliteEntityDeclarations(query, { kind: "agent" });
      assert.equal(before.length, 1);
      assert.match(JSON.stringify(plans), /entity_declaration_live/u);
      process.stdout.write(`SQLITE_ENTITY_INDEX ${JSON.stringify(plans)}\n`);
      database.exec("DELETE FROM entity_declaration_head; UPDATE entity_declaration_meta SET revision=0");
      const reader = openEntityStore(rootDir);
      try {
        assert.throws(() => reader.get("agent", "factory-agent"), { code: "projection_pending" });
        store.append(bundle(eventAt(6)));
        assert.throws(() => reader.get("agent", "factory-agent"), { code: "projection_pending" });
      } finally {
        reader.close();
      }
      await store.drain();
      reopened = openSqliteEventStore({ rootInput: rootDir, repoId });
      assert.deepEqual(reopened.readEntityDeclarations({ kind: "agent" }), before);
    } finally {
      reopened?.close();
      database.close();
      await store.drain();
    }
  });
});
