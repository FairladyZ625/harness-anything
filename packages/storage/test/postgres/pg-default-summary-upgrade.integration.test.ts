// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { taskLifecycleWritePlan } from "@harness-anything/kernel";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { backfillPgDefaultEventSummaries } from "../../src/pg/pg-event-read-index-migration.ts";
import { eventAt } from "../store/task-event-store.fixtures.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";

test("external PostgreSQL upgrade drains default summaries before workspace reads", { timeout: 120_000 }, async () => {
  const fixture = await pgRuntimeFixture(),
    repoId = "default-summary-upgrade",
    scope = { tenantId: "default-summary", projectId: "default-summary", policyEpoch: 1, readers: [] },
    { eventStore, projection } = createPgStorageBackend({ pool: fixture.pool, repoId, scope }),
    event = eventAt(1);
  try {
    await eventStore.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] }, 0, {
      repoId,
      holderId: "upgrade",
      epoch: 1,
    });
    await fixture.adminPool.query(
      "UPDATE ha_events SET summary_json=NULL,default_summary_json=NULL,read_index_version=5 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
      [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
    );

    let processed = 0;
    do {
      processed = (
        await fixture.adminPool.query<{ processed: number }>(
          "SELECT ha_backfill_event_read_indexes($1,$2,$3,$4) AS processed",
          [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
        )
      ).rows[0]!.processed;
    } while (processed > 0);

    await backfillPgDefaultEventSummaries(fixture.adminPool, scope, repoId);
    const pending = await fixture.adminPool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND default_summary_json IS NULL",
      [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
    );
    assert.equal(pending.rows[0]!.count, 0);
    assert.equal((await projection.readEventSummaries(0, 10)).events.length, 1);
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
