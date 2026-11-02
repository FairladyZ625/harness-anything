// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { startManagedPostgresFixture } from "../postgres/managed-postgres.fixture.ts";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS } from "../../src/postgres/event-ledger-schema.ts";
import { ensurePgProjectionSchema } from "../../src/pg/pg-projection-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { openSqliteMigrationEndpoint } from "../../src/migration/sqlite-endpoint.ts";
import { openPgMigrationEndpoint } from "../../src/migration/postgres-endpoint.ts";
import { migrateStorage } from "../../src/migration/engine.ts";
import { bundle, docBundle, eventAt, initRepo } from "../store/task-event-store.fixtures.ts";

const repoId = "migration",
  scope = { tenantId: "migration-tenant", projectId: "migration-project", readers: [], policyEpoch: 0 };
test("real PostgreSQL: SQLite roundtrip preserves event/blob bytes, outcomes, cut and projection; old authority rejects", async () => {
  const fixture = await startManagedPostgresFixture(),
    root = mkdtempSync(path.join(tmpdir(), "ha-storage-switch-")),
    sourceRoot = path.join(root, "source"),
    targetRoot = path.join(root, "target");
  let source: ReturnType<typeof openSqliteMigrationEndpoint> | undefined,
    target: ReturnType<typeof openSqliteMigrationEndpoint> | undefined;
  try {
    process.stdout.write(`MIGRATION_SERVER ${(await fixture.adminPool.query("SELECT version() AS v")).rows[0].v}\n`);
    await withPostgresTransaction(fixture.adminPool, async (client) => {
      for (const sql of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) await client.query(sql);
      await ensurePgProjectionSchema(client);
    });
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(targetRoot, { recursive: true });
    initRepo(sourceRoot);
    initRepo(targetRoot);
    const writer = makeTaskEventStore({ repoId, rootDir: sourceRoot });
    writer.append(bundle(eventAt(1)));
    writer.append(docBundle(writer, "台账\0😀\n", 2, "OP-DOC", "docs/value.md"));
    await writer.drain();
    source = openSqliteMigrationEndpoint({ rootDir: sourceRoot, repoId, scope });
    target = openSqliteMigrationEndpoint({ rootDir: targetRoot, role: "target", repoId, scope });
    const pg = await openPgMigrationEndpoint({ pool: fixture.adminPool, repoId, scope }),
      before = await source.export("forward");
    const forwardInput = {
      repoId,
      runId: "forward",
      source,
      target: pg,
      exportDirectory: path.join(root, "forward"),
    };
    await assert.rejects(
      migrateStorage({
        ...forwardInput,
        checkpoint(boundary) {
          if (boundary === "source_sealed") throw new Error("PG sealed crash");
        },
      }),
      /PG sealed crash/,
    );
    assert.equal((await source.state())!.phase, "source_sealed");
    await assert.rejects(
      migrateStorage({
        ...forwardInput,
        mode: "resume",
        target: {
          ...pg,
          async change(expected, next, activate) {
            if (activate) throw new Error("PG marker write failure");
            return pg.change(expected, next, activate);
          },
        },
      }),
      /PG marker write failure/,
    );
    assert.equal((await source.state())!.phase, "activation_failed");
    assert.equal((await pg.state())!.phase, "activation_failed");
    assert.equal(await pg.marker("forward"), false);
    process.stdout.write(
      "MIGRATION_PG_RECOVERY source_sealed crash; activation_failed persisted; marker absent; retry\n",
    );
    const reopenedPg = await openPgMigrationEndpoint({ pool: fixture.adminPool, repoId, scope });
    const forward = await migrateStorage({ ...forwardInput, target: reopenedPg, mode: "resume" });
    assert.equal(forward.phase, "target_activated");
    assert.deepEqual(await pg.export("forward"), before);
    assert.equal(await pg.marker("forward"), true);
    const stale = makeTaskEventStore({ repoId, rootDir: sourceRoot });
    assert.throws(() => stale.append(bundle(eventAt(3))), /storage_migration_read_only/);
    await stale.drain();
    await fixture.adminPool.query(
      "INSERT INTO ha_projection_values(tenant_id,project_id,policy_epoch,model,entity_id,owner_id,workspace_revision,value) VALUES($1,$2,0,'rogue-model','orphan','',1,'{}')",
      [scope.tenantId, scope.projectId],
    );
    await assert.rejects(pg.export("corruption-probe"), { code: "storage_migration_mismatch" });
    await fixture.adminPool.query("DELETE FROM ha_projection_values WHERE model='rogue-model'");
    process.stdout.write("MIGRATION_PROJECTION_CORRUPTION unlisted model row refused before freeze\n");
    const backwardInput = {
      repoId,
      runId: "backward",
      source: pg,
      target,
      exportDirectory: path.join(root, "backward"),
    };
    await assert.rejects(
      migrateStorage({
        ...backwardInput,
        source: {
          ...pg,
          async change(expected, next, activate) {
            if (next.phase === "freezing")
              await fixture.adminPool.query("UPDATE ha_repo_heads SET writer_epoch=writer_epoch+50 WHERE repo_id=$1", [
                repoId,
              ]);
            return pg.change(expected, next, activate);
          },
        },
      }),
      { code: "storage_migration_conflict" },
    );
    assert.equal((await pg.state())!.runId, "forward");
    process.stdout.write("MIGRATION_PG_EPOCH_RACE unchanged event cut; newer epoch preserved; takeover refused\n");
    await assert.rejects(
      migrateStorage({
        ...backwardInput,
        checkpoint(boundary) {
          if (boundary === "source_frozen") throw new Error("PG freeze interruption");
        },
      }),
      /PG freeze interruption/,
    );
    assert.equal((await reopenedPg.state())!.phase, "freezing");
    process.stdout.write("MIGRATION_PG_RECOVERY source freeze interruption; reopened endpoint resumes\n");
    const backward = await migrateStorage({ ...backwardInput, source: reopenedPg, mode: "resume" });
    assert.equal(backward.phase, "target_activated");
    assert.deepEqual(await target.export("backward"), before);
    assert.notEqual((await pg.state())!.phase, "source_resumed");
    process.stdout.write(
      `MIGRATION_ROUNDTRIP ${JSON.stringify(before.map((t) => ({ cut: t.cut, events: t.events.length, blobs: t.blobs.length })))}\n`,
    );
  } finally {
    await source?.close();
    await target?.close();
    rmSync(root, { recursive: true, force: true });
    await fixture.close();
  }
});
