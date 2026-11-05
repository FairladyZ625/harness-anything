// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import * as storage from "@harness-anything/storage";
import { reduceDecisionDocument } from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import { proposal } from "../store/relation-graph-projection.fixtures.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";

test("public management backfill completes a previous-writer Decision search expansion", async () => {
  const backfill = storage.backfillPgDecisionSearchPage;
  assert.equal(typeof backfill, "function", "deployment must import the management entry from the public package");
  const fixture = await pgRuntimeFixture();
  try {
    const scope = { tenantId: "public-decision-upgrade", projectId: "public-decision-upgrade", policyEpoch: 1 };
    const value = { ...reduceDecisionDocument(null, proposal(1, "dec_template")), title: "needle" };
    await storage.withPostgresTransaction(
      fixture.adminPool,
      async (client) => {
        await client.query(
          `INSERT INTO ha_decisions(tenant_id,project_id,policy_epoch,decision_id,workspace_revision,value)
        SELECT $1,$2,$3,'dec_'||n,1,$4::jsonb||jsonb_build_object('decisionId','dec_'||n) FROM generate_series(1,130)n`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, JSON.stringify(value)],
        );
      },
      scope,
    );
    await storage.withPostgresTransaction(
      fixture.adminPool,
      async (client) => {
        const keys = [scope.tenantId, scope.projectId, scope.policyEpoch];
        await client.query(
          `INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
        VALUES($1,$2,$3,'public-decision-upgrade',130,'fixture','fixture','fixture')`,
          keys,
        );
        await client.query(
          `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
        VALUES($1,$2,$3,5,130,130)`,
          keys,
        );
      },
      scope,
    );
    const source = storage.createPgTaskProjectionSource({
      pool: fixture.pool,
      scope,
      repoId: "public-decision-upgrade",
      ownsPool: false,
    });
    await assert.rejects(() => source.listDecisions({ search: "needle", limit: 1 }), { code: "projection_pending" });
    const manage = <T>(run: (client: import("pg").PoolClient) => Promise<T>) =>
      storage.withPostgresTransaction(fixture.adminPool, run, scope);
    const rollback = new Error("interrupt public backfill");
    await assert.rejects(
      manage(async (client) => {
        assert.deepEqual(await backfill(client, scope), { processed: 64, done: false });
        throw rollback;
      }),
      (e) => e === rollback,
    );
    assert.equal(
      (await manage((client) => client.query("SELECT count(*)::integer AS n FROM ha_decisions WHERE search_ready")))
        .rows[0]!.n,
      0,
    );
    const pages = [];
    for (;;) {
      const page = await storage.withPostgresTransaction(fixture.adminPool, (client) => backfill(client, scope), scope);
      pages.push(page.processed);
      if (page.done) break;
    }
    assert.deepEqual(pages, [64, 64, 2, 0]);
    const count = async () =>
      (await manage((client) => client.query("SELECT scalar_pending,search_pending FROM ha_decision_read_status")))
        .rows[0]!;
    assert.deepEqual(await count(), { scalar_pending: "0", search_pending: "0" });
    assert.equal((await source.listDecisions({ search: "needle", limit: 1 })).decisions.length, 1);
    await manage((client) => client.query("UPDATE ha_decisions SET value=value WHERE decision_id='dec_1'"));
    assert.deepEqual(await count(), { scalar_pending: "0", search_pending: "1" });
    await assert.rejects(
      manage(async (client) => {
        await backfill(client, scope);
        throw rollback;
      }),
      (e) => e === rollback,
    );
    assert.equal((await count()).search_pending, "1");
    await manage((client) => client.query("DELETE FROM ha_decisions WHERE decision_id='dec_1'"));
    assert.equal((await count()).search_pending, "0");
    // Old installation has no summary yet. Pin the management completion transaction
    // and observe the previous writer waiting on its summary, then release it.
    await manage((client) => client.query("DELETE FROM ha_decision_read_status"));
    const peers = new Pool({ host: "127.0.0.1", port: fixture.port, user: "postgres", database: "postgres", max: 2 });
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      pidReady = Promise.withResolvers<number>();
    const management = manage(async (client) => {
      assert.deepEqual(await backfill(client, scope), { processed: 0, done: true });
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const writer = storage.withPostgresTransaction(
      peers,
      async (client) => {
        pidReady.resolve((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
        await client.query("UPDATE ha_decisions SET value=value WHERE decision_id='dec_2'");
      },
      scope,
    );
    try {
      const pid = await pidReady.promise,
        deadline = Date.now() + 10000;
      for (;;) {
        const state = (await peers.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
        if (state?.wait_event_type === "Lock") break;
        assert.ok(Date.now() < deadline, "previous writer must wait on management completion");
      }
    } finally {
      release.resolve();
      await management;
      await writer;
      await peers.end();
    }
    assert.equal((await count()).search_pending, "1");
    await assert.rejects(() => source.listDecisions({ search: "needle", limit: 1 }), { code: "projection_pending" });
    assert.deepEqual(await manage((client) => backfill(client, scope)), { processed: 1, done: false });
    assert.deepEqual(await manage((client) => backfill(client, scope)), { processed: 0, done: true });
    // Commit a real previous-writer transition after management's empty snapshot.
    // It must not wait on a management scan lock, nor be overwritten by completion.
    let raced = false;
    const page = await manage((client) =>
      backfill(
        new Proxy(client, {
          get(target, key) {
            if (key !== "query") {
              const value: unknown = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(target.query, target, args);
              if (!raced && typeof args[0] === "string" && args[0].includes("SELECT EXISTS(")) {
                raced = true;
                await storage.withPostgresTransaction(
                  fixture.pool,
                  async (writer) => {
                    await writer.query("SET LOCAL statement_timeout='1s'");
                    await writer.query("UPDATE ha_decisions SET value=value WHERE decision_id='dec_2'");
                  },
                  scope,
                );
              }
              return result;
            };
          },
        }),
        scope,
      ),
    );
    assert.ok(raced);
    assert.deepEqual(page, { processed: 0, done: false });
    assert.equal((await count()).search_pending, "1");
    assert.deepEqual(await manage((client) => backfill(client, scope)), { processed: 1, done: false });
    assert.deepEqual(await manage((client) => backfill(client, scope)), { processed: 0, done: true });
    // Schema installation itself must grant the previous runtime before its new
    // trigger becomes active, without waiting for the later reader grant step.
    await fixture.adminPool.query("REVOKE ALL ON ha_decision_read_status FROM ha_runtime,ha_migrator");
    const owner = await fixture.adminPool.connect();
    try {
      await owner.query("SET ROLE ha_schema_owner");
      await storage.ensurePgProjectionSchema(owner);
    } finally {
      await owner.query("RESET ROLE");
      owner.release();
    }
    await storage.withPostgresTransaction(
      fixture.pool,
      (client) => client.query("UPDATE ha_decisions SET value=value WHERE decision_id='dec_2'"),
      scope,
    );
    assert.equal((await count()).search_pending, "1");
    assert.deepEqual(await manage((client) => backfill(client, scope)), { processed: 1, done: false });
    const other = { ...scope, projectId: "other-project" };
    const isolated = await storage.withPostgresTransaction(
      fixture.pool,
      (client) => client.query("SELECT * FROM ha_decision_read_status"),
      other,
    );
    assert.equal(isolated.rowCount, 0);
    assert.deepEqual(await manage((client) => backfill(client, scope)), { processed: 0, done: true });
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
