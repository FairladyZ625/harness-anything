import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { explainNodes, measurePgRead, tracedPgReads } from "./pg-explain.fixture.ts";

/** Reuses the session corpus: 100k dispatches for one session must not make a member read scan them. */
export async function assertDispatchIndexes(pool: Pool, seedPool: Pool, backend: string): Promise<void> {
  const scope = { tenantId: "session-index", projectId: "session-index", policyEpoch: 1 },
    repoId = "session-index";
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      await client.query(
        `INSERT INTO ha_repo_heads
      (tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
      VALUES($1,$2,$3,$4,100002,'fixture','fixture','fixture')`,
        [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
      );
      await client.query(
        `INSERT INTO ha_projection_meta
      (tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
      VALUES($1,$2,$3,5,100002,100002)`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      await client.query(
        `INSERT INTO ha_events
      (tenant_id,project_id,policy_epoch,repo_id,revision,op_id,event_id,event_type,event_digest,occurred_at,event_json)
      SELECT $1,$2,$3,$4,n,'dispatch-'||n,'dispatch-'||n,'runtime_dispatch_requested','fixture','2026-11-04',
        json_build_object('schema','agent-runtime-event/v1','type','runtime_dispatch_requested',
          'eventId','dispatch-'||n,'opId','dispatch-'||n,'workspaceRevision',n,'occurredAt','2026-11-04',
          'actor',json_build_object('executor',null,'principal',json_build_object('personId','test')),
          'source','local','payload',json_build_object('dispatchId',CASE WHEN n>100000 THEN 'target-'||n ELSE 'history-'||lpad(n::text,6,'0') END,
            'dispatchKey','key-'||n,'runtimeSessionId',CASE WHEN n=100001 THEN 'session-100200' ELSE 'session-000001' END,
            'definitionSnapshotRef','definition-'||n,'taskId',CASE WHEN n>100000 THEN 'target' ELSE 'history' END,
            'executionId','execution-target','agentId','agent-target','squadId','squad-target',
            'startedAt',CASE WHEN n>100000 THEN '2026-11-04' ELSE '2020-01-01' END,
            'resumedFromDispatchId',CASE WHEN n=100002 THEN 'target-100001' END,
            'attemptGroupId',CASE WHEN n>100000 THEN 'attempt-target' END,
            'reviewTarget',CASE WHEN n>100000 THEN json_build_object('kind','decision','decisionId','decision-target') END))::text
      FROM generate_series(1,100002)n`,
        [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
      );
      // Simulate the preceding expansion's rows, not just a fresh schema. Readiness must detect v1.
      await client.query("UPDATE ha_events SET read_index_version=1 WHERE tenant_id=$1 AND revision=100002", [
        scope.tenantId,
      ]);
      await client.query("ANALYZE");
    },
    scope,
  );
  const plans: unknown[] = [],
    source = createPgTaskProjectionSource({
      pool: tracedPgReads(pool, plans, (sql) => /FROM ha_events/u.test(sql)),
      scope,
      repoId,
      ownsPool: false,
    });
  await assert.rejects(() => source.readRuntimeDispatchById("target-100002"), { code: "projection_pending" });
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      assert.equal(
        (
          await client.query("SELECT ha_backfill_event_read_indexes($1,$2,$3,$4) AS processed", [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
            repoId,
          ])
        ).rows[0].processed,
        1,
      );
      assert.equal(
        (
          await client.query("SELECT ha_backfill_event_read_indexes($1,$2,$3,$4) AS processed", [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
            repoId,
          ])
        ).rows[0].processed,
        0,
      );
    },
    scope,
  );
  plans.length = 0;
  assert.equal((await source.readRuntimeDispatchById("target-100002"))?.event.payload.dispatchId, "target-100002");
  assert.equal(
    (await source.readRuntimeDispatch("session-000001", "definition-100002"))?.payload.dispatchId,
    "target-100002",
  );
  assert.equal(
    (await source.readRuntimeDispatchByResumeSource("target-100001"))?.event.payload.dispatchId,
    "target-100002",
  );
  assert.equal((await source.readRuntimeDispatchesByTaskIds(["target"])).length, 2);
  assert.equal((await source.readRuntimeDispatchesByTaskExecution("target", "execution-target")).length, 2);
  assert.equal((await source.readRuntimeDispatchesByAttemptGroup("attempt-target")).length, 2);
  assert.equal((await source.readRuntimeDispatchesByDecision("decision-target")).length, 2);
  assert.equal((await source.readRuntimeDispatchByDispatchIdPrefix("target-", 1)).length, 1);
  assert.equal((await source.readRuntimeDispatchPage({ startedAtGte: "2026-11-04", limit: 1 })).rows.length, 1);
  for (const member of [{ agentId: "agent-target" }, { squadId: "squad-target" }]) {
    const page = await source.readRuntimeDispatchesByMember({ ...member, limit: 1 });
    assert.equal(page.rows[0]?.payload.dispatchId, "target-100002");
    assert.equal(page.truncated, true);
    assert.deepEqual(
      page.sessions.map((session) => session.runtimeSessionId),
      ["session-000001", "session-100200"],
    );
  }
  process.stdout.write(`DISPATCH_INDEX ${backend} ${JSON.stringify(plans)}\n`);
  for (const scan of explainNodes(plans).filter((row) =>
    ["ha_events", "ha_projection_values"].includes(String(row["Relation Name"])),
  ))
    assert.ok(
      (Number(scan["Actual Rows"]) + Number(scan["Rows Removed by Filter"] ?? 0)) * Number(scan["Actual Loops"]) <= 6,
      `dispatch read scanned unrelated history: ${JSON.stringify(scan)}`,
    );
  const timed = createPgTaskProjectionSource({ pool, scope, repoId, ownsPool: false });
  await measurePgRead(backend, "readRuntimeDispatchById", () => timed.readRuntimeDispatchById("target-100002"));
  await measurePgRead(backend, "readRuntimeDispatchesByMember", () =>
    timed.readRuntimeDispatchesByMember({ agentId: "agent-target", limit: 1 }),
  );
}
