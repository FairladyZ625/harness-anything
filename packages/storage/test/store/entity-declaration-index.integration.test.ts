// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { openSqliteEventStore, sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { readSqliteDirectoryClaims, readSqliteEntityDeclarations } from "../../src/store/sqlite-entity-declarations.ts";
import {
  compileEntityDeleted,
  compileEntityUpsert,
} from "@harness-anything/kernel/internal/domain/entity-event-compile.ts";
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
        INSERT INTO entity_declaration_head(entity_kind,entity_id,state_json,live) SELECT 'agent','deleted-' || value,'{"declaration":null,"retirement":null}',0 FROM n`);
      database.exec("ANALYZE entity_declaration_head");
      const plans: unknown[] = [];
      const query = (sql: string, values: readonly (string | number | null)[] = []) => {
        if (sql.includes("SELECT state_json")) plans.push(database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values));
        return database.prepare(sql).all(...values);
      };
      const before = readSqliteEntityDeclarations(query, { kind: "agent" });
      assert.equal(before.length, 1);
      assert.match(JSON.stringify(plans), /entity_declaration_live/u);
      assert.deepEqual(readSqliteDirectoryClaims(query), []);
      assert.match(
        JSON.stringify(
          database
            .prepare(
              "EXPLAIN QUERY PLAN SELECT directory_json FROM entity_declaration_head INDEXED BY entity_directory_heads WHERE directory_json IS NOT NULL ORDER BY entity_kind,entity_id",
            )
            .all(),
        ),
        /entity_directory_heads/u,
      );
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

test("SQLite upgrades old declaration indexes and retains directory retirements across reopen", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const repoId = "directory-index-upgrade",
      store = makeTaskEventStore({ rootDir, repoId }),
      envelope = (revision: number) => ({
        eventId: `directory-${revision}`,
        opId: `directory-${revision}`,
        workspaceRevision: revision,
        actor: { principal: { personId: "directory-test" }, executor: null },
        source: "local" as const,
        occurredAt: "2026-11-14T00:00:00.000Z",
      }),
      created = compileEntityUpsert({
        ...envelope(1),
        entityKind: "agent",
        entity: {
          schema: "agent-declaration/v1",
          id: "directory-agent",
          name: "Directory agent",
          instructions: "Check directory recovery",
          runtimes: [{ type: "codex" }],
        },
      });
    store.append(created);
    store.append(
      compileEntityDeleted({
        ...envelope(2),
        entityKind: "agent",
        entityId: "directory-agent",
        reason: "Retire owned directory",
        baseBlobSha256: created.event.payload.declarationDocumentClaim.sha256,
        heldDirectories: ["agents/directory-agent/empty"],
      }),
    );
    for (let revision = 3; revision <= 72; revision++) store.append(bundle(eventAt(revision)));
    await store.drain();
    const database = new DatabaseSync(sqliteLedgerPath(rootDir));
    database.exec(
      "DROP INDEX entity_directory_heads; ALTER TABLE entity_declaration_head DROP COLUMN directory_json; DELETE FROM attach_migration_scan_meta WHERE migration='entity-directory-working-set/v1'; UPDATE event_query_meta SET revision=0",
    );
    database.close();
    const read = () => {
      const reopened = openSqliteEventStore({ rootInput: rootDir, repoId });
      try {
        return reopened.directoryClaims();
      } finally {
        reopened.close();
      }
    };
    const expected = [
      { ownerRef: "agent/directory-agent", directories: [], retirements: ["agents/directory-agent/empty"] },
    ];
    assert.deepEqual(read(), expected);
    const lagged = new DatabaseSync(sqliteLedgerPath(rootDir));
    lagged.exec(
      "UPDATE entity_declaration_head SET directory_json=NULL; UPDATE attach_migration_scan_meta SET revision=1 WHERE migration='entity-directory-working-set/v1'",
    );
    lagged.close();
    assert.deepEqual(read(), expected, "a previous writer's directory-index gap is caught up in bounded pages");
    assert.deepEqual(read(), expected, "reopen preserves pending retirements without an event replay in materialize");
  });
});
