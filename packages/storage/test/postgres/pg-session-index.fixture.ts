import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { tracedPgReads, explainNodes } from "./pg-explain.fixture.ts";

const scope = { tenantId: "session-index", projectId: "session-index", policyEpoch: 1 };
export async function assertSessionIndexes(pool: Pool, seedPool: Pool, backend: string): Promise<void> {
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      await client.query(
        `INSERT INTO ha_projection_values
      (tenant_id,project_id,policy_epoch,model,entity_id,owner_id,workspace_revision,value)
      SELECT $1,$2,$3,'runtime-session','session-' || lpad(n::text,6,'0'),'',1,
        json_build_object('runtimeSessionId','session-' || lpad(n::text,6,'0'),
          'liveness',CASE WHEN n>100150 THEN 'alive' ELSE 'exited' END,
          'taskBindings',json_build_array(json_build_object('taskId',CASE WHEN n>100000 THEN 'target' ELSE 'history' END,
            'executionId','execution-' || n::text)))::text FROM generate_series(1,100200)n`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      await client.query(
        `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
      VALUES($1,$2,$3,'target',1,'{"task":{"title":"Target"}}')`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      await client.query("ANALYZE ha_projection_values");
      await client.query("ANALYZE ha_runtime_session_tasks");
      assert.equal(
        (
          await client.query(
            "SELECT 1 FROM ha_projection_values WHERE tenant_id=$1 AND model='runtime-session' AND value::json->>'liveness'='alive'",
            [scope.tenantId],
          )
        ).rows.length,
        50,
      );
    },
    scope,
  );
  const plans: unknown[] = [],
    traced = tracedPgReads(pool, plans, (sql) =>
      /^\s*SELECT[\s\S]*(?:FROM ha_projection_values|FROM ha_runtime_session_tasks)/u.test(sql),
    ),
    source = createPgTaskProjectionSource({ pool: traced, scope, repoId: "session-index", ownsPool: false });
  assert.equal((await source.readRuntimeSessionsForTask("target")).length, 200);
  assert.deepEqual(await source.readRuntimeSessionsForTask("absent"), []);
  const batch = await source.readTaskRuntimeBatch({ taskIds: ["target"] });
  assert.equal(batch.rows[0]!.sessions.length, 200);
  process.stdout.write(`SESSION_INDEX ${backend} binding-and-batch ${JSON.stringify(plans)}\n`);
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
  process.stdout.write(`SESSION_INDEX ${backend} pages-including-legacy-exact-count ${JSON.stringify(plans)}\n`);
}
