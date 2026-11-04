// harness-test-tier: integration
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import {
  POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS,
  POSTGRES_EVENT_LEDGER_TABLES,
} from "../../src/postgres/event-ledger-schema.ts";
import { PG_PROJECTION_TABLES, ensurePgProjectionSchema } from "../../src/pg/pg-projection-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { startManagedPostgresFixture } from "../postgres/managed-postgres.fixture.ts";
import { assertRepositoryMigrationFence } from "./repository-fence.assertions.ts";
import { openPgMigrationEndpoint } from "../../src/migration/postgres-endpoint.ts";
import { migrateStorage } from "../../src/migration/engine.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { makePostgresTaskEventStore } from "../../src/postgres/pg-task-event-store.ts";
import { materializePgProjectionEvents } from "../../src/pg/pg-task-event-materialize.ts";
import { bundle, eventAt } from "../store/task-event-store.fixtures.ts";

test("real PostgreSQL repository migration fence covers new tuples", async (t) => {
  const fixture = await startManagedPostgresFixture();
  let target: Pool | undefined, runtime: Pool | undefined;
  try {
    await fixture.adminPool.query("CREATE DATABASE migration_target");
    target = new Pool({
      host: "127.0.0.1",
      port: fixture.port,
      user: "postgres",
      database: "migration_target",
      max: 2,
    });
    for (const pool of [fixture.adminPool, target])
      await withPostgresTransaction(pool, async (client) => {
        for (const sql of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) await client.query(sql);
        await ensurePgProjectionSchema(client, { indexBuild: "isolated" });
      });
    await fixture.adminPool.query("CREATE ROLE dm1_runtime LOGIN NOSUPERUSER NOBYPASSRLS");
    await fixture.adminPool.query("GRANT USAGE ON SCHEMA public TO dm1_runtime");
    for (const table of [...POSTGRES_EVENT_LEDGER_TABLES, ...PG_PROJECTION_TABLES])
      await fixture.adminPool.query(`GRANT SELECT, INSERT, UPDATE ON ${table} TO dm1_runtime`);
    for (const table of PG_PROJECTION_TABLES) await fixture.adminPool.query(`GRANT DELETE ON ${table} TO dm1_runtime`);
    runtime = new Pool({ host: "127.0.0.1", port: fixture.port, user: "dm1_runtime", database: "postgres", max: 2 });
    await assert.rejects(runtime.query("SELECT * FROM ha_repo_writer_epochs"), { code: "42501" });
    await assert.rejects(runtime.query("UPDATE ha_repo_writer_epochs SET migration_control=NULL"), { code: "42501" });
    await assert.rejects(runtime.query("SELECT public.ha_inherit_repo_writer_epoch()"), { code: "42501" });
    await assertRepositoryMigrationFence(t, { source: fixture.adminPool, target, runtime, backend: "postgres" });
    await t.test("in-flight tuple creation holds takeover; its committed event enters the retried cut", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-freeze-phantom-")),
        repoId = "freeze-phantom",
        scope = { tenantId: "race-a", projectId: "race", readers: [], policyEpoch: 0 },
        newScope = { ...scope, tenantId: "race-b" },
        inspector = new Pool({ ...runtime!.options, user: "postgres", max: 1 });
      try {
        await createPgStorageBackend({ pool: runtime!, repoId, scope }).eventStore.append(bundle(eventAt(1)), 0, {
          repoId,
          holderId: "seed",
          epoch: 1,
        });
        const source = await openPgMigrationEndpoint({ pool: fixture.adminPool, repoId, scope }),
          destination = await openPgMigrationEndpoint({ pool: target!, repoId, scope }),
          args = { repoId, source, target: destination, runId: "race", exportDirectory: root };
        await assert.rejects(
          migrateStorage({
            ...args,
            source: {
              ...source,
              async change(expected, next, activate) {
                if (next.phase !== "freezing") return source.change(expected, next, activate);
                const entered = Promise.withResolvers<void>(),
                  release = Promise.withResolvers<void>(),
                  writer = makePostgresTaskEventStore({
                    pool: runtime!,
                    repoId,
                    scope: newScope,
                    async project(client, value) {
                      await materializePgProjectionEvents(client, newScope, value);
                      entered.resolve();
                      await release.promise;
                    },
                  }),
                  append = writer.append(bundle(eventAt(1)), 0, { repoId, holderId: "concurrent", epoch: 1 });
                await entered.promise;
                let finished = false;
                const freezing = source.change(expected, next, activate).then(
                  () => {
                    finished = true;
                    return null;
                  },
                  (error: unknown) => {
                    finished = true;
                    return error;
                  },
                );
                try {
                  let blocked = false;
                  while (!finished && !blocked) {
                    const locks = await inspector.query(
                      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%ha_repo_writer_epochs%FOR UPDATE%'",
                    );
                    blocked = locks.rows.length > 0;
                  }
                  assert.equal(
                    blocked,
                    true,
                    "takeover must wait for the accepting transaction, including its new tuple",
                  );
                } finally {
                  release.resolve();
                  await append;
                }
                const error = await freezing;
                assert.ok(error, "the now-committed tuple invalidates the preflight cut");
                throw error;
              },
            },
          }),
          { code: "storage_migration_mismatch" },
        );
        assert.equal(await source.state(), null);
        assert.equal(await destination.marker("race"), false);
        const before = await source.export("race");
        assert.equal(before.length, 2);
        assert.equal(
          before.reduce((n, tuple) => n + tuple.events.length, 0),
          2,
        );
        await migrateStorage(args);
        assert.deepEqual(await destination.export("race"), before);
        assert.equal(await destination.marker("race"), true);
        process.stdout.write(
          "DM1_POSTGRES_RACE shared repository epoch blocks takeover; changed cut refused; retry includes both tuples/events\n",
        );
      } finally {
        await inspector.end();
        rmSync(root, { recursive: true, force: true });
      }
    });
  } finally {
    await runtime?.end();
    await target?.end();
    await fixture.close();
  }
});
