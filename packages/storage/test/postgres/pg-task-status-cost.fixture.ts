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
    const index = await source.readTaskIndex({ taskIds: ["target"] });
    assert.deepEqual(
      index.rows.map(({ taskId }) => taskId),
      ["target"],
    );
    const sql = plans.map((plan) => String((plan as { sql?: unknown }).sql));
    assert.ok(
      !sql.some((statement) => /FROM ha_relations\b/iu.test(statement)),
      "a point index read must not hydrate task relations",
    );
    assert.ok(
      !sql.some((statement) => /\bsnapshot\s*,/iu.test(statement)),
      "a point index read must not transfer the full task snapshot",
    );
    observe("index/point", 1);
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
    assert.ok(large! <= small! + 20, `${key} scans ${small} -> ${large} for one selected task`);
    assert.ok(
      small! <= 4 && large! <= 4,
      `${key} must only seek the selected task and its children: ${small} -> ${large}`,
    );
  }
  // Default raw point read is the read a subtask creation performs on its parent before creating
  // the child. It must not walk the parent's descendants: grow the target's child count and check
  // the default read's plan stays constant. This is the production shape F14 regressed.
  const rawScope = { tenantId: "task-status-cost-raw", projectId: "task-status-cost-raw", policyEpoch: 1 },
    rawPairs: Record<string, number[]> = {};
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      await client.query(
        `INSERT INTO ha_task_snapshots
           (tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
         VALUES($1,$2,$3,'target',1,$4::jsonb) ON CONFLICT DO NOTHING`,
        [rawScope.tenantId, rawScope.projectId, rawScope.policyEpoch, JSON.stringify(snapshot)],
      );
      await client.query(
        `INSERT INTO ha_repo_heads
           (tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
         VALUES($1,$2,$3,'task-status-cost',1,'fixture','fixture','fixture') ON CONFLICT DO NOTHING`,
        [rawScope.tenantId, rawScope.projectId, rawScope.policyEpoch],
      );
      await client.query(
        `INSERT INTO ha_projection_meta
           (tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
         VALUES($1,$2,$3,$4,1,1) ON CONFLICT DO NOTHING`,
        [rawScope.tenantId, rawScope.projectId, rawScope.policyEpoch, PG_PROJECTION_SCHEMA_VERSION],
      );
    },
    rawScope,
  );
  for (const childCount of [2, 200]) {
    await withPostgresTransaction(
      seedPool,
      async (client) => {
        await client.query(
          `INSERT INTO ha_task_snapshots
             (tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
           SELECT $1,$2,$3,'child-'||n,1,
             jsonb_set(jsonb_set($4::jsonb,'{task,taskId}',to_jsonb('child-'||n)),
               '{task,metadata}',jsonb_build_object('parentTaskId','target'))
           FROM generate_series(1,$5::integer)n
           ON CONFLICT DO NOTHING`,
          [rawScope.tenantId, rawScope.projectId, rawScope.policyEpoch, JSON.stringify(snapshot), childCount],
        );
        await client.query("ANALYZE ha_task_snapshots");
      },
      rawScope,
    );
    const plans: unknown[] = [],
      source = createPgTaskProjectionSource({
        pool: tracedPgReads(pool, plans, (sql) => /^\s*(SELECT|WITH)\b/iu.test(sql)),
        scope: rawScope,
        repoId: "task-status-cost",
        ownsPool: false,
      });
    plans.length = 0;
    assert.equal((await source.read("target")).snapshot.task?.taskId, "target");
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
      );
    (rawPairs[`default-raw/${childCount}`] ??= []).push(visited);
    process.stdout.write(
      `TASK_STATUS_COST ${JSON.stringify({ backend, size: childCount, key: "default-raw", resultSize: 1, visited })}\n`,
    );
  }
  const [[rawSmall], [rawLarge]] = Object.values(rawPairs);
  assert.ok(
    rawLarge! <= rawSmall! + 20 && rawLarge! <= 4,
    `default raw read scans must not grow with descendants: ${rawSmall} -> ${rawLarge}`,
  );
  // A nullable parent is also a valid root: legacy rows must stay distinguishable
  // until the management path has filled their scalar, without blocking raw reads.
  const manage = <T>(operation: (client: import("pg").PoolClient) => Promise<T>) =>
      withPostgresTransaction(seedPool, operation, scope),
    keys = [scope.tenantId, scope.projectId, scope.policyEpoch],
    source = createPgTaskProjectionSource({ pool, scope, repoId: "task-status-cost", ownsPool: false }),
    stored = () =>
      manage(
        async (client) =>
          (
            await client.query<{ task_id: string; snapshot: unknown }>(
              "SELECT task_id,snapshot FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 ORDER BY task_id",
              keys,
            )
          ).rows,
      ),
    pending = () =>
      manage(async (client) =>
        Number(
          (
            await client.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND parent_index_version=0",
              keys,
            )
          ).rows[0]!.count,
        ),
      ),
    fill = async (client: import("pg").PoolClient) =>
      (
        await client.query<{ processed: number }>(
          "SELECT ha_backfill_projection_read_indexes($1,$2,$3) AS processed",
          keys,
        )
      ).rows[0]!.processed,
    original = await stored();
  await manage((client) =>
    client.query(
      "UPDATE ha_task_snapshots SET parent_task_id=NULL,parent_index_version=0 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
      keys,
    ),
  );
  assert.equal((await source.read("target")).snapshot.task?.status, "planned");
  await assert.rejects(source.read("target", true), { code: "projection_pending" });
  await assert.rejects(source.list({ parentTaskId: "target" }), { code: "projection_pending" });
  await assert.rejects(source.readTaskChildCounts(["target"]), { code: "projection_pending" });
  assert.deepEqual(await source.readTaskChildCounts([]), {});
  // An unchanged previous-writer UPDATE still passes through the installed trigger.
  await manage(async (client) => {
    await client.query(
      "UPDATE ha_task_snapshots SET snapshot=snapshot WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id='child-1'",
      keys,
    );
    const row = (
      await client.query<{ parent_task_id: string; parent_index_version: number }>(
        "SELECT parent_task_id,parent_index_version FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id='child-1'",
        keys,
      )
    ).rows[0]!;
    assert.deepEqual(row, { parent_task_id: "target", parent_index_version: 1 });
  });
  const count = await pending(),
    rollback = new Error("rollback parent expansion");
  assert.equal(count, 2002);
  await assert.rejects(
    manage(async (client) => {
      assert.equal(await fill(client), 64);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  assert.equal(await pending(), count);
  const outsideScope = { ...scope, projectId: "task-parent-outside" },
    outsideKeys = [outsideScope.tenantId, outsideScope.projectId, outsideScope.policyEpoch];
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      await client.query(
        `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
      VALUES($1,$2,$3,'outside',1,jsonb_set($4::jsonb,'{task,taskId}',to_jsonb('outside'::text)))`,
        [...outsideKeys, JSON.stringify(snapshot)],
      );
      await client.query(
        "UPDATE ha_task_snapshots SET parent_index_version=0 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
        outsideKeys,
      );
    },
    outsideScope,
  );
  let total = 0;
  const pages: number[] = [];
  for (;;) {
    const processed = await manage(fill);
    assert.ok(processed >= 0 && processed <= 64);
    pages.push(processed);
    if (processed === 0) break;
    total += processed;
    assert.ok(total <= count, "backfill must advance a bounded set of pending rows");
  }
  assert.equal(total, count);
  assert.equal(await pending(), 0);
  assert.deepEqual(await stored(), original, "backfill preserves every snapshot");
  assert.equal((await source.read("target", true)).snapshot.task?.status, "planned");
  assert.deepEqual(await source.readTaskChildCounts(["target"]), { target: 2 });
  assert.deepEqual(
    (await source.list({ parentTaskId: "target" })).rows.map(({ taskId }) => taskId),
    ["child-1", "child-2"],
  );
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      assert.equal(
        (
          await client.query<{ parent_index_version: number }>(
            "SELECT parent_index_version FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
            outsideKeys,
          )
        ).rows[0]!.parent_index_version,
        0,
      );
    },
    outsideScope,
  );
  process.stdout.write(
    `TASK_PARENT_UPGRADE ${JSON.stringify({ backend, pages, total, rolledBack: 64, snapshotsPreserved: original.length, outsideScopeUntouched: true })}\n`,
  );
}
