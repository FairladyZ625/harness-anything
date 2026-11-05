// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
} from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { reduceRelationEntity } from "@harness-anything/kernel/internal/domain/relation-event.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { actor, relation } from "../store/relation-graph-projection.fixtures.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { PG_PROJECTION_SCHEMA_VERSION } from "../../src/pg/pg-projection-schema.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";

test("one relation has different freshness at distinct supported reader cuts", async () => {
  const fixture = await pgRuntimeFixture(),
    scope = { tenantId: "freshness-visibility", projectId: "freshness-visibility", policyEpoch: 1 },
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
    });
  try {
    await withPostgresTransaction(
      fixture.adminPool,
      async (client) => {
        await client.query(
          `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,readers,task_id,workspace_revision,snapshot)
        VALUES($1,$2,$3,ARRAY['alice'],'task_target',$4,$5::jsonb)`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, version, JSON.stringify(snapshot)],
        );
        await client.query(
          `INSERT INTO ha_relations(tenant_id,project_id,policy_epoch,readers,relation_id,source_ref,target_ref,relation_type,relation_state,workspace_revision,value)
        VALUES($1,$2,$3,ARRAY['alice','bob'],$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
            edge.id,
            edge.source,
            edge.target,
            edge.type,
            edge.state,
            version + 1,
            JSON.stringify({ ...edge, sourcePath: "event:visibility", recordIndex: 0 }),
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
    const observed = [];
    for (const readers of [[], ["alice"], ["bob"], ["alice", "bob"]]) {
      const source = createPgTaskProjectionSource({
          pool: fixture.pool,
          scope: { ...scope, readers },
          repoId,
          ownsPool: false,
        }),
        all = await source.readRelationQuery({ limit: 1 }),
        current = await source.readRelationQuery({ freshness: "current", limit: 1 }),
        suspect = await source.readRelationQuery({ freshness: "suspect", limit: 1 }),
        expected = readers.length === 1 && readers[0] === "bob" ? "suspect" : "current";
      assert.equal(all.rows[0]?.freshness, expected);
      assert.equal(current.rows.length, expected === "current" ? 1 : 0);
      assert.equal(suspect.rows.length, expected === "suspect" ? 1 : 0);
      observed.push({
        readers,
        freshness: all.rows[0]?.freshness,
        current: current.rows.length,
        suspect: suspect.rows.length,
      });
    }
    process.stdout.write(`FRESHNESS_VISIBILITY ${JSON.stringify({ relationId: edge.id, observed })}\n`);
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
