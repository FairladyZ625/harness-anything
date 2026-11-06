// harness-test-tier: integration
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
} from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { reduceRelationEntity } from "@harness-anything/kernel/internal/domain/relation-event.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { actor, relation } from "../store/relation-graph-projection.fixtures.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import {
  backfillPgRelationFreshnessPage,
  refreshPgDirtyRelationFreshness,
} from "../../src/pg/pg-relation-freshness.ts";
import { PG_PROJECTION_SCHEMA_VERSION } from "../../src/pg/pg-projection-schema.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";

// One managed PostgreSQL serves every case; each case owns its own tenant scope.
let fixture: Awaited<ReturnType<typeof pgRuntimeFixture>>;
before(async () => {
  fixture = await pgRuntimeFixture();
});
after(async () => {
  await fixture.pool.end();
  await fixture.close();
});

test("one visible relation has the same global freshness at every supported reader cut", async () => {
  const scope = { tenantId: "freshness-visibility", projectId: "freshness-visibility", policyEpoch: 1 },
    repoId = "visibility",
    events = lifecycleFixture({ taskId: "task_target", executionId: "execution_target" }).events;
  let snapshot = emptyTaskLifecycleSnapshot(0);
  for (const event of events) snapshot = reduceTaskEvent(snapshot, event);
  const version = events.at(-1)!.workspaceRevision,
    { strength: _strength, ...record } = relation({
      source: "task/task_source",
      target: "task/task_target",
      type: "depends-on",
    }),
    edge = reduceRelationEntity(null, {
      schema: "relation-event/v1",
      eventId: "visibility",
      opId: "visibility",
      workspaceRevision: version + 1,
      relationId: record.relation_id,
      type: "relation_created",
      actor,
      source: "local",
      occurredAt: "2026-11-05T00:00:00.000Z",
      payload: { relation: { ...record, targetObservedVersion: version } },
    }),
    { strength: _privateStrength, ...privateRecord } = relation({
      source: "task/task_source",
      target: "task/task_target",
      type: "relates",
    }),
    privateEdge = reduceRelationEntity(null, {
      schema: "relation-event/v1",
      eventId: "visibility-private",
      opId: "visibility-private",
      workspaceRevision: version + 1,
      relationId: privateRecord.relation_id,
      type: "relation_created",
      actor,
      source: "local",
      occurredAt: "2026-11-05T00:00:00.000Z",
      payload: { relation: { ...privateRecord, targetObservedVersion: version } },
    });
  {
    await withPostgresTransaction(
      fixture.adminPool,
      async (client) => {
        await client.query(
          `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,readers,task_id,workspace_revision,snapshot)
        VALUES($1,$2,$3,ARRAY['alice'],'task_target',$4,$5::jsonb)`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, version, JSON.stringify(snapshot)],
        );
        for (const [readers, relation] of [
          [["alice", "bob"], edge],
          [["alice"], privateEdge],
        ] as const)
          await client.query(
            `INSERT INTO ha_relations(tenant_id,project_id,policy_epoch,readers,relation_id,source_ref,target_ref,relation_type,relation_state,workspace_revision,value)
          VALUES($1,$2,$3,$4::text[],$5,$6,$7,$8,$9,$10,$11::jsonb)`,
            [
              scope.tenantId,
              scope.projectId,
              scope.policyEpoch,
              readers,
              relation.id,
              relation.source,
              relation.target,
              relation.type,
              relation.state,
              version + 1,
              JSON.stringify({ ...relation, sourcePath: "event:visibility", recordIndex: 0 }),
            ],
          );
        await client.query(
          `INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,readers,revision,head_op_id,head_event_digest,head_digest)
        VALUES($1,$2,$3,$4,ARRAY['alice','bob'],$5,'fixture','fixture','fixture')`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, repoId, version + 1],
        );
        await client.query(
          `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
        VALUES($1,$2,$3,$4,$5,$5)`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, PG_PROJECTION_SCHEMA_VERSION, version + 1],
        );
      },
      scope,
    );
    // Rows written without stored freshness (expansion backfill window) are filled in bounded,
    // committed pages; the scope then serves the stored global value.
    let pages = 0;
    for (;;) {
      const page = await withPostgresTransaction(
        fixture.adminPool,
        (client) => backfillPgRelationFreshnessPage(client, scope),
        scope,
      );
      pages += 1;
      if (page.done) break;
      assert.ok(pages < 8, "relation freshness backfill must converge");
    }
    const observed = [];
    // dec_E34C4284B48AFAF152D7BF1980: the target task is visible to alice only, yet the shared edge's
    // freshness is the relation's own value for every reader; readers only decide visibility.
    for (const readers of [[], ["alice"], ["bob"], ["alice", "bob"]]) {
      const source = createPgTaskProjectionSource({
          pool: fixture.pool,
          scope: { ...scope, readers },
          repoId,
          ownsPool: false,
        }),
        all = await source.readRelationQuery({ limit: 10 }),
        current = await source.readRelationQuery({ freshness: "current", limit: 10 }),
        suspect = await source.readRelationQuery({ freshness: "suspect", limit: 10 }),
        shared = all.rows.find((row) => row.relationId === edge.id),
        visible = readers.length === 1 && readers[0] === "bob" ? [edge.id] : [edge.id, privateEdge.id].sort();
      assert.deepEqual(
        all.rows.map((row) => row.relationId),
        visible,
      );
      assert.equal(shared?.freshness, "current");
      assert.equal(shared?.currentTargetVersion, version);
      assert.deepEqual(
        current.rows.map((row) => row.relationId),
        visible,
      );
      assert.equal(suspect.rows.length, 0);
      observed.push({
        readers,
        freshness: shared?.freshness,
        visible: all.rows.length,
        current: current.rows.length,
        suspect: suspect.rows.length,
      });
    }
    process.stdout.write(`FRESHNESS_VISIBILITY ${JSON.stringify({ relationId: edge.id, pages, observed })}\n`);
  }
});

test("a write recomputes only its own endpoints' relations; a previous writer's backlog drains in bounded pages", async () => {
  const scope = { tenantId: "freshness-maintenance", projectId: "freshness-maintenance", policyEpoch: 1 },
    keys = [scope.tenantId, scope.projectId, scope.policyEpoch] as const,
    snapshotOf = (taskId: string) => {
      const events = lifecycleFixture({ taskId, executionId: `execution_${taskId}` }).events;
      let snapshot = emptyTaskLifecycleSnapshot(0);
      for (const event of events) snapshot = reduceTaskEvent(snapshot, event);
      return { snapshot, version: events.at(-1)!.workspaceRevision };
    },
    hot = snapshotOf("task_hot"),
    sibling = snapshotOf("task_hot-backup"),
    edgeTo = (source: string, target: string, observed: number) => {
      const { strength: _strength, ...record } = relation({ source, target, type: "relates" });
      return reduceRelationEntity(null, {
        schema: "relation-event/v1",
        eventId: record.relation_id,
        opId: record.relation_id,
        workspaceRevision: observed + 1,
        relationId: record.relation_id,
        type: "relation_created",
        actor,
        source: "local",
        occurredAt: "2026-11-07T00:00:00.000Z",
        payload: { relation: { ...record, targetObservedVersion: observed } },
      });
    },
    hotEdges = ["task/task_a", "task/task_b"].map((source) => edgeTo(source, "task/task_hot", hot.version)),
    // `task/task_hot-backup` shares the hot ref's prefix but is a different, legal entity.
    siblingEdges = ["task/task_c", "task/task_d", "task/task_e", "task/task_f", "task/task_g"].map((source) =>
      edgeTo(source, "task/task_hot-backup", sibling.version),
    ),
    transact = <A>(run: (client: import("pg").PoolClient) => Promise<A>) =>
      withPostgresTransaction(fixture.adminPool, run, scope),
    freshnessOf = async () =>
      new Map(
        (
          await fixture.adminPool.query<{ relation_id: string; freshness: string | null }>(
            "SELECT relation_id, freshness FROM ha_relations WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
            [...keys],
          )
        ).rows.map((row) => [row.relation_id, row.freshness]),
      ),
    backlog = async () =>
      Number(
        (
          await fixture.adminPool.query<{ n: string }>(
            "SELECT count(*) AS n FROM ha_relation_freshness_dirty WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
            [...keys],
          )
        ).rows[0]!.n,
      );
  await transact(async (client) => {
    for (const [taskId, task] of [
      ["task_hot", hot],
      ["task_hot-backup", sibling],
    ] as const)
      await client.query(
        `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,readers,task_id,workspace_revision,snapshot)
         VALUES($1,$2,$3,ARRAY['alice'],$4,$5,$6::jsonb)`,
        [...keys, taskId, task.version, JSON.stringify(task.snapshot)],
      );
    for (const edge of [...hotEdges, ...siblingEdges])
      await client.query(
        `INSERT INTO ha_relations(tenant_id,project_id,policy_epoch,readers,relation_id,source_ref,target_ref,relation_type,relation_state,workspace_revision,value)
         VALUES($1,$2,$3,ARRAY['alice'],$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          ...keys,
          edge.id,
          edge.source,
          edge.target,
          edge.type,
          edge.state,
          Math.max(hot.version, sibling.version) + 1,
          JSON.stringify({ ...edge, sourcePath: "event:maintenance", recordIndex: 0 }),
        ],
      );
  });
  while (!(await transact((client) => backfillPgRelationFreshnessPage(client, scope))).done);
  assert.deepEqual(new Set((await freshnessOf()).values()), new Set(["current"]));

  // A write advancing the hot task recomputes the hot task's two edges in its own transaction and
  // none of the five edges of the prefix-sharing sibling.
  const advanced = await transact(async (client) => {
    await client.query(
      "UPDATE ha_task_snapshots SET workspace_revision = workspace_revision + 10 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id='task_hot'",
      [...keys],
    );
    return refreshPgDirtyRelationFreshness(client, scope);
  });
  assert.equal(advanced, hotEdges.length);
  let stored = await freshnessOf();
  for (const edge of hotEdges) assert.equal(stored.get(edge.id), "suspect");
  for (const edge of siblingEdges) assert.equal(stored.get(edge.id), "current");

  // A previous writer advances the sibling and commits without draining; its marks plus refs of
  // endpoints with no relations form a backlog larger than one expansion page.
  await transact(async (client) => {
    await client.query(
      "UPDATE ha_task_snapshots SET workspace_revision = workspace_revision + 10 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id='task_hot-backup'",
      [...keys],
    );
    await client.query(
      `INSERT INTO ha_relation_freshness_dirty(tenant_id,project_id,policy_epoch,ref)
       SELECT $1, $2, $3, 'task/task_gone_' || n FROM generate_series(1, 300) n`,
      [...keys],
    );
  });
  assert.equal(await backlog(), 301);

  // The current writer's next write drains only what its transaction marked.
  const ownOnly = await transact(async (client) => {
    await client.query(
      "UPDATE ha_task_snapshots SET workspace_revision = workspace_revision + 10 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id='task_hot'",
      [...keys],
    );
    return refreshPgDirtyRelationFreshness(client, scope);
  });
  assert.equal(ownOnly, hotEdges.length);
  assert.equal(await backlog(), 301);

  // Expansion pages take at most 256 backlog refs each and commit; the last page reports nothing left.
  const pages = [];
  for (;;) {
    const page = await transact((client) => backfillPgRelationFreshnessPage(client, scope));
    pages.push(page);
    if (page.done) break;
    assert.ok(page.processed <= 256, `page processed ${page.processed}`);
    assert.ok(pages.length < 8, "backlog drain must converge");
  }
  assert.deepEqual(
    pages.map(({ processed }) => processed),
    [256, 45, 0],
  );
  assert.equal(await backlog(), 0);
  stored = await freshnessOf();
  for (const edge of siblingEdges) assert.equal(stored.get(edge.id), "suspect");
  process.stdout.write(
    `FRESHNESS_MAINTENANCE ${JSON.stringify({ advanced, ownOnly, backlogPages: pages.map(({ processed }) => processed) })}\n`,
  );
});
