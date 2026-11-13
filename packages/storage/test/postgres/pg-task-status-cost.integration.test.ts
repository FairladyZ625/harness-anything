// harness-test-tier: integration
import test from "node:test";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { assertTaskStatusCost } from "./pg-task-status-cost.fixture.ts";

test("PG raw and presentation task reads exclude unrelated task history", async () => {
  const fixture = await pgRuntimeFixture();
  try {
    await assertTaskStatusCost(fixture.pool, fixture.adminPool, "postgres");
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});

// These cases exercise the real schema upgrader, RLS runtime queries and management
// batch function. A same-name IF NOT EXISTS index is deliberately present at upgrade.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
} from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { rebuildPgProjection } from "../../src/pg/pg-task-event-materialize.ts";
import { ensurePgProjectionSchema } from "../../src/pg/pg-projection-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { tracedPgReads, explainNodes } from "./pg-explain.fixture.ts";

test("PG task lists and legacy index upgrade preserve wide titles and bounded reads", async () => {
  const fixture = await pgRuntimeFixture();
  const scope = { tenantId: "task-list-upgrade", projectId: "task-list-upgrade", policyEpoch: 1 };
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch];
  const snapshot = reduceTaskEvent(emptyTaskLifecycleSnapshot(), lifecycleFixture({ taskId: "target" }).events[0]!);
  const plans: unknown[] = [];
  const source = createPgTaskProjectionSource({
    pool: tracedPgReads(fixture.pool, plans, (sql) => /^\s*(SELECT|WITH)\b/iu.test(sql)),
    scope,
    repoId: "task-list-upgrade",
    ownsPool: false,
  });
  const manage = <T>(run: (client: import("pg").PoolClient) => Promise<T>) =>
    withPostgresTransaction(fixture.adminPool, run, scope);
  const pairs: Record<string, number[]> = {};
  const observe = (name: string, size: number) => {
    const visited = explainNodes(plans)
      .filter((node) => node["Relation Name"] === "ha_task_snapshots")
      .reduce(
        (sum, node) =>
          sum +
          Math.max(
            Number(node["Heap Fetches"] ?? 0),
            Number(node["Actual Rows"]) +
              Number(node["Rows Removed by Filter"] ?? 0) +
              Number(node["Rows Removed by Index Recheck"] ?? 0),
          ) *
            Number(node["Actual Loops"]),
        0,
      );
    (pairs[name] ??= []).push(visited);
    process.stdout.write(`TASK_LIST_UPGRADE ${JSON.stringify({ name, size, visited })}\n`);
    plans.length = 0;
  };
  try {
    await manage(async (client) => {
      await client.query(
        `INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
        VALUES($1,$2,$3,'task-list-upgrade',1,'fixture','fixture','fixture')`,
        keys,
      );
      await client.query(
        `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
        VALUES($1,$2,$3,5,1,1)`,
        keys,
      );
    });
    for (const size of [200, 2000]) {
      await manage(async (client) => {
        await client.query(
          `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
          SELECT $1,$2,$3,'history-'||lpad(n::text,6,'0'),1,
            jsonb_set(jsonb_set(jsonb_set($4::jsonb,'{task,taskId}',to_jsonb('history-'||lpad(n::text,6,'0'))),
              '{task,packageDisposition}','"archived"'::jsonb),'{task,status}','"done"'::jsonb)
          FROM generate_series(1,$5::integer)n ON CONFLICT DO NOTHING`,
          [...keys, JSON.stringify(snapshot), size],
        );
        for (const id of ["target-a", "target-b", "target-c"])
          await client.query(
            `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot,raw_lease)
            VALUES($1,$2,$3,$4,1,jsonb_set(jsonb_set($5::jsonb,'{task,taskId}',to_jsonb($4::text)),
              '{task,pinned}',to_jsonb($4::text <> 'target-c')),NULL) ON CONFLICT DO NOTHING`,
            [...keys, id, JSON.stringify(snapshot)],
          );
        // Simulate a pre-expansion task scalar generation, independently of parent readiness.
        await client.query(
          `UPDATE ha_task_snapshots SET task_index_version=0 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3`,
          keys,
        );
      });
      const admin = await fixture.adminPool.connect();
      try {
        await admin.query("DROP INDEX IF EXISTS ha_task_snapshots_parent_pending_v2");
        await admin.query(`CREATE INDEX IF NOT EXISTS ha_task_snapshots_parent_pending ON ha_task_snapshots
          (tenant_id,project_id,policy_epoch,task_id) WHERE parent_index_version=0`);
        await admin.query(`CREATE INDEX IF NOT EXISTS ha_task_snapshots_task_index ON ha_task_snapshots
          (tenant_id,project_id,policy_epoch,task_id) INCLUDE(task_title,task_slug,package_path)`);
        await admin.query(`CREATE INDEX IF NOT EXISTS ha_task_snapshots_active_task_index ON ha_task_snapshots
          (tenant_id,project_id,policy_epoch,task_id) INCLUDE(task_title,task_slug,package_path) WHERE task_package_disposition='active'`);
        await ensurePgProjectionSchema(admin);
        const indexes = await admin.query(
          `SELECT indexname,indexdef FROM pg_indexes WHERE tablename='ha_task_snapshots'`,
        );
        assert.ok(indexes.rows.some(({ indexname }) => indexname === "ha_task_snapshots_parent_pending_v2"));
        assert.ok(
          !indexes.rows.some(({ indexname }) =>
            [
              "ha_task_snapshots_parent_pending",
              "ha_task_snapshots_task_index",
              "ha_task_snapshots_active_task_index",
            ].includes(indexname),
          ),
        );
      } finally {
        admin.release();
      }
      await assert.rejects(source.readTaskIndex(), { code: "projection_pending" });
      plans.length = 0;
      const fill = (client: import("pg").PoolClient) =>
        client.query<{ processed: number }>("SELECT ha_backfill_projection_read_indexes($1,$2,$3) AS processed", keys);
      const interrupted = new Error("interrupt task scalar backfill");
      await assert.rejects(
        manage(async (client) => {
          assert.equal((await fill(client)).rows[0]!.processed, 64);
          throw interrupted;
        }),
        (error) => error === interrupted,
      );
      const pending = await manage((client) =>
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_index_version=0",
          keys,
        ),
      );
      assert.equal(Number(pending.rows[0]!.count), size + 3);
      let filled = 0;
      for (;;) {
        const count = (await manage(fill)).rows[0]!.processed;
        assert.ok(count >= 0 && count <= 64);
        if (!count) break;
        filled += count;
        assert.ok(filled <= size + 3);
      }
      assert.equal(filled, size + 3);
      await fixture.adminPool.query("VACUUM ANALYZE ha_task_snapshots");
      for (const phase of ["first", "warm"]) {
        plans.length = 0;
        const first = await source.list({ activePackagesOnly: true, pinnedFirst: true, limit: 1 });
        assert.equal(first.rows[0]!.taskId, "target-a");
        observe(`active-pinned/${phase}`, size);
        const second = await source.list({
          activePackagesOnly: true,
          pinnedFirst: true,
          limit: 1,
          cursor: first.page!.nextCursor!,
        });
        assert.equal(second.rows[0]!.taskId, "target-b");
        observe(`pin-next/${phase}`, size);
        const third = await source.list({
          activePackagesOnly: true,
          pinnedFirst: true,
          limit: 1,
          cursor: second.page!.nextCursor!,
        });
        assert.equal(third.rows[0]!.taskId, "target-c");
        assert.equal(third.page!.nextCursor, null);
        observe(`unpin-tail/${phase}`, size);
        assert.deepEqual((await source.list({ leaseOnly: true })).rows, []);
        observe(`lease-empty/${phase}`, size);
        assert.equal((await source.readTaskIndex({ activePackagesOnly: true })).rows.length, 3);
        observe(`active-index/${phase}`, size);
      }
    }
    for (const [name, [small, large]] of Object.entries(pairs))
      assert.ok(large! <= small! + 20 && large! <= 20, `${name}: ${small} -> ${large}`);
    // A valid, incompressible payload larger than a B-tree tuple must remain legal.
    const title = Array.from({ length: 400 }, (_, i) =>
      createHash("sha256").update(`wide-title-${i}`).digest("hex"),
    ).join("");
    for (const suffix of ["create", "update", "backfill"]) {
      await manage(async (client) => {
        await client.query(
          `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
          VALUES($1,$2,$3,'wide',1,jsonb_set(jsonb_set($4::jsonb,'{task,taskId}','"wide"'::jsonb),'{task,title}',to_jsonb($5::text)))
          ON CONFLICT (tenant_id,project_id,policy_epoch,task_id) DO UPDATE SET snapshot=EXCLUDED.snapshot`,
          [...keys, JSON.stringify(snapshot), title + suffix],
        );
        if (suffix === "backfill") {
          await client.query(
            "UPDATE ha_task_snapshots SET task_index_version=0 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id='wide'",
            keys,
          );
          assert.equal(
            (
              await client.query<{ processed: number }>(
                "SELECT ha_backfill_projection_read_indexes($1,$2,$3) AS processed",
                keys,
              )
            ).rows[0]!.processed,
            1,
          );
        }
      });
      assert.equal((await source.readTaskIndex({ taskIds: ["wide"] })).rows[0]!.title, title + suffix);
      process.stdout.write(
        `TASK_WIDE_TITLE ${JSON.stringify({ operation: suffix, bytes: Buffer.byteLength(title + suffix), ok: true })}\n`,
      );
    }
    const event = lifecycleFixture({ taskId: "rebuilt-wide" }).events[0]!;
    assert.equal(event.type, "task_created");
    if (event.type !== "task_created") throw new Error("expected creation fixture");
    const replay = { ...event, payload: { ...event.payload, task: { ...event.payload.task, title } } };
    await manage((client) => rebuildPgProjection(client, scope, { events: [replay], readContentBlob: () => null }));
    assert.equal((await source.readTaskIndex({ taskIds: ["rebuilt-wide"] })).rows[0]!.title, title);
    process.stdout.write(
      `TASK_WIDE_TITLE ${JSON.stringify({ operation: "canonical-rebuild", bytes: Buffer.byteLength(title), ok: true })}\n`,
    );
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});

test("PG presentation and scope retain nested, terminal, hidden and cyclic members", async () => {
  const fixture = await pgRuntimeFixture();
  const scope = {
    tenantId: "presentation-matrix",
    projectId: "presentation-matrix",
    policyEpoch: 1,
    readers: ["visible"],
  };
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch];
  const snapshot = reduceTaskEvent(emptyTaskLifecycleSnapshot(), lifecycleFixture().events[0]!);
  const cases = [
    ["declared", null, "work", "planned", "active", "visible"],
    ["declared-done", "declared", "standard", "done", "active", "visible"],
    ["derived", null, "standard", "planned", "active", "visible"],
    ["nested", "derived", "work", "planned", "active", "visible"],
    ["nested-done", "nested", "standard", "done", "active", "visible"],
    ["cancelled", null, "work", "planned", "active", "visible"],
    ["cancelled-child", "cancelled", "standard", "cancelled", "active", "visible"],
    ["mixed", null, "work", "planned", "active", "visible"],
    ["mixed-done", "mixed", "standard", "done", "archived", "visible"],
    ["mixed-cancelled", "mixed", "standard", "cancelled", "active", "visible"],
    ["acl", null, "work", "planned", "active", "visible"],
    ["acl-done", "acl", "standard", "done", "archived", "visible"],
    ["acl-hidden", "acl", "standard", "active", "active", "hidden"],
    ["cycle-a", "cycle-b", "work", "planned", "active", "visible"],
    ["cycle-b", "cycle-a", "standard", "active", "active", "visible"],
    ["orphan", "missing", "standard", "planned", "active", "visible"],
    ["self", "self", "work", "planned", "active", "visible"],
  ] as const;
  try {
    await withPostgresTransaction(
      fixture.adminPool,
      async (client) => {
        await client.query(
          `INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,readers,revision,head_op_id,head_event_digest,head_digest)
        VALUES($1,$2,$3,'presentation-matrix',ARRAY['visible'],1,'fixture','fixture','fixture')`,
          keys,
        );
        await client.query(
          `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
        VALUES($1,$2,$3,5,1,1)`,
          keys,
        );
        for (const [id, parent, taskClass, status, packageDisposition, reader] of cases) {
          const value = {
            ...snapshot,
            task: {
              ...snapshot.task!,
              taskId: id,
              metadata: { parentTaskId: parent },
              taskClass,
              status,
              packageDisposition,
            },
          };
          await client.query(
            `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,task_id,workspace_revision,readers,snapshot)
          VALUES($1,$2,$3,$4,1,$5::text[],$6::jsonb)`,
            [...keys, id, [reader], JSON.stringify(value)],
          );
        }
      },
      scope,
    );
    const source = createPgTaskProjectionSource({
      pool: fixture.pool,
      scope,
      repoId: "presentation-matrix",
      ownsPool: false,
    });
    for (const [id, status] of Object.entries({
      declared: "done",
      derived: "active",
      nested: "done",
      cancelled: "cancelled",
      mixed: "done",
      acl: "done",
      "cycle-a": "active",
      orphan: "planned",
      self: "planned",
    })) {
      assert.equal((await source.read(id, true)).snapshot.task?.status, status, id);
      assert.equal(
        (await source.readTaskIndex({ taskIds: [id], presentationStatus: true })).rows[0]!.status,
        status,
        id,
      );
      assert.equal((await source.list({ taskIds: [id], presentationStatus: true, status })).rows.length, 1, id);
    }
    const ids = (rows: readonly { taskId: string }[]) => rows.map(({ taskId }) => taskId);
    assert.deepEqual(ids((await source.readTaskIndex({ scopeRootTaskId: "nested" })).rows), [
      "derived",
      "nested",
      "nested-done",
    ]);
    assert.deepEqual(ids((await source.list({ scopeRootTaskId: "cycle-a" })).rows), ["cycle-a", "cycle-b"]);
    assert.deepEqual(ids((await source.readTaskIndex({ scopeRootTaskId: "orphan" })).rows), ["orphan"]);
    assert.deepEqual(ids((await source.readTaskIndex({ scopeRootTaskId: "self" })).rows), ["self"]);
    assert.deepEqual(ids((await source.readTaskIndex({ scopeRootTaskId: "acl" })).rows), ["acl", "acl-done"]);
    assert.deepEqual((await source.readTaskIndex({ scopeRootTaskId: "missing" })).rows, []);
    assert.equal((await source.readTaskIndex({ activePackagesOnly: true })).rows.length, cases.length - 3);
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
