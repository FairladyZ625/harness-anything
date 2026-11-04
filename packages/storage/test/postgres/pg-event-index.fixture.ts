import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { tracedPgReads, explainNodes } from "./pg-explain.fixture.ts";

const scope = { tenantId: "event-index", projectId: "event-index", policyEpoch: 1 },
  repoId = "event-index";
export async function assertEventIndexes(pool: Pool, seedPool: Pool, backend: string): Promise<void> {
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      await client.query(
        `INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
      VALUES($1,$2,$3,$4,100005,'fixture','fixture','fixture')`,
        [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
      );
      await client.query(
        `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
      VALUES($1,$2,$3,5,100005,100005)`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      await client.query(
        `INSERT INTO ha_events
      (tenant_id,project_id,policy_epoch,repo_id,revision,op_id,event_id,event_type,event_digest,occurred_at,event_json)
      SELECT $1,$2,$3,$4,n,'history-' || n::text,'history-' || n::text,
        CASE n%3 WHEN 0 THEN 'schedule_created' WHEN 1 THEN 'runtime_session_started' ELSE 'fact_recorded' END,'fixture','2020-01-01',
        json_build_object('schema',CASE n%3 WHEN 0 THEN 'schedule-event/v1' WHEN 1 THEN 'agent-runtime-event/v1' ELSE 'fact-event/v1' END,
          'type',CASE n%3 WHEN 0 THEN 'schedule_created' WHEN 1 THEN 'runtime_session_started' ELSE 'fact_recorded' END,
          'factId','H-' || n::text,'entity',json_build_object('id','history-' || n::text),'opId','history-' || n::text,
          'eventId','history-' || n::text,'workspaceRevision',n,'occurredAt','2020-01-01',
          'actor',json_build_object('executor',json_build_object('id','runtime-session:history'),'principal',json_build_object('personId','person/test')),
          'source','local','payload',json_build_object('runtimeSessionId','history-' || n::text))::text
      FROM generate_series(1,100000)n`,
        [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
      );
      for (const [ordinal, schema, type, entityId, sessionId, executor] of [
        [1, "schedule-event/v1", "schedule_created", "target", null, null],
        [2, "schedule-event/v1", "schedule_updated", "other", null, null],
        [3, "agent-runtime-event/v1", "runtime_session_started", null, "session-target", null],
        [4, "fact-event/v1", "fact_recorded", null, null, "runtime-session:session-output"],
        [5, "fact-event/v1", "fact_recorded", null, null, null],
      ] as const) {
        const event = {
          schema,
          type,
          entityId,
          factId: type === "fact_recorded" ? `F-${ordinal}` : undefined,
          entity: { id: entityId },
          payload: { runtimeSessionId: sessionId, statement: "plain text" },
          actor: { executor: executor ? { id: executor } : null, principal: { personId: "person/test" } },
          workspaceRevision: 100000 + ordinal,
          eventId: `target-${ordinal}`,
          opId: `target-${ordinal}`,
          occurredAt: "2026-11-04",
          source: "local",
        };
        await client.query(
          `INSERT INTO ha_events(tenant_id,project_id,policy_epoch,repo_id,revision,op_id,event_id,event_type,event_digest,occurred_at,event_json)
        VALUES($1,$2,$3,$4,$5,$6,$6,$7,'fixture',$8,$9)`,
          [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
            repoId,
            event.workspaceRevision,
            event.opId,
            type,
            event.occurredAt,
            JSON.stringify(event),
          ],
        );
      }
      await client.query(
        `INSERT INTO ha_facts(tenant_id,project_id,policy_epoch,fact_id,workspace_revision,value)
        SELECT $1,$2,$3,'H-' || n::text,1,jsonb_build_object('ref','fact/H-' || n::text,'factId','H-' || n::text)
        FROM generate_series(1,100000)n`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      await client.query(
        `INSERT INTO ha_facts(tenant_id,project_id,policy_epoch,fact_id,workspace_revision,value)
        VALUES($1,$2,$3,'F-4',100004,'{"ref":"fact/F-4","factId":"F-4","taskId":"target"}')`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      await client.query("ANALYZE");
    },
    scope,
  );
  const plans: unknown[] = [],
    traced = tracedPgReads(pool, plans, (sql) => /^\s*SELECT[\s\S]*FROM ha_events/u.test(sql)),
    source = createPgTaskProjectionSource({ pool: traced, scope, repoId, ownsPool: false });
  assert.equal((await source.readScheduleEvents("target")).events.length, 1);
  assert.equal((await source.readScheduleEvents()).events.length, 33335);
  assert.equal((await source.readRuntimeSessionEvents("session-target", 0, 1)).length, 1);
  assert.equal((await source.readScheduleOutputEvents(["session-output"])).length, 1);
  assert.equal(
    (await source.readReckoningEvents({ type: "fact_recorded", after: "2026-11-04", before: "2026-11-04" })).length,
    2,
  );
  const anchor = await source.readFactAnchors(["fact/F-4"]);
  assert.deepEqual(anchor.rows, [
    { factRef: "fact/F-4", factId: "F-4", taskId: "target", sourcePath: "event:target-4" },
  ]);
  process.stdout.write(`EVENT_INDEX ${backend} ${JSON.stringify(plans)}\n`);
  const scans = explainNodes(plans).filter((row) => row["Relation Name"] === "ha_events");
  assert.ok(scans.length >= 5, "every production event query must be explained");
  for (const entry of plans as { sql: string; plan: unknown }[]) {
    const budget =
      entry.sql.includes("event_schema = 'schedule-event/v1'") && !entry.sql.includes("event_entity_id") ? 33335 : 2;
    for (const scan of explainNodes(entry.plan).filter((row) =>
      ["ha_events", "ha_facts"].includes(String(row["Relation Name"])),
    ))
      assert.ok(
        (Number(scan["Actual Rows"]) + Number(scan["Rows Removed by Filter"] ?? 0)) * Number(scan["Actual Loops"]) <=
          budget,
        `event predicate scanned unrelated history: ${JSON.stringify(scan)}`,
      );
  }
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      const before = (
          await client.query<{ event_json: string }>(
            "SELECT event_json FROM ha_events WHERE tenant_id=$1 AND revision=100004",
            [scope.tenantId],
          )
        ).rows[0]!.event_json,
        event = JSON.parse(before),
        value = JSON.stringify({ ...event, payload: { ...event.payload, statement: "NUL\0\0😀" } });
      await client.query("UPDATE ha_events SET event_json=$2 WHERE tenant_id=$1 AND revision=100004", [
        scope.tenantId,
        value,
      ]);
      assert.equal(
        (
          await client.query<{ event_json: string }>(
            "SELECT event_json FROM ha_events WHERE tenant_id=$1 AND revision=100004",
            [scope.tenantId],
          )
        ).rows[0]!.event_json,
        value,
      );
    },
    scope,
  );
  assert.equal((await source.readScheduleOutputEvents(["session-output"])).length, 1);
}
