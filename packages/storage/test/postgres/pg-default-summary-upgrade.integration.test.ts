// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { taskLifecycleWritePlan } from "@harness-anything/kernel";
import { canonicalEventEntityRefs } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import {
  canonicalEventFleetSummary,
  canonicalEventSummary,
} from "@harness-anything/kernel/internal/domain/canonical-event-summary.ts";
import { serializePersistedCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
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

    // A previous binary writes only the original event columns after the upgrade drain. Its
    // materializer advances the projection cut but cannot populate the new default column.
    const previousEvent = { ...eventAt(2), workspaceRevision: 200 },
      previousBody = serializePersistedCanonicalEvent(previousEvent).trimEnd();
    await fixture.adminPool.query(
      `INSERT INTO ha_events
         (tenant_id,project_id,repo_id,revision,op_id,event_id,event_type,event_json,summary_json,event_digest,occurred_at,
          actor_refs,entity_refs,readers,policy_epoch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        scope.tenantId,
        scope.projectId,
        repoId,
        2,
        previousEvent.opId,
        previousEvent.eventId,
        previousEvent.type,
        previousBody,
        JSON.stringify(canonicalEventFleetSummary(previousEvent)),
        `sha256:${sha256Text(previousBody)}`,
        previousEvent.occurredAt,
        [
          previousEvent.actor.principal.personId,
          ...(previousEvent.actor.executor ? [previousEvent.actor.executor.id] : []),
        ],
        canonicalEventEntityRefs(previousEvent),
        scope.readers,
        scope.policyEpoch,
      ],
    );
    await fixture.adminPool.query(
      "UPDATE ha_repo_heads SET revision=$5,head_op_id=$6,head_event_digest=$7,head_digest=$8 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
      [
        scope.tenantId,
        scope.projectId,
        scope.policyEpoch,
        repoId,
        2,
        previousEvent.opId,
        `sha256:${sha256Text(previousBody)}`,
        `sha256:${sha256Text(previousBody)}`,
      ],
    );
    await fixture.adminPool.query(
      "UPDATE ha_projection_meta SET watermark=$4,source_revision=$4 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'",
      [scope.tenantId, scope.projectId, scope.policyEpoch, 2],
    );

    // The unrelated previous-writer row must not block a task-scoped page. The default page then
    // hydrates that one selected missing row through the same kernel summary authority.
    const taskPage = await projection.readEventSummaries(0, 10, { taskIds: [event.taskId] });
    assert.deepEqual(
      taskPage.events.map(({ eventId }) => eventId),
      [event.eventId],
    );
    const defaultPage = await projection.readEventSummaries(0, 10);
    assert.deepEqual(
      defaultPage.events.find(({ eventId }) => eventId === previousEvent.eventId),
      canonicalEventSummary(previousEvent),
    );
    await backfillPgDefaultEventSummaries(fixture.adminPool, scope, repoId);
    const remaining = await fixture.adminPool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND default_summary_json IS NULL",
      [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
    );
    assert.equal(remaining.rows[0]!.count, 0);
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
