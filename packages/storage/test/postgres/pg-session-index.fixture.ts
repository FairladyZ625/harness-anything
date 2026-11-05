import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { tracedPgReads, explainNodes, reportPgVersion, measurePgRead } from "./pg-explain.fixture.ts";

import { assertDispatchIndexes } from "./pg-dispatch-index.fixture.ts";
import { legacyValueSql, measureLegacySelector } from "./pg-legacy-read-plans.fixture.ts";

const scope = { tenantId: "session-index", projectId: "session-index", policyEpoch: 1 };
export async function assertSessionIndexes(pool: Pool, seedPool: Pool, backend: string): Promise<void> {
  await reportPgVersion(pool, backend);
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      await client.query(
        `INSERT INTO ha_projection_values
      (tenant_id,project_id,policy_epoch,model,entity_id,owner_id,workspace_revision,value)
      SELECT $1,$2,$3,'runtime-session','session-' || lpad(n::text,6,'0'),'',1,
        json_build_object('runtimeSessionId','session-' || lpad(n::text,6,'0'),
          'liveness',CASE WHEN n>100150 THEN 'live' ELSE 'exited' END,
          'outcome',CASE WHEN n>100150 THEN NULL ELSE 'succeeded' END,
          'taskBindings',json_build_array(json_build_object('taskId',CASE WHEN n>100000 THEN 'target' ELSE 'history' END,
            'executionId','execution-' || n::text)))::text FROM generate_series(1,100200)n`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      await client.query(
        `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
      VALUES($1,$2,$3,'target',1,'{"task":{"title":"Target"}}')`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      await client.query("ANALYZE");
      assert.equal(
        (
          await client.query(
            "SELECT 1 FROM ha_projection_values WHERE tenant_id=$1 AND model='runtime-session' AND value::json->>'liveness'='live'",
            [scope.tenantId],
          )
        ).rows.length,
        50,
      );
    },
    scope,
  );
  // These three old methods loaded this complete model before their JS task/page selection.
  // Measure the archived selector separately: it excludes that decoding/filtering cost.
  for (const method of ["readRuntimeSessionsForTask", "readTaskRuntimeBatch", "readRuntimeSessionPage (bounded)"])
    await measureLegacySelector(pool, scope, backend, method, legacyValueSql(), [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      "runtime-session",
      [],
    ]);
  const plans: unknown[] = [],
    traced = tracedPgReads(pool, plans, (sql) =>
      /^\s*(?:SELECT|WITH RECURSIVE)[\s\S]*(?:FROM ha_projection_values|FROM ha_runtime_session_tasks|FROM ha_events|JOIN ha_projection_values)/u.test(
        sql,
      ),
    ),
    source = createPgTaskProjectionSource({ pool: traced, scope, repoId: "session-index", ownsPool: false });
  assert.equal((await source.readRuntimeSessions({ unsettledOnly: true })).length, 50);
  process.stdout.write(`SESSION_INDEX ${backend} unsettled-only ${JSON.stringify(plans)}\n`);
  for (const scan of explainNodes(plans).filter((row) => row["Relation Name"] === "ha_projection_values"))
    assert.ok(
      (Number(scan["Actual Rows"]) + Number(scan["Rows Removed by Filter"] ?? 0)) * Number(scan["Actual Loops"]) <= 50,
      `unsettled sessions scanned settled history: ${JSON.stringify(scan)}`,
    );
  plans.length = 0;
  assert.equal((await source.readRuntimeSessionsForTask("target")).length, 200);
  await withPostgresTransaction(
    pool,
    (client) =>
      client.query(
        "UPDATE ha_projection_values SET read_index_version=1,runtime_outcome=NULL WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='runtime-session' AND entity_id='session-000001'",
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      ),
    scope,
  );
  assert.equal(
    (await source.readRuntimeSessions({ runtimeSessionId: "session-000001" })).length,
    1,
    "plain point reads do not depend on an unrelated index expansion",
  );
  assert.equal(
    (await source.readRuntimeSessions({ unsettledOnly: true })).length,
    50,
    "legacy outcome reader excludes settled sessions",
  );
  assert.equal(
    (
      await withPostgresTransaction(
        pool,
        (client) =>
          client.query("SELECT ha_backfill_projection_read_indexes($1,$2,$3) AS processed", [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
          ]),
        scope,
      )
    ).rows[0]!.processed,
    1,
  );
  assert.equal((await source.readRuntimeSessions({ unsettledOnly: true })).length, 50);
  plans.length = 0;
  assert.deepEqual(await source.readRuntimeSessionsForTask("absent"), []);
  const batch = await source.readTaskRuntimeBatch({ taskIds: ["target"] });
  assert.equal(batch.rows[0]!.sessions.length, 200);
  process.stdout.write(`SESSION_INDEX ${backend} binding-and-batch ${JSON.stringify(plans)}\n`);
  const timed = createPgTaskProjectionSource({ pool, scope, repoId: "session-index", ownsPool: false });
  await measurePgRead(backend, "readRuntimeSessions(unsettledOnly)", () =>
    timed.readRuntimeSessions({ unsettledOnly: true }),
  );
  await measurePgRead(backend, "readRuntimeSessionsForTask", () => timed.readRuntimeSessionsForTask("target"));
  await measurePgRead(backend, "readTaskRuntimeBatch", () => timed.readTaskRuntimeBatch({ taskIds: ["target"] }));
  for (const scan of explainNodes(plans).filter((row) =>
    ["ha_projection_values", "ha_runtime_session_tasks"].includes(String(row["Relation Name"])),
  ))
    assert.ok(
      (Number(scan["Actual Rows"]) + Number(scan["Rows Removed by Filter"] ?? 0)) * Number(scan["Actual Loops"]) <= 200,
      `task session query scanned unrelated history: ${JSON.stringify(scan)}`,
    );
  plans.length = 0;
  let cursor: string | undefined,
    seen = 0;
  do {
    const page = await source.readRuntimeSessionPage({
      taskId: "target",
      limit: 64,
      ...(cursor ? { afterRuntimeSessionId: cursor } : {}),
    });
    seen += page.rows.length;
    cursor = page.nextRuntimeSessionId ?? undefined;
  } while (cursor);
  assert.equal(seen, 200);
  assert.deepEqual(
    (await source.readRuntimeSessionPage({ taskId: "target", limit: 64, afterRuntimeSessionId: "session-100200" }))
      .rows,
    [],
  );
  assert.equal((await source.readRuntimeSessionPage({ limit: 2 })).rows[0]!.runtimeSessionId, "session-000001");
  process.stdout.write(`SESSION_INDEX ${backend} bounded-keyset-pages ${JSON.stringify(plans)}\n`);
  for (const scan of explainNodes(plans).filter((row) =>
    ["ha_projection_values", "ha_runtime_session_tasks"].includes(String(row["Relation Name"])),
  ))
    assert.ok(
      (Number(scan["Actual Rows"]) + Number(scan["Rows Removed by Filter"] ?? 0)) * Number(scan["Actual Loops"]) <= 65,
      `session page scanned more than its page plus one: ${JSON.stringify(scan)}`,
    );
  await measurePgRead(backend, "readRuntimeSessionPage (bounded)", () => timed.readRuntimeSessionPage({ limit: 64 }));
  plans.length = 0;
  assert.equal(
    (await source.readRuntimeSessionPage({ limit: 64, includeRemainingCount: true })).remainingCount,
    100136,
  );
  process.stdout.write(`SESSION_INDEX ${backend} explicit-legacy-exact-count ${JSON.stringify(plans)}\n`);
  await assertDispatchIndexes(pool, seedPool, backend);
  // #4288's old point+node selector: one session must not scan its repository's dispatches.
  await measureLegacySelector(
    pool,
    scope,
    backend,
    "readRuntimeSessions(point + node + unsettled)",
    `SELECT v.value FROM ha_projection_values v WHERE v.tenant_id=$1 AND v.project_id=$2 AND v.policy_epoch=$3
    AND v.model='runtime-session' AND (cardinality($4::text[])=0 OR v.readers && $4::text[]) AND v.entity_id=$5
    AND (v.value::jsonb->>'outcome') IS NULL AND EXISTS (
      SELECT 1 FROM ha_events e WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.policy_epoch=$3 AND e.repo_id=$6
      AND e.event_type='runtime_dispatch_requested' AND e.event_json::jsonb->>'schema'='agent-runtime-event/v1'
      AND e.event_json::jsonb#>>'{payload,runtimeSessionId}'=v.entity_id AND e.event_json::jsonb#>>'{source,nodeId}'=$7)
    ORDER BY v.entity_id,v.owner_id`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, [], "session-100200", "session-index", "node-target"],
    "2b3fd5365f524696a7fd6d23821f2096adc9589e",
  );
  plans.length = 0;
  const node = await source.readRuntimeSessions({ unsettledOnly: true, executionOwnerNodeId: "node-target" });
  assert.deepEqual(
    node.map(({ runtimeSessionId }) => runtimeSessionId),
    ["session-100200"],
  );
  assert.deepEqual(await source.readRuntimeSessions({ unsettledOnly: true, executionOwnerNodeId: "node-history" }), []);
  assert.deepEqual(
    await source.readRuntimeSessions({ runtimeSessionId: "session-100200", executionOwnerNodeId: "node-history" }),
    [],
  );
  process.stdout.write(`SESSION_INDEX ${backend} node-unsettled ${JSON.stringify(plans)}\n`);
  for (const scan of explainNodes(plans).filter((row) =>
    ["ha_events", "ha_projection_values"].includes(String(row["Relation Name"])),
  ))
    assert.ok(
      (Number(scan["Actual Rows"]) + Number(scan["Rows Removed by Filter"] ?? 0)) * Number(scan["Actual Loops"]) <= 1,
      `node recovery scanned other nodes or settled history: ${JSON.stringify(scan)}`,
    );
  await measurePgRead(backend, "readRuntimeSessions(node + unsettled)", () =>
    timed.readRuntimeSessions({ unsettledOnly: true, executionOwnerNodeId: "node-target" }),
  );
  const original = await withPostgresTransaction(
    pool,
    async (client) => {
      const value = (
        await client.query<{ value: string }>(
          "SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='runtime-session' AND owner_id='' AND entity_id='session-100200'",
          [scope.tenantId, scope.projectId, scope.policyEpoch],
        )
      ).rows[0]!.value;
      await client.query(
        "UPDATE ha_projection_values SET value=$4 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='runtime-session' AND owner_id='' AND entity_id='session-100200'",
        [
          scope.tenantId,
          scope.projectId,
          scope.policyEpoch,
          JSON.stringify({ ...JSON.parse(value), outcome: "succeeded" }),
        ],
      );
      return value;
    },
    scope,
  );
  assert.deepEqual(await timed.readRuntimeSessions({ unsettledOnly: true, executionOwnerNodeId: "node-target" }), []);
  assert.equal(
    (await timed.readRuntimeSessions({ runtimeSessionId: "session-100200", executionOwnerNodeId: "node-target" }))
      .length,
    1,
    "settled local live-stream recovery remains a point read",
  );
  plans.length = 0;
  assert.equal((await source.readRuntimeSessions({ executionOwnerNodeId: "node-target" })).length, 2);
  assert.equal((await source.readRuntimeSessions({ executionOwnerNodeId: "node-history" })).length, 1);
  process.stdout.write(`SESSION_INDEX ${backend} node-all-distinct ${JSON.stringify(plans)}\n`);
  for (const scan of explainNodes(plans).filter((row) =>
    ["ha_events", "ha_projection_values"].includes(String(row["Relation Name"])),
  ))
    assert.ok(
      (Number(scan["Actual Rows"]) + Number(scan["Rows Removed by Filter"] ?? 0)) * Number(scan["Actual Loops"]) <= 2,
      `node all read scanned duplicate history: ${JSON.stringify(scan)}`,
    );
  await withPostgresTransaction(
    pool,
    (client) =>
      client.query(
        "UPDATE ha_projection_values SET value=$4 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='runtime-session' AND owner_id='' AND entity_id='session-100200'",
        [scope.tenantId, scope.projectId, scope.policyEpoch, original],
      ),
    scope,
  );
  assert.equal(
    (await timed.readRuntimeSessions({ unsettledOnly: true, executionOwnerNodeId: "node-target" })).length,
    1,
  );
}
