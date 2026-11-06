// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { ensurePgProjectionSchema, grantPgProjectionRuntimeAccess } from "../../src/pg/pg-projection-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "../../src/postgres/scope-schema.ts";
import { bundle, eventAt } from "../store/task-event-store.fixtures.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";

test("previous event schema upgrades table, RLS and grants before exposing the ref trigger", async () => {
  const fixture = await pgRuntimeFixture(),
    roles = POSTGRES_SCOPE_SCHEMA_CONTRACT.roles,
    scope = { tenantId: "old-refs", projectId: "old-refs", policyEpoch: 1, readers: ["reader-a"] },
    repoId = "previous",
    keys = [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
    source = createPgStorageBackend({ pool: fixture.pool, scope, repoId }).projection,
    previousInsert = (revision: number) =>
      withPostgresTransaction(
        fixture.pool,
        async (client) => {
          // Frozen previous wire columns: the old writer knows neither list_row nor the ref table.
          const event = eventAt(revision),
            bytes = JSON.stringify(event);
          await client.query(
            `INSERT INTO ha_events(tenant_id,project_id,policy_epoch,repo_id,revision,op_id,event_id,
              event_type,event_json,event_digest,occurred_at,entity_refs,readers)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'sha256:fixture',$10,ARRAY['task/target'],$11)`,
            [...keys, revision, event.opId, event.eventId, event.type, bytes, event.occurredAt, scope.readers],
          );
          await client.query(
            `UPDATE ha_repo_heads SET revision=$5,head_op_id=$6,head_event_digest='sha256:fixture',
              head_digest='sha256:fixture' WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4`,
            [...keys, revision, event.opId],
          );
          return bytes;
        },
        scope,
      );
  try {
    // Restore the actual prior objects, including its trigger, before any data is written.
    // DROP removes all modern table grants too; column-only version simulation cannot do that.
    await fixture.adminPool.query("DROP TRIGGER ha_event_entity_ref_fields ON ha_events");
    await fixture.adminPool.query("DROP FUNCTION ha_event_entity_ref_fields()");
    await fixture.adminPool.query("DROP TABLE ha_event_entity_refs");
    await fixture.adminPool.query("ALTER TABLE ha_events DROP COLUMN list_row");
    await fixture.adminPool.query("DROP INDEX ha_events_read_index_pending_v6");
    await fixture.adminPool.query(readFileSync(new URL("./fixtures/event-read-index-v5.sql", import.meta.url), "utf8"));
    await fixture.adminPool.query(
      "INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,readers) VALUES($1,$2,$3,$4,$5)",
      [...keys, scope.readers],
    );
    const original = await previousInsert(1);
    assert.equal(
      (await fixture.adminPool.query("SELECT to_regclass('ha_event_entity_refs') AS name")).rows[0].name,
      null,
    );
    assert.equal(
      (await fixture.adminPool.query("SELECT read_index_version FROM ha_events")).rows[0].read_index_version,
      5,
    );

    const admin = await fixture.adminPool.connect();
    let observedTrigger = false;
    try {
      await admin.query(`SET ROLE "${roles.schemaOwner}"`);
      const observe = new Proxy(admin, {
        get(target, key) {
          if (key === "query")
            return async (sql: string, ...args: unknown[]) => {
              const result = await Reflect.apply(target.query, target, [sql, ...args]);
              if (sql.startsWith("CREATE OR REPLACE TRIGGER ha_event_entity_ref_fields ")) {
                // There is no grant call or write pause between installing this trigger and old writers.
                await previousInsert(2);
                await withPostgresTransaction(
                  fixture.pool,
                  async (client) => {
                    assert.equal(
                      (await client.query("SELECT read_index_version FROM ha_events WHERE revision=2")).rows[0]
                        .read_index_version,
                      5,
                      "the v6 marker is installed only after ref maintenance; window writes remain pending",
                    );
                  },
                  scope,
                );
                observedTrigger = true;
              }
              return result;
            };
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await ensurePgProjectionSchema(observe);
      await grantPgProjectionRuntimeAccess(admin);
      await ensurePgProjectionSchema(admin);
    } finally {
      await admin.query("RESET ROLE");
      admin.release();
    }
    assert.equal(observedTrigger, true);
    const acl = await fixture.adminPool.query(
      `SELECT rolname,rolbypassrls,(has_table_privilege(rolname,'ha_event_entity_refs','SELECT')
        AND has_table_privilege(rolname,'ha_event_entity_refs','INSERT')
        AND has_table_privilege(rolname,'ha_event_entity_refs','DELETE')) AS allowed,
        has_table_privilege(rolname,'ha_event_entity_refs','UPDATE') AS updates
       FROM pg_roles WHERE rolname=ANY($1) ORDER BY rolname`,
      [[roles.runtime, roles.migration]],
    );
    assert.equal(acl.rows.length, 2);
    assert.ok(acl.rows.every((row) => row.allowed && !row.rolbypassrls && !row.updates));
    assert.deepEqual(
      (
        await fixture.adminPool.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='ha_event_entity_refs'",
        )
      ).rows,
      [{ relrowsecurity: true, relforcerowsecurity: true }],
    );

    await fixture.adminPool.query(`REVOKE INSERT ON ha_event_entity_refs FROM "${roles.runtime}"`);
    await assert.rejects(previousInsert(3), { code: "42501" });
    const retry = await fixture.adminPool.connect();
    try {
      await retry.query(`SET ROLE "${roles.schemaOwner}"`);
      await ensurePgProjectionSchema(retry);
    } finally {
      await retry.query("RESET ROLE");
      retry.release();
    }
    await previousInsert(3);
    await fixture.adminPool.query(`REVOKE SELECT ON ha_event_entity_refs FROM "${roles.runtime}"`);
    await assert.rejects(
      withPostgresTransaction(fixture.pool, (client) => client.query("SELECT 1 FROM ha_event_entity_refs"), scope),
      { code: "42501" },
    );
    const grant = await fixture.adminPool.connect();
    try {
      await grant.query(`SET ROLE "${roles.schemaOwner}"`);
      await grantPgProjectionRuntimeAccess(grant);
    } finally {
      await grant.query("RESET ROLE");
      grant.release();
    }
    await withPostgresTransaction(
      fixture.adminPool,
      async (client) => {
        for (const expected of [2, 0])
          assert.equal(
            (await client.query("SELECT ha_backfill_event_read_indexes($1,$2,$3,$4) AS processed", keys)).rows[0]
              .processed,
            expected,
          );
        assert.equal(
          (await client.query("SELECT event_json FROM ha_events WHERE revision=1")).rows[0].event_json,
          original,
        );
        await client.query(
          `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,readers,projection_name,
          schema_version,watermark,source_revision) VALUES($1,$2,$3,$4,'task/v1',5,3,3)`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, scope.readers],
        );
      },
      scope,
    );
    assert.deepEqual(
      (await source.readEventList({ entity: "target", limit: 10 })).rows.map((row) => row.revision),
      [3, 2, 1],
    );
    for (const foreign of [
      { ...scope, tenantId: "other" },
      { ...scope, projectId: "other" },
      { ...scope, policyEpoch: 2 },
    ])
      await withPostgresTransaction(
        fixture.pool,
        async (client) => {
          assert.equal((await client.query("SELECT 1 FROM ha_event_entity_refs")).rows.length, 0);
        },
        foreign,
      );
    await withPostgresTransaction(
      fixture.adminPool,
      async (client) => {
        await client.query(`SET LOCAL ROLE "${roles.migration}"`);
        assert.equal((await client.query("SELECT 1 FROM ha_event_entity_refs")).rows.length, 6);
      },
      scope,
    );
    const currentScope = { tenantId: "current-refs", projectId: "current-refs", policyEpoch: 1 },
      current = createPgStorageBackend({ pool: fixture.pool, scope: currentScope, repoId: "current" });
    await current.eventStore.append(bundle(eventAt(1)), 0, { repoId: "current", holderId: "writer", epoch: 1 });
    assert.equal((await current.projection.readEventList({ limit: 10 })).rows.length, 1);
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
