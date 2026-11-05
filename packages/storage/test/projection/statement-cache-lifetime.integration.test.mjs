// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { queryObjects, getHeapStatistics } from "node:v8";
import { prepareQuery } from "../../src/projection/rebuildable-task-projection-sql.ts";
import {
  closeDatabase,
  closeQueryOnlyReader,
  countQueryOnlyProjectionOpens,
  withDatabase,
  withQueryOnlyDatabaseSession,
} from "../../src/projection/rebuildable-task-projection-database.ts";

async function retainedDatabases() {
  // Statements first release native owner references; a later GC collects their database wrappers.
  for (let turn = 0; turn < 3; turn++) {
    queryObjects(DatabaseSync);
    await setImmediate();
  }
  return queryObjects(DatabaseSync);
}

test("a live projection connection prepares queries again after statement collection", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-statement-reuse-"));
  const file = path.join(root, "projection.sqlite");
  const readHead = () => null;
  const seed = new DatabaseSync(file);
  seed.close();
  const before = countQueryOnlyProjectionOpens();
  try {
    for (let round = 0; round < 3; round++) {
      withQueryOnlyDatabaseSession(file, readHead, (db) => {
        const first = prepareQuery(db, "SELECT 1 AS value");
        assert.equal(prepareQuery(db, "SELECT 1 AS value"), first, "a live statement is reused");
        assert.equal(first.get().value, 1);
      });
      await retainedDatabases();
    }
    assert.equal(countQueryOnlyProjectionOpens(), before + 1, "statement collection must preserve the live connection");
  } finally {
    closeQueryOnlyReader(file);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function directCycle() {
  const db = new DatabaseSync(":memory:");
  const statement = db.prepare("SELECT 1 AS value");
  assert.equal(statement.get().value, 1);
  db.close();
}

for (const kind of ["query-only", "writer"]) {
  test(`closed ${kind} projection statements release their native database owners`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-statement-owner-"));
    const file = path.join(root, "projection.sqlite");
    const readHead = () => null;
    const seed = new DatabaseSync(file);
    seed.close();
    try {
      const before = await retainedDatabases();
      for (let index = 0; index < 80; index++) directCycle();
      const direct = await retainedDatabases();
      for (let index = 0; index < 80; index++) {
        const use = kind === "query-only" ? withQueryOnlyDatabaseSession : withDatabase;
        use(file, readHead, (db) => assert.equal(prepareQuery(db, "SELECT 1 AS value").get().value, 1));
        if (kind === "query-only") closeQueryOnlyReader(file);
        else closeDatabase(file, readHead);
      }
      const cached = await retainedDatabases();
      console.log(
        "STATEMENT_OWNER_PROBE " + JSON.stringify({ kind, before, direct, cached, heap: getHeapStatistics() }),
      );
      assert.equal(direct, before, "uncached SQLite wrappers are collected after close");
      assert.equal(cached, before, "closed projections must release the SQL cache's native statement owner references");
    } finally {
      closeQueryOnlyReader(file);
      closeDatabase(file, readHead);
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
}
