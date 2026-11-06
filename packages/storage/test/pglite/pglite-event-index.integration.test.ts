// harness-test-tier: integration
import test from "node:test";
import assert from "node:assert/strict";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { assertEventIndexes } from "../postgres/pg-event-index.fixture.ts";
import { tracedPgReads, explainNodes } from "../postgres/pg-explain.fixture.ts";

pgliteIntegrationSuite("PGlite event indexes", () => {
  test("entity event pages and task leases exclude unrelated history under RLS", async () => {
    const scope = { tenantId: "entity-page", projectId: "entity-page", policyEpoch: 1 },
      repoId = "entity-page",
      backend = await createPGliteStorageBackend({ repoId, storage: { backend: "pglite", scope } });
    try {
      await withPostgresTransaction(
        backend.pool,
        async (client) => {
          await client.query(
            `INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest,readers)
            VALUES($1,$2,$3,$4,2002,'fixture','fixture','fixture',ARRAY['unrelated'])`,
            [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
          );
          await client.query(
            `INSERT INTO ha_events(tenant_id,project_id,policy_epoch,repo_id,revision,op_id,event_id,event_type,event_digest,occurred_at,entity_refs,event_json)
            SELECT $1,$2,$3,$4,n,'event-'||n,'event-'||n,'task_created','fixture','2026-11-05',
              ARRAY['task/'||CASE WHEN n<=2 THEN 'target' ELSE 'history-'||n END],
              json_build_object('schema','task-event/v1','type','task_created','taskId',CASE WHEN n<=2 THEN 'target' ELSE 'history-'||n END,
                'opId','event-'||n,'eventId','event-'||n,'workspaceRevision',n,'occurredAt','2026-11-05',
                'actor',json_build_object('principal',json_build_object('personId','owner'),'executor',NULL),
                'source','local','payload',json_build_object('text',repeat('x',4096)))::text
            FROM generate_series(1,2002)n`,
            [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
          );
          await client.query(
            `INSERT INTO ha_projection_values(tenant_id,project_id,policy_epoch,model,owner_id,entity_id,workspace_revision,value)
            SELECT $1,$2,$3,'lease-interval',CASE WHEN n<=2 THEN 'target' ELSE 'history-'||n END,n::text,n,
              json_build_object('taskId',CASE WHEN n<=2 THEN 'target' ELSE 'history-'||n END,
                'executionId','execution-'||n,'acquiredRevision',n,'releasedRevision',n+1)::text
            FROM generate_series(1,2002)n`,
            [scope.tenantId, scope.projectId, scope.policyEpoch],
          );
          await client.query(
            `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
            VALUES($1,$2,$3,5,2002,2002)`,
            [scope.tenantId, scope.projectId, scope.policyEpoch],
          );
          await client.query("ANALYZE");
          await client.query("CREATE ROLE entity_page_reader NOLOGIN NOBYPASSRLS");
          await client.query("GRANT USAGE ON SCHEMA public TO entity_page_reader");
          await client.query(
            "GRANT SELECT ON ha_events,ha_event_entity_refs,ha_projection_values,ha_projection_meta,ha_repo_heads TO entity_page_reader",
          );
        },
        scope,
      );
      await backend.pool.query("SET ROLE entity_page_reader");
      const plans: unknown[] = [],
        pool = tracedPgReads(backend.pool, plans, (sql) =>
          /^\s*SELECT[\s\S]*(?:FROM ha_events|FROM ha_projection_values)/u.test(sql),
        ),
        source = createPgTaskProjectionSource({ pool, scope, repoId, ownsPool: false });
      const first = await source.readEventList({ entity: "task/target", limit: 1 });
      assert.deepEqual(
        first.rows.map(({ revision }) => revision),
        [2],
      );
      assert.equal(first.hasMore, true);
      assert.equal(first.nextCursor, "2");
      const last = await source.readEventList({ entity: "target", revisionBound: 2, limit: 1 });
      assert.deepEqual(
        last.rows.map(({ revision }) => revision),
        [1],
      );
      assert.deepEqual(last.rows[0]!.actor, { personId: "owner", executorId: null });
      assert.deepEqual(last.rows[0]!.entityRefs, ["task/target"]);
      assert.equal(last.hasMore, false);
      assert.equal(last.nextCursor, null);
      assert.deepEqual((await source.readEventList({ entity: "arget", limit: 1 })).rows, []);
      assert.equal((await source.readLeaseIntervals("target")).length, 2);
      const scans = explainNodes(plans).filter((row) =>
        ["ha_events", "ha_projection_values", "ha_event_entity_refs"].includes(String(row["Relation Name"])),
      );
      assert.ok(scans.some((row) => row["Relation Name"] === "ha_events"));
      assert.ok(scans.some((row) => row["Relation Name"] === "ha_projection_values"));
      for (const scan of scans)
        assert.ok(
          (Number(scan["Actual Rows"]) + Number(scan["Rows Removed by Filter"] ?? 0)) * Number(scan["Actual Loops"]) <=
            2,
          `task-scoped read scanned unrelated history: ${JSON.stringify(scan)}`,
        );
      assert.deepEqual((await source.readEventList({ entity: "task/target", actor: "unrelated", limit: 1 })).rows, []);
      assert.deepEqual(
        (
          await createPgTaskProjectionSource({
            pool,
            scope: { ...scope, readers: ["unrelated"] },
            repoId,
            ownsPool: false,
          }).readEventList({ entity: "task/target", limit: 1 })
        ).rows,
        [],
      );
      await withPostgresTransaction(
        backend.pool,
        async (client) => {
          assert.equal((await client.query("SELECT 1 FROM ha_event_entity_refs LIMIT 1")).rows.length, 0);
        },
        { ...scope, policyEpoch: 2 },
      );
      await backend.pool.query("RESET ROLE");
      const original = await withPostgresTransaction(
        backend.pool,
        async (client) => {
          const bytes = (
            await client.query<{ event_json: string }>("SELECT event_json FROM ha_events WHERE revision=1")
          ).rows[0]!.event_json;
          await client.query("UPDATE ha_events SET read_index_version=5,list_row=NULL WHERE revision=1");
          await client.query("DELETE FROM ha_event_entity_refs WHERE revision=1");
          return bytes;
        },
        scope,
      );
      await assert.rejects(source.readEventList({ entity: "task/target", limit: 1 }), { code: "projection_pending" });
      await withPostgresTransaction(
        backend.pool,
        async (client) => {
          for (const expected of [1, 0])
            assert.equal(
              (
                await client.query<{ processed: number }>(
                  "SELECT ha_backfill_event_read_indexes($1,$2,$3,$4) AS processed",
                  [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
                )
              ).rows[0]!.processed,
              expected,
            );
          assert.equal(
            (await client.query<{ event_json: string }>("SELECT event_json FROM ha_events WHERE revision=1")).rows[0]!
              .event_json,
            original,
          );
          await client.query(
            "UPDATE ha_events SET entity_refs=ARRAY['task/target','register/adr/ADR-1','adr/ADR-1','ADR-1-neighbor'] WHERE revision=1",
          );
        },
        scope,
      );
      for (const entity of ["register/adr/ADR-1", "adr/ADR-1", "ADR-1", "ADR-1-neighbor"])
        assert.deepEqual(
          (await source.readEventList({ entity, limit: 2 })).rows.map(({ revision }) => revision),
          [1],
        );
      assert.deepEqual((await source.readEventList({ entity: "DR-1", limit: 2 })).rows, []);
    } finally {
      await backend.close();
    }
  });

  test("PGlite event indexes exclude unrelated history", async () => {
    const backend = await createPGliteStorageBackend({
      repoId: "event-index",
      storage: { backend: "pglite", scope: { tenantId: "event-index", projectId: "event-index", policyEpoch: 1 } },
    });
    try {
      await assertEventIndexes(backend.pool, backend.pool, "pglite");
    } finally {
      await backend.close();
    }
  });
});
