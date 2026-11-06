// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

const scope = { tenantId: "v6", projectId: "v6", policyEpoch: 1 },
  repoId = "v6";
type Backend = Awaited<ReturnType<typeof createPGliteStorageBackend>>;

pgliteIntegrationSuite("online event v6 integration", () => {
  test("v5 remainder resumes after restart and keeps v6 collections pending until complete", async (t) => {
    await withTempStoreAsync(async (root) => {
      const storage = { backend: "pglite" as const, dataDir: join(root, "db"), scope };
      let backend = await createPGliteStorageBackend({ repoId, storage });
      try {
        await seed(backend, 130);
        await backend.pool.query("UPDATE ha_events SET read_index_version=5");
        await backend.pool.query("DELETE FROM ha_event_entity_refs");
        await assert.rejects(backend.projection.readEventList({ entity: "seed", limit: 1 }), {
          code: "projection_pending",
        });
        assert.deepEqual(await backend.backfillReadIndexes(), { processed: 64, done: false });
        assert.equal(await pending(backend), 66);
        await backend.close();
        backend = await createPGliteStorageBackend({ repoId, storage });
        assert.equal(await pending(backend), 66, "open does not consume the persisted remainder");
        await assert.rejects(backend.projection.readEventList({ entity: "missing", limit: 1 }), {
          code: "projection_pending",
        });
        assert.deepEqual(await backend.backfillReadIndexes(), { processed: 64, done: false });
        assert.deepEqual(await backend.backfillReadIndexes(), { processed: 2, done: false });
        assert.equal(await pending(backend), 0);
        assert.deepEqual(await backend.backfillReadIndexes(), { processed: 0, done: true });
        assert.equal((await backend.projection.readEventList({ entity: "seed", limit: 1 })).rows[0]?.revision, 130);
        assert.deepEqual((await backend.projection.readEventList({ entity: "missing", limit: 1 })).rows, []);
        t.diagnostic("V6_REMAINDER 130 -> 66 -> restart 66 -> 2 -> 0; page <=64; pending -> ready");
      } finally {
        await backend.close();
      }
    });
  });

  test("event index publication preserves inbound foreign keys, new writes and delete cascades", async (t) => {
    await withTempStoreAsync(async (root) => {
      const storage = { backend: "pglite" as const, dataDir: join(root, "db"), scope };
      let backend = await createPGliteStorageBackend({ repoId, storage });
      try {
        await seed(backend, 130);
        await backend.pool.query("DROP INDEX ha_events_schema_revision");
        await backend.pool.query("DROP INDEX ha_event_entity_refs_revision");
        await backend.close();
        backend = await createPGliteStorageBackend({ repoId, storage });
        assert.equal((await backend.projection.readEventList({ entity: "seed", limit: 1 })).rows[0]?.revision, 130);
        let turns = 0;
        for (;;) {
          const page = await backend.backfillReadIndexes();
          assert.ok(page.processed <= 64);
          if (page.done) break;
          assert.ok(++turns < 30);
        }
        const targets = (
          await backend.pool.query(`SELECT confrelid::regclass::text AS target FROM pg_constraint
            WHERE contype='f' AND conrelid='ha_event_entity_refs'::regclass`)
        ).rows;
        assert.deepEqual(targets, [{ target: "ha_events" }]);
        await append(backend, 131);
        assert.equal((await backend.projection.readEventList({ entity: "seed", limit: 1 })).rows[0]?.revision, 130);
        assert.equal(
          (await backend.pool.query("SELECT count(*)::int AS n FROM ha_event_entity_refs WHERE revision=131")).rows[0]!
            .n,
          2,
        );
        await assert.rejects(
          backend.pool.query(`INSERT INTO ha_event_entity_refs
            (tenant_id,project_id,policy_epoch,repo_id,entity_ref,revision) VALUES('v6','v6',1,'v6','orphan',999)`),
          { code: "23503" },
        );
        await backend.pool.query("DELETE FROM ha_events WHERE revision=130");
        assert.equal(
          (await backend.pool.query("SELECT count(*)::int AS n FROM ha_event_entity_refs WHERE revision=130")).rows[0]!
            .n,
          0,
        );
        await backend.close();
        backend = await createPGliteStorageBackend({ repoId, storage });
        await append(backend, 132);
        assert.deepEqual(await backend.backfillReadIndexes(), { processed: 0, done: true });
        t.diagnostic(`V6_PUBLICATION ${JSON.stringify({ turns, targets, newWrites: [131, 132], orphan: "23503" })}`);
      } finally {
        await backend.close();
      }
    });
  });
});

async function pending(backend: Backend): Promise<number> {
  return Number(
    (await backend.pool.query("SELECT count(*)::int AS n FROM ha_events WHERE read_index_version<6")).rows[0]!.n,
  );
}

async function seed(backend: Backend, size: number) {
  await backend.pool.query(`INSERT INTO ha_repo_heads
    (tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
    VALUES('v6','v6',1,'v6',130,'fixture','fixture','fixture')`);
  await backend.pool.query(`INSERT INTO ha_projection_meta
    (tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision) VALUES('v6','v6',1,5,130,130)`);
  await backend.pool.query(
    `INSERT INTO ha_events(tenant_id,project_id,policy_epoch,repo_id,revision,op_id,event_id,event_type,event_digest,occurred_at,event_json,entity_refs)
    SELECT 'v6','v6',1,'v6',n,'event-'||n,'event-'||n,'task_created','fixture','2026-11-06',
      json_build_object('schema','task-event/v1','type','task_created','eventId','event-'||n,'opId','event-'||n,
        'workspaceRevision',n,'occurredAt','2026-11-06')::text,ARRAY['task/seed'] FROM generate_series(1,$1::int)n`,
    [size],
  );
}

async function append(backend: Backend, revision: number) {
  await backend.pool.query(
    `INSERT INTO ha_events(tenant_id,project_id,policy_epoch,repo_id,revision,op_id,event_id,event_type,event_digest,occurred_at,event_json,entity_refs)
    SELECT tenant_id,project_id,policy_epoch,repo_id,$1,'event-'||($1::bigint)::text,'event-'||($1::bigint)::text,
      event_type,event_digest,occurred_at,event_json,entity_refs FROM ha_events WHERE revision=1`,
    [revision],
  );
}
