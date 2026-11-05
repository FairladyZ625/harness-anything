import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
} from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { PG_PROJECTION_SCHEMA_VERSION } from "../../src/pg/pg-projection-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { tracedPgReads, explainNodes, reportPgVersion } from "./pg-explain.fixture.ts";

export async function assertTaskStatusCost(pool: Pool, seedPool: Pool, backend: string): Promise<void> {
  const scope = { tenantId: "task-status-cost", projectId: "task-status-cost", policyEpoch: 1 },
    events = lifecycleFixture({ taskId: "target", executionId: "target-execution" }).events,
    snapshot = reduceTaskEvent(emptyTaskLifecycleSnapshot(), events[0]!);
  await reportPgVersion(pool, backend);
  const pairs: Record<string, number[]> = {};
  for (const size of [200, 2000]) {
    await withPostgresTransaction(
      seedPool,
      async (client) => {
        await client.query(
          `INSERT INTO ha_task_snapshots
        (tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
        SELECT $1,$2,$3,'history-'||lpad(n::text,6,'0'),1,
          jsonb_set($4::jsonb,'{task,taskId}',to_jsonb('history-'||lpad(n::text,6,'0')))
        FROM generate_series(1,$5::integer)n ON CONFLICT DO NOTHING`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, JSON.stringify(snapshot), size],
        );
        await client.query(
          `INSERT INTO ha_task_snapshots
        (tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
        VALUES($1,$2,$3,'target',1,$4::jsonb) ON CONFLICT DO NOTHING`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, JSON.stringify(snapshot)],
        );
        await client.query(
          `INSERT INTO ha_repo_heads
        (tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
        VALUES($1,$2,$3,'task-status-cost',1,'fixture','fixture','fixture') ON CONFLICT DO NOTHING`,
          [scope.tenantId, scope.projectId, scope.policyEpoch],
        );
        await client.query(
          `INSERT INTO ha_projection_meta
        (tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
        VALUES($1,$2,$3,$4,1,1) ON CONFLICT DO NOTHING`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, PG_PROJECTION_SCHEMA_VERSION],
        );
        await client.query(
          `INSERT INTO ha_task_snapshots
        (tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
        SELECT $1,$2,$3,'child-'||n,1,
          jsonb_set(jsonb_set($4::jsonb,'{task,taskId}',to_jsonb('child-'||n)),
            '{task,metadata}',jsonb_build_object('parentTaskId','target'))
        FROM generate_series(1,2)n ON CONFLICT DO NOTHING`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, JSON.stringify(snapshot)],
        );
        await client.query("ANALYZE ha_task_snapshots");
      },
      scope,
    );
    const plans: unknown[] = [],
      source = createPgTaskProjectionSource({
        pool: tracedPgReads(pool, plans, (sql) => /^\s*(SELECT|WITH)\b/iu.test(sql)),
        scope,
        repoId: "task-status-cost",
        ownsPool: false,
      });
    assert.deepEqual(await source.readCut(), { status: "ready", watermark: 1, sourceRevision: 1 });
    const observe = (name: string, resultSize: number) => {
      const scans = explainNodes(plans).filter((row) => row["Relation Name"] === "ha_task_snapshots"),
        visited = scans.reduce(
          (sum, row) =>
            sum +
            Math.max(
              Number(row["Heap Fetches"] ?? 0),
              Number(row["Actual Rows"]) +
                Number(row["Rows Removed by Filter"] ?? 0) +
                Number(row["Rows Removed by Index Recheck"] ?? 0),
            ) *
              Number(row["Actual Loops"]),
          0,
        ),
        key = name;
      (pairs[key] ??= []).push(visited);
      process.stdout.write(`TASK_STATUS_COST ${JSON.stringify({ backend, size, key, resultSize, visited })}\n`);
    };
    for (const presentationStatus of [false, true]) {
      for (const method of ["read", "list"] as const) {
        plans.length = 0;
        const task =
          method === "read"
            ? (await source.read("target", presentationStatus)).snapshot.task
            : (await source.list({ taskIds: ["target"], presentationStatus, limit: 1 })).rows[0]!.snapshot.task;
        assert.equal(task?.taskId, "target");
        assert.equal(task.status, "planned");
        observe(`${method}/${presentationStatus ? "presentation" : "raw"}`, 1);
      }
    }
    plans.length = 0;
    assert.deepEqual((await source.list({ parentTaskId: "missing", limit: 1 })).rows, []);
    observe("parent/missing", 0);
    plans.length = 0;
    const roots = await source.list({ parentTaskId: null, limit: 1 });
    assert.equal(roots.rows.length, 1);
    assert.equal(roots.rows[0]!.snapshot.task?.metadata?.parentTaskId ?? null, null);
    observe("parent/null", 1);
    plans.length = 0;
    const first = await source.list({ parentTaskId: "target", limit: 1 });
    assert.deepEqual(
      first.rows.map(({ taskId }) => taskId),
      ["child-1"],
    );
    assert.ok(first.page?.nextCursor);
    observe("parent/first-page", 1);
    plans.length = 0;
    const last = await source.list({ parentTaskId: "target", limit: 1, cursor: first.page.nextCursor });
    assert.deepEqual(
      last.rows.map(({ taskId }) => taskId),
      ["child-2"],
    );
    assert.equal(last.page?.nextCursor, null);
    observe("parent/last-page", 1);
  }
  for (const [key, [small, large]] of Object.entries(pairs)) {
    assert.ok(large! <= small! + 20, `${key} scans ${small} -> ${large} for one leaf`);
    assert.ok(large! <= 4, `${key} must only seek the selected task and its children`);
  }
}
