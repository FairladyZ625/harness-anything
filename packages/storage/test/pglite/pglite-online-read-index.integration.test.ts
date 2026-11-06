// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { reduceDecisionDocument } from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import { proposal } from "../store/relation-graph-projection.fixtures.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { backfillPGliteIndexPage } from "../../src/pglite/read-index-schema.ts";

const scope = { tenantId: "online", projectId: "online", policyEpoch: 1 },
  repoId = "online";
pgliteIntegrationSuite("PGlite online read-index expansion without table replacement", () => {
  test("latest lease read reports pending without throwing and switches only after backfill", async () => {
    await withTempStoreAsync(async (root) => {
      const backend = await createPGliteStorageBackend({
        repoId,
        storage: { backend: "pglite", dataDir: join(root, "db"), scope },
      });
      try {
        assert.deepEqual(await backend.projection.readLatestLeaseInterval("target"), {
          status: "ready",
          interval: null,
        });
        await backend.pool.query(
          `INSERT INTO ha_projection_values
          (tenant_id,project_id,policy_epoch,model,owner_id,entity_id,workspace_revision,value)
          VALUES($1,$2,$3,'lease-interval','target','1',1,
          '{"taskId":"target","executionId":"old","acquiredRevision":1,"releasedRevision":2}'),
          ($1,$2,$3,'lease-interval','target','3',3,
          '{"taskId":"target","executionId":"new","acquiredRevision":3,"releasedRevision":null}')`,
          [scope.tenantId, scope.projectId, scope.policyEpoch],
        );
        await backend.pool.query(
          "UPDATE ha_projection_values SET read_index_version=0,order_revision=NULL WHERE model='lease-interval'",
        );
        const pending = await backend.projection.readLatestLeaseInterval("target");
        assert.equal(pending.status, "pending");
        assert.match(pending.progress, /model=lease-interval/u);
        await assert.rejects(backend.projection.readLeaseIntervals("target"), { code: "projection_pending" });
        for (let turns = 0; ; turns++) {
          assert.ok(turns < 20);
          if ((await backend.backfillReadIndexes()).done) break;
        }
        const ready = await backend.projection.readLatestLeaseInterval("target");
        assert.equal(ready.status, "ready");
        assert.equal(ready.interval?.executionId, "new");
        assert.equal(ready.interval?.acquiredRevision, 3);
      } finally {
        await backend.close();
      }
    });
  });
  for (const size of [10000, 100000]) {
    test(`attach preserves OIDs and admits point reads with ${size} events`, async (t) => {
      await withTempStoreAsync(async (root) => {
        const storage = { backend: "pglite" as const, dataDir: join(root, "db"), scope };
        let backend = await createPGliteStorageBackend({ repoId, storage });
        try {
          await seed(backend, size, size / 100);
          const identity = async () =>
            (
              await backend.pool.query(`SELECT 'ha_events'::regclass::oid AS events,
            'ha_decisions'::regclass::oid AS decisions`)
            ).rows[0];
          const before = await identity();
          const canonical = (await backend.pool.query("SELECT event_json FROM ha_events WHERE revision=$1", [size]))
            .rows[0]!.event_json;
          await backend.close();
          const start = performance.now();
          backend = await createPGliteStorageBackend({ repoId, storage });
          const attachMs = performance.now() - start;
          assert.deepEqual(await identity(), before);
          assert.equal((await backend.projection.readDecision("dec_000001", false)).decision?.decisionId, "dec_000001");
          await assert.rejects(backend.projection.readScheduleEvents("target"), { code: "projection_pending" });
          await assert.rejects(backend.projection.listDecisions({ limit: 1 }), { code: "projection_pending" });
          assert.equal(
            (await backend.pool.query("SELECT count(*)::integer n FROM ha_events WHERE read_index_version=0")).rows[0]!
              .n,
            size,
          );
          assert.equal((await backend.projection.readCanonicalEvents(0, 1)).events.length, 1);
          assert.equal((await backend.projection.readEventWitness(size))?.workspaceRevision, size);
          assert.equal((await backend.projection.readEventList({ limit: 1 })).rows[0]?.revision, size);
          const primaryReads = async () => ({
            operation: await backend.projection.readOperation(`event-${size}`),
            taskOperation: await backend.projection.readTaskOperation(`event-${size}`),
            summaries: await backend.projection.readEventSummaries(size - 2, 1),
            fleet: await backend.projection.readEventSummaries(size - 2, 1, "fleet"),
          });
          const pendingReads = await primaryReads();
          assert.equal(pendingReads.operation?.event.opId, `event-${size}`);
          assert.equal(pendingReads.taskOperation, null);
          for (const page of [pendingReads.summaries, pendingReads.fleet]) {
            assert.equal(page.events.length, 1);
            assert.equal(page.events[0]?.workspaceRevision, size - 1);
          }
          const jobs = async () =>
            (await backend.pool.query("SELECT index_name,complete FROM ha_read_index_build ORDER BY index_name")).rows;
          assert.equal((await jobs()).filter((row) => !row.complete).length, 2);
          assert.equal(
            (await backend.pool.query("SELECT to_regclass('ha_events_schema_revision') name")).rows[0]!.name,
            null,
          );
          // A failed transaction rolls both DDL and completion back; no replacement relation exists.
          const beforeJobs = await jobs(),
            interrupted = new Error("rollback physical build");
          await assert.rejects(
            withPostgresTransaction(backend.pool, async (client) => {
              await backfillPGliteIndexPage(client);
              throw interrupted;
            }),
            (error) => error === interrupted,
          );
          assert.deepEqual(await jobs(), beforeJobs);
          const buildStart = performance.now();
          assert.deepEqual(await backend.backfillReadIndexes(), { processed: 0, done: false });
          const firstIndexMs = performance.now() - buildStart;
          const afterFirst = await jobs();
          assert.equal(afterFirst.filter((row) => row.complete).length, 1);
          await backend.close();
          backend = await createPGliteStorageBackend({ repoId, storage });
          assert.deepEqual(await jobs(), afterFirst, "restart retains completed physical indexes");
          let turns = 0,
            units = 0,
            maxBackgroundMs = 0;
          for (;;) {
            const pageStart = performance.now();
            const page = await backend.backfillReadIndexes();
            maxBackgroundMs = Math.max(maxBackgroundMs, performance.now() - pageStart);
            assert.ok(page.processed <= 64);
            units += page.processed;
            if (page.done) break;
            assert.ok(++turns < 5000);
          }
          assert.deepEqual(await primaryReads(), pendingReads, "primary reads keep their results after backfill");
          assert.deepEqual(await identity(), before, "neither canonical nor projection tables are swapped");
          assert.equal(
            (await backend.pool.query("SELECT event_json FROM ha_events WHERE revision=$1", [size])).rows[0]!
              .event_json,
            canonical,
          );
          assert.equal((await backend.projection.readScheduleEvents("target")).events.length, 1);
          assert.equal((await backend.projection.listDecisions({ search: "needle", limit: 1 })).decisions.length, 1);
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
              assert.equal((await client.query("SELECT count(*)::integer n FROM ha_events")).rows[0]!.n, 0);
            },
            { ...scope, tenantId: "other" },
          );
          await backend.close();
          backend = await createPGliteStorageBackend({ repoId, storage });
          assert.deepEqual(await backend.backfillReadIndexes(), { processed: 0, done: true });
          t.diagnostic(
            `DIRECT_INDEX_BUILD ${JSON.stringify({ size, attachMs, firstIndexMs, maxBackgroundMs, turns, units })}`,
          );
        } finally {
          await backend.close();
        }
      });
    });
  }
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
        'actor',json_build_object('principal',json_build_object('personId','owner'),'executor',NULL),'opId','event-'||n,'eventId','event-'||n,'workspaceRevision',n,'occurredAt','2026-11-05')::text FROM generate_series(1,$4::integer)n`,
    [...keys, size],
  );
  const value = { ...reduceDecisionDocument(null, proposal(1, "dec_template")), title: "needle" };
  await backend.pool.query(
    `INSERT INTO ha_decisions(tenant_id,project_id,policy_epoch,decision_id,workspace_revision,value)
    SELECT $1,$2,$3,'dec_'||lpad(n::text,6,'0'),1,$4::jsonb FROM generate_series(1,$5::integer)n`,
    [...keys, JSON.stringify(value), decisions],
  );
  await backend.pool.query("UPDATE ha_events SET read_index_version=0,event_schema=NULL,list_row=NULL");
  await backend.pool.query("UPDATE ha_event_summary_state SET ready=false");
  await backend.pool.query("UPDATE ha_decisions SET decision_sort_key=NULL,decision_state=NULL,search_ready=false");
  await backend.pool.query("DROP INDEX ha_events_schema_revision");
  await backend.pool.query("DROP INDEX ha_decisions_page");
}
