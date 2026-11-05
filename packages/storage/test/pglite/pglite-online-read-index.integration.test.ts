// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { reduceDecisionDocument } from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import { proposal } from "../store/relation-graph-projection.fixtures.ts";
import { createPGliteTaskQueryReader } from "../../src/pglite/query-owner.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";

const scope = { tenantId: "online", projectId: "online", policyEpoch: 1 },
  repoId = "online";

pgliteIntegrationSuite("PGlite online read-index expansion", () => {
  for (const size of [10000, 100000]) {
    test(`owner opens ${size} historical events before any index/backfill page`, async (t) => {
      await withTempStoreAsync(async (root) => {
        const storage = { backend: "pglite" as const, dataDir: join(root, "db"), scope },
          original = await createPGliteStorageBackend({ repoId, storage });
        try {
          await seed(original, size, size / 100);
        } finally {
          await original.close();
        }
        const started = performance.now(),
          reader = createPGliteTaskQueryReader({ repoId, storage, scope });
        const attachedMs = performance.now() - started;
        try {
          assert.equal(
            reader.withSession((q) => q.readDecision("dec_000001", false)).decision?.decisionId,
            "dec_000001",
          );
          const readAvailableMs = performance.now() - started;
          assert.equal(reader.withSession((q) => q.readScheduleEvents("target")).events.length, 1);
          assert.equal(reader.withSession((q) => q.listDecisions({ state: "proposed", limit: 1 })).decisions.length, 1);
          t.diagnostic(
            `PGLITE_OWNER_ATTACH ${JSON.stringify({ events: size, decisions: size / 100, attachedMs, readAvailableMs })}`,
          );
        } finally {
          reader.close();
        }
        let backend = await createPGliteStorageBackend({ repoId, storage });
        try {
          assert.equal(
            (
              await backend.pool.query(
                "SELECT count(*)::integer AS n FROM ha_decisions WHERE decision_sort_key IS NULL",
              )
            ).rows[0]!.n,
            size / 100,
            "opening must not drain Decision backfill",
          );
          const jobs = (
            await backend.pool.query(
              "SELECT table_name,cursor,complete FROM ha_pglite_index_backfill WHERE NOT complete ORDER BY table_name",
            )
          ).rows;
          assert.deepEqual(
            jobs.map((row) => row.table_name),
            ["ha_decisions", "ha_events"],
          );
          assert.ok(
            jobs.every((row) => row.cursor === null),
            "opening must not consume history",
          );
          assert.equal(
            (await backend.pool.query("SELECT to_regclass('ha_events_schema_revision') AS name")).rows[0]!.name,
            null,
            "attachment must not build the missing index on historical rows",
          );
          const staged = (await backend.pool.query("SELECT staging FROM ha_pglite_index_backfill WHERE NOT complete"))
            .rows;
          for (const { staging } of staged)
            assert.equal(
              (await backend.pool.query(`SELECT count(*)::integer AS n FROM ${staging}`)).rows[0]!.n,
              0,
              "trees created during attachment only receive empty input",
            );
          const first = await backend.backfillReadIndexes();
          assert.equal(first.processed, 64);
          const cursor = (
            await backend.pool.query("SELECT cursor FROM ha_pglite_index_backfill WHERE table_name='ha_decisions'")
          ).rows[0]!.cursor;
          await backend.close();
          backend = await createPGliteStorageBackend({ repoId, storage });
          assert.deepEqual(
            (await backend.pool.query("SELECT cursor FROM ha_pglite_index_backfill WHERE table_name='ha_decisions'"))
              .rows[0]!.cursor,
            cursor,
          );
          assert.equal((await backend.projection.listDecisions({ search: "needle", limit: 1 })).decisions.length, 1);
          assert.equal((await backend.projection.readScheduleEvents("target")).events.length, 1);
          assert.equal(
            (await backend.pool.query("SELECT count(*)::integer AS n FROM ha_events WHERE read_index_version=0"))
              .rows[0]!.n,
            size,
          );
          const canonical = (await backend.pool.query("SELECT event_json FROM ha_events WHERE revision=$1", [size]))
            .rows[0]!.event_json;
          let turns = 0,
            copied = 64;
          for (;;) {
            const page = await backend.backfillReadIndexes();
            assert.ok(page.processed <= 64);
            copied += page.processed;
            turns++;
            if (page.done) break;
            assert.ok(turns < 5000, "the captured upper bound makes background history finite");
            await nextTurn();
          }
          assert.equal(
            (await backend.pool.query("SELECT event_json FROM ha_events WHERE revision=$1", [size])).rows[0]!
              .event_json,
            canonical,
          );
          assert.equal((await backend.projection.readScheduleEvents("target")).events.length, 1);
          assert.equal((await backend.projection.listDecisions({ search: "needle", limit: 1 })).decisions.length, 1);
          assert.equal(
            (await backend.pool.query("SELECT count(*)::integer AS n FROM ha_pglite_index_backfill WHERE NOT complete"))
              .rows[0]!.n,
            0,
          );
          assert.deepEqual(await backend.backfillReadIndexes(), { processed: 0, done: true });
          t.diagnostic(`PGLITE_BACKGROUND_COMPLETE ${JSON.stringify({ events: size, copied, turns })}`);
        } finally {
          await backend.close();
        }
      });
    });
  }
  test("bounded pages publish indexes and Decision search across rollback, restart and foreground writes", async () => {
    await withTempStoreAsync(async (root) => {
      const storage = { backend: "pglite" as const, dataDir: join(root, "db"), scope };
      let backend = await createPGliteStorageBackend({ repoId, storage });
      try {
        await seed(backend, 130, 130);
        await backend.close();
        backend = await createPGliteStorageBackend({ repoId, storage });
        assert.equal((await backend.projection.listDecisions({ search: "needle", limit: 1 })).decisions.length, 1);
        const stage = (
          await backend.pool.query("SELECT staging FROM ha_pglite_index_backfill WHERE table_name='ha_decisions'")
        ).rows[0]!.staging;
        await backend.pool.query(`ALTER TABLE ${stage} ADD CONSTRAINT reject_page CHECK(decision_id<>'dec_000001')`);
        await assert.rejects(backend.backfillReadIndexes(), { code: "23514" });
        assert.equal(
          (await backend.pool.query("SELECT cursor FROM ha_pglite_index_backfill WHERE table_name='ha_decisions'"))
            .rows[0]!.cursor,
          null,
        );
        assert.equal((await backend.pool.query(`SELECT count(*)::integer AS n FROM ${stage}`)).rows[0]!.n, 0);
        await backend.pool.query(`ALTER TABLE ${stage} DROP CONSTRAINT reject_page`);
        let processed = 0,
          turns = 0;
        for (;;) {
          const page = await backend.backfillReadIndexes();
          assert.ok(page.processed <= 64);
          processed += page.processed;
          turns++;
          if (turns === 2) {
            await backend.pool.query(
              "UPDATE ha_decisions SET value=jsonb_set(value,'{title}','\"replacement\"') WHERE decision_id='dec_000001'",
            );
            await backend.pool.query("DELETE FROM ha_decisions WHERE decision_id='dec_000002'");
            await backend.pool
              .query(`INSERT INTO ha_decisions(tenant_id,project_id,policy_epoch,decision_id,workspace_revision,value)
              SELECT tenant_id,project_id,policy_epoch,'dec_000000',workspace_revision,value FROM ha_decisions WHERE decision_id='dec_000003'`);
            await backend.close();
            backend = await createPGliteStorageBackend({ repoId, storage });
          }
          if (page.done) break;
          assert.ok(turns < 100, "background work must terminate");
        }
        assert.ok(processed >= 130 + 129 + 130);
        assert.equal((await backend.projection.listDecisions({ search: "replacement" })).decisions.length, 1);
        assert.equal((await backend.projection.listDecisions({ legacyId: "E1" })).decisions.length, 0);
        assert.equal((await backend.projection.readScheduleEvents("target")).events.length, 1);
        assert.equal((await backend.pool.query("SELECT count(*)::integer AS n FROM ha_decisions")).rows[0]!.n, 130);
        assert.equal(
          (await backend.pool.query("SELECT count(*)::integer AS n FROM ha_pglite_index_backfill WHERE NOT complete"))
            .rows[0]!.n,
          0,
        );
        assert.deepEqual(await backend.backfillReadIndexes(), { processed: 0, done: true });
        // The replacement retains the canonical uniqueness/FK boundary and the exact bytes.
        await assert.rejects(backend.pool.query("UPDATE ha_events SET repo_id='missing' WHERE revision=1"), {
          code: "23503",
        });
        await assert.rejects(backend.pool.query("INSERT INTO ha_events SELECT * FROM ha_events LIMIT 1"), {
          code: "23505",
        });
        await backend.pool.query("CREATE ROLE ha_online_reader NOLOGIN");
        await backend.pool.query("GRANT SELECT ON ha_events,ha_decisions TO ha_online_reader");
        await withPostgresTransaction(
          backend.pool,
          async (client) => {
            await client.query("SET LOCAL ROLE ha_online_reader");
            for (const table of ["ha_events", "ha_decisions"])
              assert.equal((await client.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0]!.n, 0);
          },
          { ...scope, tenantId: "another-tenant" },
        );
        await backend.close();
        backend = await createPGliteStorageBackend({ repoId, storage });
        assert.deepEqual(await backend.backfillReadIndexes(), { processed: 0, done: true });
      } finally {
        await backend.close();
      }
    });
  });
});

async function seed(backend: Awaited<ReturnType<typeof createPGliteStorageBackend>>, size: number, decisions: number) {
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch];
  await backend.pool.query(
    `INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
    VALUES($1,$2,$3,'online',$4,'fixture','fixture','fixture')`,
    [...keys, size],
  );
  await backend.pool.query(
    `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
    VALUES($1,$2,$3,5,$4,$4)`,
    [...keys, size],
  );
  await backend.pool.query(
    `INSERT INTO ha_events(tenant_id,project_id,policy_epoch,repo_id,revision,op_id,event_id,event_type,event_digest,occurred_at,event_json)
    SELECT $1,$2,$3,'online',n,'event-'||n,'event-'||n,'schedule_created','fixture','2026-11-05',
      json_build_object('schema','schedule-event/v1','type','schedule_created','entity',json_build_object('id',CASE WHEN n=$4 THEN 'target' ELSE 'history' END),
        'opId','event-'||n,'eventId','event-'||n,'workspaceRevision',n,'occurredAt','2026-11-05')::text FROM generate_series(1,$4::integer)n`,
    [...keys, size],
  );
  const value = { ...reduceDecisionDocument(null, proposal(1, "dec_template")), title: "needle" };
  await backend.pool.query(
    `INSERT INTO ha_decisions(tenant_id,project_id,policy_epoch,decision_id,workspace_revision,value)
    SELECT $1,$2,$3,'dec_'||lpad(n::text,6,'0'),1,$4::jsonb FROM generate_series(1,$5::integer)n`,
    [...keys, JSON.stringify(value), decisions],
  );
  await backend.pool.query("UPDATE ha_events SET read_index_version=0,event_schema=NULL");
  await backend.pool.query("UPDATE ha_decisions SET decision_sort_key=NULL,decision_state=NULL,search_ready=false");
  await backend.pool.query("DROP INDEX ha_events_schema_revision");
  await backend.pool.query("DROP INDEX ha_decisions_page");
}
