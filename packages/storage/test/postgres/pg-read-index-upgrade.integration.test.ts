// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { taskLifecycleWritePlan, type CanonicalEventV1 } from "@harness-anything/kernel";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { canonicalEventWritePlan, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { ensurePgProjectionSchema, grantPgProjectionRuntimeAccess } from "../../src/pg/pg-projection-schema.ts";
import { rebuildPgProjection } from "../../src/pg/pg-task-event-materialize.ts";
import { backfillPgEntityDeclarationPage } from "../../src/pg/pg-entity-declaration-catchup.ts";
import { backfillPgReadIndexPage } from "../../src/pg/pg-read-index-backfill.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "../../src/postgres/scope-schema.ts";
import { eventAt } from "../store/task-event-store.fixtures.ts";
import { tracedPgReads, explainNodes } from "./pg-explain.fixture.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { appendBootstrapQueryFixture } from "./query-bootstrap.fixture.ts";
import { appendQueryParityFixtures } from "./pg-query-parity.fixture.ts";
import { appendRuntimeQueryFixtures } from "./pg-runtime-query-parity.fixture.ts";
import { appendGraphQueryFixtures } from "./pg-complete-query-parity.fixture.ts";
import { runtimeProviderEvents } from "../runtime-provider-bytes.assertions.ts";
import { reduceDecisionDocument } from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import { proposal } from "../store/relation-graph-projection.fixtures.ts";

test("external PG release sequence upgrades populated read indexes before reader handoff", async (t) => {
  const fixture = await pgRuntimeFixture(),
    repoId = "read-index-upgrade",
    scope = { tenantId: "upgrade", projectId: "upgrade", policyEpoch: 1, readers: [] },
    roles = POSTGRES_SCOPE_SCHEMA_CONTRACT.roles,
    { eventStore, projection } = createPgStorageBackend({ pool: fixture.pool, repoId, scope }),
    events: CanonicalEventV1[] = [],
    blobs = new Map<string, Uint8Array>(),
    keys = [scope.tenantId, scope.projectId, scope.policyEpoch],
    manage = <T>(operation: (client: PoolClient) => Promise<T>) =>
      withPostgresTransaction(fixture.adminPool, operation, scope),
    append = async (candidate: CanonicalWriteBundle) => {
      await eventStore.append(candidate, events.length, { repoId, holderId: "upgrade", epoch: 1 });
      events.push(candidate.event);
      for (const blob of candidate.blobs)
        blobs.set(blob.sha256, typeof blob.body === "string" ? new TextEncoder().encode(blob.body) : blob.body);
    },
    read = async () => ({
      cut: await projection.readCut(),
      sessions: await projection.readRuntimeSessions({ unsettledOnly: true }),
      task: await projection.readRuntimeSessionsForTask("task-parity"),
      pins: await projection.listPinnedEntities(),
      intervals: await projection.readLeaseIntervals("task-parity"),
      fact: await projection.readFactGraph("F-11111111"),
      dispatches: await projection.readRuntimeDispatchesBySession("runtime-query-session"),
      event: await projection.readTaskEventExists("task-parity"),
    });
  try {
    const lifecycle = lifecycleFixture({ taskId: "task-parity", executionId: "execution-parity" });
    for (const event of lifecycle.events) await append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    await appendBootstrapQueryFixture(append, () => events.length + 1, lifecycle.events[0]!.actor);
    await appendQueryParityFixtures(append, () => events.length + 1);
    await appendGraphQueryFixtures(append, () => events.length + 1);
    await appendRuntimeQueryFixtures(append, () => events.length + 1);
    const template = runtimeProviderEvents()[0]!;
    assert.equal(template.type, "runtime_session_started");
    if (template.type !== "runtime_session_started") throw new Error("invalid start fixture");
    for (let n = 0; n < 130; n++) {
      const event = {
        ...template,
        eventId: `upgrade-start-${n}`,
        opId: `upgrade-start-${n}`,
        workspaceRevision: events.length + 1,
        payload: {
          ...template.payload,
          runtimeSessionId: `upgrade-session-${n}`,
          taskBinding: { taskId: "task-parity", executionId: "execution-parity" },
        },
      };
      await append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
    }
    const before = await read();
    assert.equal(before.cut.status, "ready");
    assert.ok(before.sessions.length >= 130 && before.pins.length > 0 && before.intervals.length > 0);
    const original = await manage(
      async (client) =>
        (
          await client.query<{ value: string }>(
            "SELECT value FROM ha_projection_values WHERE model='runtime-session' ORDER BY entity_id",
          )
        ).rows,
    );
    // Populated previous-writer state: canonical bytes and generation 5 stay intact;
    // only the newly derived fields/task bindings and declaration watermark are absent.
    await manage(async (client) => {
      await client.query(`UPDATE ha_projection_values SET read_index_version=0,
        runtime_liveness=NULL,runtime_outcome=NULL,order_at=NULL,order_revision=NULL,
        execution_id=NULL,interval_open=NULL,fact_edge=NULL`);
      await client.query(`UPDATE ha_events SET read_index_version=0,event_schema=NULL,
        runtime_session_id=NULL,dispatch_key=NULL,task_index_id=NULL,runtime_session_present=false,runtime_session_unsettled=false`);
      await client.query("DELETE FROM ha_runtime_session_tasks");
      await client.query("DELETE FROM ha_entity_declaration_heads");
      await client.query(
        `REVOKE ALL ON ha_runtime_session_tasks,ha_entity_declaration_heads FROM "${roles.runtime}","${roles.migration}"`,
      );
      await client.query("UPDATE ha_projection_meta SET entity_declaration_watermark=0");
    });
    await assert.rejects(
      withPostgresTransaction(
        fixture.pool,
        (client) => client.query("SELECT 1 FROM ha_runtime_session_tasks LIMIT 0"),
        scope,
      ),
      { code: "42501" },
    );
    // Phase 1 installs expansion only; it must not silently backfill legacy rows.
    await manage(async (client) => {
      await client.query(`SET LOCAL ROLE "${roles.schemaOwner}"`);
      await ensurePgProjectionSchema(client, { indexBuild: "isolated" });
      await grantPgProjectionRuntimeAccess(client);
    });
    await assert.rejects(read(), { code: "projection_pending" });
    assert.deepEqual(await projection.readCut(), before.cut);
    assert.equal((await projection.readRuntimeSessionPage({ limit: 1 })).rows.length, 1);

    const countPending = () =>
        manage(async (client) =>
          Number(
            (
              await client.query<{ count: string }>(
                "SELECT count(*) FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND ((model='runtime-session' AND read_index_version<3) OR (model IN ('pin','lease-interval','relation-write') AND read_index_version=0))",
                keys,
              )
            ).rows[0]!.count,
          ),
        ),
      batch = (client: PoolClient, kind: "projection" | "event") =>
        client.query<{ processed: number }>(
          kind === "projection"
            ? "SELECT ha_backfill_projection_read_indexes($1,$2,$3) AS processed"
            : "SELECT ha_backfill_event_read_indexes($1,$2,$3,$4) AS processed",
          kind === "projection" ? keys : [...keys, repoId],
        );
    const first = await manage(async (client) => (await batch(client, "projection")).rows[0]!.processed);
    assert.equal(first, 64);
    const remainder = await countPending(),
      interrupted = new Error("rollback read-index batch");
    await assert.rejects(
      manage(async (client) => {
        await batch(client, "projection");
        throw interrupted;
      }),
      (error) => error === interrupted,
    );
    assert.equal(await countPending(), remainder);
    // Previous binary's original-column update uses the actual runtime login.
    await withPostgresTransaction(
      fixture.pool,
      async (client) => {
        await client.query(
          "UPDATE ha_projection_values SET value=value WHERE model='runtime-session' AND entity_id='upgrade-session-129'",
        );
        assert.equal(
          (
            await client.query<{ read_index_version: number }>(
              "SELECT read_index_version FROM ha_projection_values WHERE model='runtime-session' AND entity_id='upgrade-session-129'",
            )
          ).rows[0]!.read_index_version,
          3,
        );
      },
      scope,
    );
    const pages: Record<string, number[]> = { projection: [first], event: [] };
    for (const kind of ["projection", "event"] as const) {
      for (;;) {
        const processed = await manage(async (client) => (await batch(client, kind)).rows[0]!.processed);
        pages[kind]!.push(processed);
        assert.ok(processed >= 0 && processed <= 64);
        if (processed === 0) break;
      }
    }
    assert.equal(await countPending(), 0);
    await manage(async (client) => {
      assert.equal(
        (
          await client.query(
            "SELECT 1 FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND read_index_version<5 LIMIT 1",
            [...keys, repoId],
          )
        ).rows.length,
        0,
      );
      assert.deepEqual(
        (
          await client.query<{ value: string }>(
            "SELECT value FROM ha_projection_values WHERE model='runtime-session' ORDER BY entity_id",
          )
        ).rows,
        original,
      );
    });
    for (;;) {
      const page = await backfillPgEntityDeclarationPage(fixture.pool, scope, repoId, 64);
      assert.ok(page.processed <= 64);
      if (page.watermark === page.sourceRevision) break;
    }
    assert.deepEqual(await read(), before, "direct current reads after documented handoff");
    await manage((client) =>
      rebuildPgProjection(client, scope, {
        events,
        sourceRevision: events.length,
        readContentBlob: (sha256) => blobs.get(sha256) ?? null,
      }),
    );
    assert.deepEqual(await read(), before, "cold canonical replay preserves the upgraded read results");
    await t.diagnostic(
      `READ_INDEX_RELEASE ${JSON.stringify({ events: events.length, pages, rollback: true, directRead: true, coldReplay: true })}`,
    );
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});

test("Decision expansion resumes 64-owner batches and repairs an interrupted concurrent index", async () => {
  const fixture = await pgRuntimeFixture(),
    scope = { tenantId: "decision-upgrade", projectId: "decision-upgrade", policyEpoch: 1 },
    manage = <T>(f: (client: PoolClient) => Promise<T>) => withPostgresTransaction(fixture.adminPool, f, scope),
    keys = [scope.tenantId, scope.projectId, scope.policyEpoch];
  try {
    await manage(async (client) => {
      await client.query(
        `INSERT INTO ha_decisions(tenant_id,project_id,policy_epoch,decision_id,workspace_revision,value)
        SELECT $1,$2,$3,'dec_upgrade_'||n,1,
          jsonb_set($4::jsonb,'{decisionId}',to_jsonb('dec_upgrade_'||n)) FROM generate_series(1,130)n`,
        [...keys, JSON.stringify(reduceDecisionDocument(null, proposal(1, "dec_upgrade")))],
      );
      // Previous-generation state has original columns but no derived ordering keys.
      await client.query("UPDATE ha_decisions SET decision_sort_key=NULL");
    });
    const batch = () =>
        manage(
          async (client) =>
            (
              await client.query<{ processed: number }>(
                "SELECT ha_backfill_decision_indexes($1,$2,$3) AS processed",
                keys,
              )
            ).rows[0]!.processed,
        ),
      pending = () =>
        manage(async (client) =>
          Number(
            (
              await client.query<{ n: string }>(
                "SELECT count(*) AS n FROM ha_decisions WHERE decision_sort_key IS NULL",
              )
            ).rows[0]!.n,
          ),
        );
    assert.equal(await batch(), 64);
    const rollback = new Error("interrupt decision index page");
    await assert.rejects(
      manage(async (client) => {
        await client.query("SELECT ha_backfill_decision_indexes($1,$2,$3)", keys);
        throw rollback;
      }),
      (e) => e === rollback,
    );
    assert.equal(await pending(), 66);
    assert.equal(await batch(), 64);
    assert.equal(await batch(), 2);
    assert.equal(await batch(), 0);
    await manage(async (client) => {
      await client.query(
        "UPDATE ha_decisions SET value=jsonb_set(value,'{state}','\"in_effect\"') WHERE decision_id='dec_upgrade_1'",
      );
      assert.equal(
        (await client.query("SELECT decision_state FROM ha_decisions WHERE decision_id='dec_upgrade_1'")).rows[0]!
          .decision_state,
        "in_effect",
      );
    });
    const admin = await fixture.adminPool.connect();
    try {
      await admin.query("DROP INDEX ha_decisions_state_order");
      // PostgreSQL itself produces the invalid artifact left by a failed concurrent build.
      await assert.rejects(
        admin.query("CREATE UNIQUE INDEX CONCURRENTLY ha_decisions_state_order ON ha_decisions(decision_state)"),
        { code: "23505" },
      );
      assert.equal(
        (await admin.query("SELECT indisvalid FROM pg_index WHERE indexrelid='ha_decisions_state_order'::regclass"))
          .rows[0]!.indisvalid,
        false,
      );
      await ensurePgProjectionSchema(admin);
      assert.equal(
        (await admin.query("SELECT indisvalid FROM pg_index WHERE indexrelid='ha_decisions_state_order'::regclass"))
          .rows[0]!.indisvalid,
        true,
      );
      await assertOnlineIndexDml(admin, fixture.port, keys);
      assert.equal(
        (await admin.query("SELECT to_regclass('ha_events_summary_pending') AS pending")).rows[0]!.pending,
        null,
        "an empty ledger has no summary work and skips the pending index",
      );
      const repoId = "summary-upgrade",
        { eventStore } = createPgStorageBackend({ pool: fixture.pool, repoId, scope }),
        event = eventAt(1);
      await eventStore.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] }, 0, {
        repoId,
        holderId: "upgrade",
        epoch: 1,
      });
      // A populated previous writer has completed v5, but predates fleet summaries.
      // UPDATE on an empty event table would let the global contraction skip this build.
      await admin.query(
        "UPDATE ha_events SET summary_json=NULL,read_index_version=5 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
        keys,
      );
      assert.deepEqual((await admin.query("SELECT read_index_version,summary_json FROM ha_events")).rows, [
        { read_index_version: 5, summary_json: null },
      ]);
      await assertOnlineIndexDml(admin, fixture.port, keys, true);
      const repositories = await admin.query<{
        tenant_id: string;
        project_id: string;
        policy_epoch: string;
        repo_id: string;
      }>("SELECT tenant_id,project_id,policy_epoch,repo_id FROM ha_repo_heads");
      for (const repo of repositories.rows) {
        const parameters = [repo.tenant_id, repo.project_id, repo.policy_epoch, repo.repo_id];
        for (;;) {
          const page = await backfillPgReadIndexPage(
            fixture.pool,
            { tenantId: repo.tenant_id, projectId: repo.project_id, policyEpoch: Number(repo.policy_epoch) },
            repo.repo_id,
          );
          assert.ok(page.processed <= 64);
          if (page.done) break;
        }
        assert.deepEqual(
          (
            await admin.query(
              `SELECT ready FROM ha_event_summary_state
            WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4`,
              parameters,
            )
          ).rows,
          [{ ready: true }],
          "the shared scheduler must commit the terminal publication before reporting done",
        );
      }
      await ensurePgProjectionSchema(admin);
      assert.equal(
        (await admin.query("SELECT to_regclass('ha_events_summary_pending') AS pending")).rows[0]!.pending,
        null,
        "all repositories backfilled and ready contract the pending index",
      );
      // Completed summaries must not hide a newly introduced event-index generation.
      await admin.query(
        "UPDATE ha_events SET read_index_version=5 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
        [...keys, repoId],
      );
      const { projection } = createPgStorageBackend({ pool: fixture.pool, repoId, scope });
      await assert.rejects(projection.readEventList({ entity: "missing", limit: 1 }), { code: "projection_pending" });
      assert.deepEqual(await backfillPgReadIndexPage(fixture.pool, scope, repoId), { processed: 1, done: false });
      assert.deepEqual(await backfillPgReadIndexPage(fixture.pool, scope, repoId), { processed: 0, done: true });
      assert.deepEqual((await projection.readEventList({ entity: "missing", limit: 1 })).rows, []);
    } finally {
      admin.release();
    }
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});

/** Pin a real concurrent build at PostgreSQL's writer wait, then commit a new writer.
 * No desktop/system services or timed scheduling participate in this test.
 */
async function assertOnlineIndexDml(admin: PoolClient, port: number, keys: readonly unknown[], summary = false) {
  const index = summary ? "ha_events_summary_pending" : "ha_decisions_state_order";
  const peers = new Pool({ host: "127.0.0.1", port, user: "postgres", database: "postgres", max: 2 }),
    blocker = await peers.connect(),
    observer = await peers.connect(),
    entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  let holding = false;
  await admin.query(`DROP INDEX IF EXISTS ${index}`);
  const pid = (await admin.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  const proxy = new Proxy(admin, {
    get(target, key) {
      if (key === "query")
        return async (sql: string, ...args: unknown[]) => {
          if (sql.startsWith(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index}`)) {
            entered.resolve();
            await resume.promise;
          }
          return Reflect.apply(target.query, target, [sql, ...args]);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await admin.query("SET statement_timeout=15000");
  const build = ensurePgProjectionSchema(proxy);
  const insert = async (client: PoolClient, id: string, writerScope = keys) => {
    if (summary) {
      await client.query(
        `INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,readers)
         VALUES($1,$2,$3,'online-'||$4,'{}') ON CONFLICT DO NOTHING`,
        [...writerScope, id],
      );
      return client.query(
        `INSERT INTO ha_events(tenant_id,project_id,policy_epoch,repo_id,revision,op_id,event_id,event_type,event_json,event_digest,occurred_at,readers)
         VALUES($1,$2,$3,'online-'||$4,1,$4,$4,'task_created',$5,'sha256:x','2026-11-05T00:00:00Z','{}')`,
        [...writerScope, id, JSON.stringify({ ...eventAt(1), opId: id, eventId: id })],
      );
    }
    return client.query(
      `INSERT INTO ha_decisions
       (tenant_id,project_id,policy_epoch,decision_id,workspace_revision,value)
       VALUES($1,$2,$3,$4,1,$5::jsonb)`,
      [...writerScope, id, JSON.stringify(reduceDecisionDocument(null, proposal(1, id)))],
    );
  };
  try {
    await Promise.race([
      entered.promise,
      build.then(() => {
        throw new Error(`concurrent build did not reach ${index}`);
      }),
    ]);
    await blocker.query("BEGIN");
    holding = true;
    await insert(blocker, "dec_online_blocker");
    resume.resolve();
    const deadline = Date.now() + 10000;
    for (;;) {
      const phase = (await observer.query("SELECT phase FROM pg_stat_progress_create_index WHERE pid=$1", [pid]))
        .rows[0]?.phase;
      if (phase === "waiting for writers before build") break;
      assert.ok(Date.now() < deadline, `concurrent build did not enter its writer wait; phase=${phase}`);
      await yieldTurn();
    }
    await observer.query("SET statement_timeout=2000");
    // Independent repositories share the physical table, not the repository-epoch
    // authority row. Keep row contention out of the test for table-wide DDL locks.
    await insert(observer, "dec_online_new_writer", [keys[0], `${String(keys[1])}-online`, keys[2]]);
    await observer.query("RESET statement_timeout");
    await blocker.query("COMMIT");
    holding = false;
    await build;
    process.stdout.write(
      `ONLINE_INDEX_DML ${JSON.stringify({ index, phase: "waiting for writers before build", newWriterCommitted: true })}\n`,
    );
  } finally {
    resume.resolve();
    try {
      if (holding) await blocker.query("ROLLBACK");
      await build;
    } finally {
      blocker.release();
      observer.release();
      await peers.end();
      await admin.query("RESET statement_timeout");
    }
  }
}

test("latest lease query uses the ordered index at 10000 and 100000 acquisitions", async (t) => {
  const fixture = await pgRuntimeFixture();
  try {
    for (const size of [10000, 100000]) {
      const scope = { tenantId: "latest-lease", projectId: String(size), policyEpoch: 1, readers: ["owner"] };
      await withPostgresTransaction(
        fixture.adminPool,
        async (client) => {
          await client.query(
            `INSERT INTO ha_projection_values
          (tenant_id,project_id,policy_epoch,readers,model,owner_id,entity_id,workspace_revision,value)
          SELECT $1,$2,$3,ARRAY['owner'],'lease-interval','target','interval-'||n,n,
          json_build_object('taskId','target','executionId','execution-'||(n%17),'acquiredRevision',n,
            'releasedRevision',CASE WHEN n=$4 THEN NULL ELSE n+1 END,'holder',json_build_object(),
            'previousHolder',NULL,'leaseExpiresAt','2099','reason','start')::text
          FROM generate_series(1,$4::integer)n`,
            [scope.tenantId, scope.projectId, scope.policyEpoch, size],
          );
          await client.query("ANALYZE ha_projection_values");
        },
        scope,
      );
      const plans: unknown[] = [],
        source = createPgTaskProjectionSource({
          pool: tracedPgReads(fixture.pool, plans, (sql) => /^\s*SELECT/u.test(sql)),
          scope,
          repoId: "latest-lease",
          ownsPool: false,
        });
      const latest = await source.readLatestLeaseInterval("target");
      assert.equal(latest.status, "ready");
      assert.equal(latest.interval?.acquiredRevision, size);
      assert.equal(latest.interval?.executionId, `execution-${size % 17}`);
      const nodes = explainNodes(
        plans.filter((plan) => (plan as { sql: string }).sql.includes("FROM ha_projection_values")),
      );
      assert.ok(nodes.some((row) => row["Index Name"] === "ha_projection_interval_order"));
      assert.ok(!nodes.some((row) => row["Node Type"] === "Sort"));
      const scans = nodes.filter((row) => row["Relation Name"] === "ha_projection_values");
      const visited = scans.reduce(
        (sum, row) =>
          sum +
          (Number(row["Actual Rows"]) +
            Number(row["Rows Removed by Filter"] ?? 0) +
            Number(row["Rows Removed by Index Recheck"] ?? 0)) *
            Number(row["Actual Loops"]),
        0,
      );
      assert.ok(visited <= 2, `ready guard + latest must stay bounded: ${visited}`);
      assert.deepEqual(await source.readLatestLeaseInterval("missing"), { status: "ready", interval: null });
      t.diagnostic(`LATEST_LEASE_PG ${JSON.stringify({ size, visited, returned: latest.interval ? 1 : 0 })}`);
    }
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
