import { tracedPgReads, explainNodes, reportPgVersion, measurePgRead } from "./pg-explain.fixture.ts";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { measureLegacySelector, legacyValueSql } from "./pg-legacy-read-plans.fixture.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { putPgProjectionValue } from "../../src/pg/pg-projection-values.ts";

const scope = { tenantId: "value-index", projectId: "value-index", policyEpoch: 1 };

/** Explain the exact adapter SQL, using its runtime RLS connection and unforced planner. */
export async function assertValueIndexes(pool: Pool, seedPool: Pool, backend: string): Promise<void> {
  await reportPgVersion(pool, backend);
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      await client.query(
        `INSERT INTO ha_projection_values
      (tenant_id,project_id,policy_epoch,model,owner_id,entity_id,workspace_revision,value)
      SELECT $1,$2,$3,'relation-write','','history-' || lpad(n::text,6,'0'),1,
        json_build_object('ownerRef','decision/old','targetRef','task/old','relationId',n::text)::text
      FROM generate_series(1,100000) n`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      await client.query(
        `INSERT INTO ha_projection_values
      (tenant_id,project_id,policy_epoch,model,owner_id,entity_id,workspace_revision,value)
      SELECT $1,$2,$3,'lease-interval','task-target',n::text,1,
        json_build_object('taskId','task-target','executionId','execution-' || n::text,
          'acquiredRevision',n,'releasedRevision',n+1)::text FROM generate_series(1,100000) n`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      for (const [id, ownerRef, targetRef] of [
        ["target-a", "fact/source", "task/one"],
        ["target-b", "decision/source", "fact/target"],
        ["target-c", "fact/source", "fact/target"],
      ])
        await putPgProjectionValue(client, scope, "relation-write", id!, "", 2, {
          relationId: id,
          ownerRef,
          targetRef,
        });
      for (const [entityRef, pinnedAt] of [
        ["task/a", "2026-01-02"],
        ["task/b", "2026-01-03"],
        ["task/c", "2026-01-03"],
      ])
        await putPgProjectionValue(client, scope, "pin", entityRef!, "", 2, {
          entityRef,
          pinnedAt,
          pinnedBy: "person/test",
        });
      await putPgProjectionValue(client, scope, "lease-interval", "100001", "task-target", 2, {
        taskId: "task-target",
        executionId: "live",
        acquiredRevision: 100001,
        releasedRevision: null,
      });
      for (const model of ["entity:agent", "runtime-installation", "squad-run"])
        for (const id of ["a", "b", "c"])
          await putPgProjectionValue(client, scope, model, id, "", 2, { id, installationId: id, squadRunId: id });
      await client.query("ANALYZE ha_projection_values");
    },
    scope,
  );
  const plans: unknown[] = [],
    traced = tracedPgReads(pool, plans, (sql) => /^\s*SELECT[\s\S]*FROM ha_projection_values/u.test(sql));
  const source = createPgTaskProjectionSource({ pool: traced, scope, repoId: "value-index", ownsPool: false });
  for (const [method, model, owner] of [
    ["readFactGraph.edges", "relation-write", undefined],
    ["listPinnedEntities", "pin", undefined],
    ["readLeaseIntervals", "lease-interval", "task-target"],
  ] as const)
    await measureLegacySelector(pool, scope, backend, method, legacyValueSql(owner !== undefined), [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      model,
      [],
      ...(owner === undefined ? [] : [owner]),
    ]);
  const timed = createPgTaskProjectionSource({ pool, scope, repoId: "value-index", ownsPool: false });
  for (const [method, model, read] of [
    ["listEntities(agent)", "entity:agent", () => source.listEntities("agent")],
    ["readRuntimeInstallations", "runtime-installation", () => source.readRuntimeInstallations()],
    ["readSquadRuns", "squad-run", () => source.readSquadRuns()],
  ] as const) {
    await measureLegacySelector(pool, scope, backend, method, legacyValueSql(), [
      scope.tenantId,
      scope.projectId,
      scope.policyEpoch,
      model,
      [],
    ]);
    assert.equal((await read()).length, 3);
    process.stdout.write(`VALUE_INDEX ${backend} ${method} ${JSON.stringify(plans)}\n`);
    for (const scan of scans(plans))
      assert.ok(
        (Number(scan["Actual Rows"]) + Number(scan["Rows Removed by Filter"] ?? 0)) * Number(scan["Actual Loops"]) <= 3,
        `${method} scanned other model history: ${JSON.stringify(scan)}`,
      );
    plans.length = 0;
  }
  await measurePgRead(backend, "listEntities(agent)", () => timed.listEntities("agent"));
  await measurePgRead(backend, "readRuntimeInstallations", () => timed.readRuntimeInstallations());
  await measurePgRead(backend, "readSquadRuns", () => timed.readSquadRuns());
  const graph = await source.readFactGraph();
  process.stdout.write(`VALUE_INDEX ${backend} fact-edges ${JSON.stringify(plans)}\n`);
  assert.deepEqual(
    graph.edges.map((row) => row.relationId),
    ["target-a", "target-b", "target-c"],
  );
  await measurePgRead(backend, "readFactGraph", () => timed.readFactGraph());
  for (const row of scans(plans))
    assert.ok(
      Number(row["Actual Rows"]) + Number(row["Rows Removed by Filter"] ?? 0) <= 3,
      `fact edges scanned unrelated history: ${JSON.stringify(row)}`,
    );
  plans.length = 0;
  assert.deepEqual(
    (await source.listPinnedEntities()).map((row) => row.entityRef),
    ["task/b", "task/c", "task/a"],
  );
  process.stdout.write(`VALUE_INDEX ${backend} pins ${JSON.stringify(plans)}\n`);
  await measurePgRead(backend, "listPinnedEntities", () => timed.listPinnedEntities());
  plans.length = 0;
  const intervals = await source.readLeaseIntervals("task-target");
  assert.equal(intervals.length, 100001);
  assert.equal(intervals[9]!.acquiredRevision, 10);
  assert.equal(intervals.at(-1)!.executionId, "live");
  process.stdout.write(`VALUE_INDEX ${backend} intervals ${JSON.stringify(plans)}\n`);
  assert.ok(!explainNodes(plans).some((row) => row["Node Type"] === "Sort"), "interval order must come from its index");
  await measurePgRead(backend, "readLeaseIntervals", () => timed.readLeaseIntervals("task-target"));
  await assertOnlineReadIndexUpgrade(pool, seedPool);
}
function scans(value: unknown) {
  return explainNodes(value).filter((row) => row["Relation Name"] === "ha_projection_values");
}

/** Old rows migrate in committed pages; both binary generations continue writing canonical text. */
async function assertOnlineReadIndexUpgrade(pool: Pool, seedPool: Pool): Promise<void> {
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      for (const value of [
        "NUL\0\0😀",
        "literal\\u0000",
        "mixed\\\0",
        "Unicode 😀",
        "high\ud800",
        "low\udc00",
        "literal\\ud800\udc00",
        "prefix\\😀",
      ]) {
        const serialized = JSON.stringify({ memo: value, pinnedAt: "2026-01-01" });
        const row = (
          await client.query<{ metadata: string; copy: string }>(
            "SELECT ha_read_index_json($1)->>'pinnedAt' AS metadata,ha_read_index_json($1)::text AS copy",
            [serialized],
          )
        ).rows[0]!;
        assert.equal(row.metadata, "2026-01-01");
        assert.equal(
          JSON.parse(row.copy).memo,
          new TextDecoder().decode(new TextEncoder().encode(value)).replaceAll("\0", "�"),
        );
      }
    },
    scope,
  );
  const oldScope = { tenantId: "old-index", projectId: "old-index", policyEpoch: 1 };
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      await client.query("ALTER TABLE ha_projection_values DISABLE TRIGGER ha_projection_read_index_fields");
      try {
        await client.query(
          `INSERT INTO ha_projection_values
        (tenant_id,project_id,policy_epoch,model,entity_id,owner_id,workspace_revision,value)
        SELECT $1,$2,$3,'pin',lpad(n::text,3,'0'),'',1,
          json_build_object('entityRef',lpad(n::text,3,'0'),'pinnedAt','2026-01-01','pinnedBy','person/test')::text
        FROM generate_series(1,130) n`,
          [oldScope.tenantId, oldScope.projectId, oldScope.policyEpoch],
        );
      } finally {
        await client.query("ALTER TABLE ha_projection_values ENABLE TRIGGER ha_projection_read_index_fields");
      }
    },
    oldScope,
  );
  const source = createPgTaskProjectionSource({ pool, scope: oldScope, repoId: "old-index", ownsPool: false });
  await assert.rejects(source.listPinnedEntities(), { code: "projection_pending", message: /progress/u });
  const pages: number[] = [];
  for (;;) {
    const processed = await withPostgresTransaction(
      seedPool,
      async (client) =>
        (
          await client.query<{ processed: number }>(
            "SELECT ha_backfill_projection_read_indexes($1,$2,$3) AS processed",
            [oldScope.tenantId, oldScope.projectId, oldScope.policyEpoch],
          )
        ).rows[0]!.processed,
      oldScope,
    );
    pages.push(processed);
    if (processed === 0) break;
  }
  assert.deepEqual(pages, [64, 64, 2, 0]);
  assert.equal((await source.listPinnedEntities()).length, 130);
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      // Previous binary: supplies only the original fields, including legal NUL user text.
      await client.query(
        `UPDATE ha_projection_values SET value=$4 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='pin' AND entity_id='001'`,
        [
          oldScope.tenantId,
          oldScope.projectId,
          oldScope.policyEpoch,
          JSON.stringify({ entityRef: "001", pinnedAt: "2026-12-01", pinnedBy: "person/test", memo: "note\0😀\ud800" }),
        ],
      );
      await putPgProjectionValue(client, oldScope, "runtime-session", "session-old", "", 1, {
        runtimeSessionId: "session-old",
        liveness: "exited",
        taskBindings: [{ taskId: "one" }, { taskId: "one" }],
      });
    },
    oldScope,
  );
  assert.equal((await source.listPinnedEntities())[0]!.entityRef, "001");
  assert.equal((await source.readRuntimeSessionsForTask("one")).length, 1);
  await withPostgresTransaction(
    seedPool,
    (client) =>
      putPgProjectionValue(client, oldScope, "runtime-session", "session-old", "", 2, {
        runtimeSessionId: "session-old",
        liveness: "exited",
        taskBindings: [{ taskId: "two" }],
      }),
    oldScope,
  );
  assert.deepEqual(await source.readRuntimeSessionsForTask("one"), []);
  assert.equal((await source.readRuntimeSessionsForTask("two")).length, 1);
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      await client.query(
        `DELETE FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='runtime-session'`,
        [oldScope.tenantId, oldScope.projectId, oldScope.policyEpoch],
      );
      assert.equal(
        (await client.query("SELECT 1 FROM ha_runtime_session_tasks WHERE tenant_id=$1", [oldScope.tenantId])).rows
          .length,
        0,
      );
    },
    oldScope,
  );
}
