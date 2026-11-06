// harness-test-tier: integration
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalEventV1, TaskProjection } from "@harness-anything/kernel";
import { createPGliteStorageBackend } from "../../storage/src/pglite/storage-backend.ts";
import { createPGliteTaskQueryReader } from "../../storage/src/pglite/query-owner.ts";
import { pgliteIntegrationSuite } from "../../storage/test/pglite/pglite-runtime.fixture.ts";
import { withTempStoreAsync } from "../../storage/test/store/helpers.ts";
import { readObserveEventTail } from "../src/observe-tail.ts";
import { receiptForOperation } from "../src/repo-cell-receipts.ts";
import type { RepoCellActionContext } from "../src/repo-cell-action-context.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";

const scope = { tenantId: "primary", projectId: "primary", policyEpoch: 1 },
  repoId = "primary";

pgliteIntegrationSuite("online primary reads through daemon consumers", () => {
  test("receipts and observe-tail serve an old event index before and after backfill", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const storage = { backend: "pglite" as const, dataDir: join(rootDir, "db"), scope },
        backend = await createPGliteStorageBackend({ repoId, storage });
      let receiptEvent: CanonicalEventV1;
      try {
        await backend.pool.query(`INSERT INTO ha_repo_heads
          (tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
          VALUES('primary','primary',1,'primary',130,'fixture','fixture','fixture')`);
        await backend.pool.query(`INSERT INTO ha_projection_meta
          (tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision,artifact_index_version)
          VALUES('primary','primary',1,5,130,130,1)`);
        await backend.pool.query(`INSERT INTO ha_events
          (tenant_id,project_id,policy_epoch,repo_id,revision,op_id,event_id,event_type,event_digest,occurred_at,event_json)
          SELECT 'primary','primary',1,'primary',n,'event-'||n,'event-'||n,
            CASE WHEN n=1 THEN 'task_created' ELSE 'entity_content_observed' END,'fixture','2026-11-06',
            json_build_object('schema',CASE WHEN n=1 THEN 'task-event/v1' ELSE 'entity-event/v1' END,
              'type',CASE WHEN n=1 THEN 'task_created' ELSE 'entity_content_observed' END,
              'taskId',CASE WHEN n=1 THEN 'task-primary' END,'eventId','event-'||n,'opId','event-'||n,'workspaceRevision',n,
              'occurredAt','2026-11-06','source','local',
              'actor',json_build_object('principal',json_build_object('personId','owner'),'executor',NULL),
              'payload',json_build_object('entityId',CASE WHEN n=2 THEN 'item-2' END,'title','title-'||n))::text
          FROM generate_series(1,130)n`);
        receiptEvent = JSON.parse(
          (await backend.pool.query("SELECT event_json FROM ha_events WHERE revision=2")).rows[0]!.event_json,
        ) as CanonicalEventV1;
        await backend.pool.query("UPDATE ha_events SET read_index_version=4,event_schema=NULL,list_row=NULL");
        await backend.pool.query("UPDATE ha_event_summary_state SET ready=false");
        await backend.pool.query("DROP INDEX ha_events_schema_revision");
      } finally {
        await backend.close();
      }
      const owner = createPGliteTaskQueryReader({ repoId, storage, scope });
      try {
        const read = () =>
          owner.withSession((queries) => {
            assert.equal(queries.readOperation("event-1")?.event.opId, "event-1");
            assert.equal(queries.readTaskOperation("event-1")?.event.taskId, "task-primary");
            assert.equal(queries.readTaskOperation("event-2"), null);
            assert.equal(queries.readOperation("missing"), null);
            assert.equal(queries.readTaskOperation("missing"), null);
            // Only non-storage receipt dependencies are stubbed. The real receipt consumer invokes
            // the worker-backed PG point read and computes durable/canonical visibility itself.
            const cell = {
              projection: queries,
              requiredCellText: () => undefined,
              store: { readEvent: () => receiptEvent, publication: () => ({}) },
              publicPublication: () => ({}),
              canonicalSettlement: (receipt: unknown) => receipt,
            } as unknown as RepoCellActionContext;
            const receipt = receiptForOperation(cell, receiptEvent.opId, {} as RepoCellBinding);
            assert.equal(receipt.outcome, "applied");
            assert.equal(receipt.proof?.canonicalVisible, true);
            assert.equal(receipt.proof?.appliedCut, 130);
            const tails = [];
            for (const fields of [undefined, "fleet"] as const) {
              for (const direction of ["history", "follow"] as const) {
                const tail = readObserveEventTail({
                  repoId,
                  rootDir,
                  mode: "local",
                  projection: queries as TaskProjection,
                  payload: {
                    kind: "events",
                    direction,
                    fields,
                    ...(direction === "follow" ? { cursor: { kind: "events", revision: 64 } } : {}),
                  },
                });
                assert.equal(tail.status, "ready");
                assert.equal(tail.items.length, 64);
                assert.deepEqual(tail.liveCursor, { kind: "events", revision: direction === "follow" ? 128 : 130 });
                tails.push(tail);
              }
            }
            const replica = queries.readReplicaBasis(64);
            assert.equal(replica.headEvent?.workspaceRevision, 130);
            assert.equal(replica.events.length, 64);
            assert.equal(replica.events[0]?.workspaceRevision, 65);
            assert.equal(replica.events.at(-1)?.workspaceRevision, 128);
            assert.deepEqual(replica.documents, []);
            return { receipt, tails, replica };
          });
        const before = read();
        const pending = () =>
          owner.withSession((q) =>
            assert.throws(() => q.readScheduleEvents("missing"), { code: "projection_pending", message: /progress/u }),
          );
        pending();
        // First turn builds the missing physical tree; version-4 rows are still pending.
        assert.deepEqual(owner.backfillReadIndexes(), { processed: 0, done: false });
        pending();
        assert.deepEqual(read(), before);
        let turns = 0;
        for (;;) {
          const page = owner.backfillReadIndexes();
          assert.ok(page.processed <= 64);
          if (page.done) break;
          assert.ok(++turns < 30);
        }
        assert.deepEqual(read(), before, "receipt and both tail modes retain their result after completion");
        owner.withSession((q) => assert.deepEqual(q.readScheduleEvents("missing").events, []));
      } finally {
        owner.close();
      }
    });
  });
});
