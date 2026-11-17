// harness-test-tier: integration
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { AgentRuntimeEventV1 } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { canonicalEventWritePlan, makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

const ACTOR = { principal: { personId: "person-inbox" }, executor: null } as const;

function sampleEvents(): readonly AgentRuntimeEventV1[] {
  return [
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-pg-inbox-1",
      workspaceRevision: 1,
      opId: "op-pg-inbox-1",
      actor: ACTOR,
      source: "local",
      occurredAt: "2026-11-17T00:00:01.000Z",
      type: "runtime_inbox_enqueued",
      payload: {
        inboxId: "task:task-pg-1",
        itemId: "item-pg-1",
        source: "ruling_resolved",
        dedupeKey: "ruling:pg-1",
        coalesceWindowMs: 0,
        midRunPolicy: "defer_next_run",
        taskId: "task-pg-1",
        dispatchId: "dispatch_000000000000000000000001",
        squadRunId: null,
        agentId: "terra",
        summary: "Answer 1",
        data: { answer: "proceed" },
        contextRef: null,
        enqueuedAt: "2026-11-17T00:00:01.000Z",
      },
    },
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-pg-inbox-2",
      workspaceRevision: 2,
      opId: "op-pg-inbox-2",
      actor: ACTOR,
      source: "local",
      occurredAt: "2026-11-17T00:00:02.000Z",
      type: "runtime_inbox_enqueued",
      payload: {
        inboxId: "task:task-pg-2",
        itemId: "item-pg-2",
        source: "inbound_message",
        dedupeKey: "msg:pg-2",
        coalesceWindowMs: 1000,
        midRunPolicy: "defer_next_run",
        taskId: "task-pg-2",
        dispatchId: null,
        squadRunId: null,
        agentId: null,
        summary: "Open msg",
        data: {},
        contextRef: null,
        enqueuedAt: "2026-11-17T00:00:02.000Z",
      },
    },
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-pg-inbox-3",
      workspaceRevision: 3,
      opId: "op-pg-inbox-3",
      actor: ACTOR,
      source: "local",
      occurredAt: "2026-11-17T00:00:03.000Z",
      type: "runtime_inbox_claimed",
      payload: {
        inboxId: "task:task-pg-1",
        itemIds: ["item-pg-1"],
        claimFence: 1,
        claimedByDispatchId: null,
        claimedAt: "2026-11-17T00:00:03.000Z",
        leaseUntil: "2026-11-17T00:01:03.000Z",
      },
    },
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-pg-inbox-4",
      workspaceRevision: 4,
      opId: "op-pg-inbox-4",
      actor: ACTOR,
      source: "local",
      occurredAt: "2026-11-17T00:00:04.000Z",
      type: "runtime_inbox_settled",
      payload: {
        inboxId: "task:task-pg-1",
        itemIds: ["item-pg-1"],
        claimFence: 1,
        settlement: "consumed",
        settledByDispatchId: "dispatch_000000000000000000000002",
        reason: "done",
        settledAt: "2026-11-17T00:00:04.000Z",
      },
    },
  ];
}

pgliteIntegrationSuite("PGlite runtime inbox projection", () => {
  test("PGlite and SQLite read models match and backfill refolds stale inbox metadata", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const repoId = "pglite-runtime-inbox",
        scope = { tenantId: "t", projectId: "p", policyEpoch: 1 },
        storage = { backend: "pglite" as const, dataDir: join(rootDir, "database"), scope },
        events = sampleEvents();

      const pgStore = makeTaskEventStore({ repoId, rootDir, storage }),
        pgProj = makeTaskProjection({ rootDir, eventStore: pgStore, storage }),
        sqRoot = join(rootDir, "sqlite"),
        sqStore = makeTaskEventStore({ repoId, rootDir: sqRoot }),
        sqProj = makeTaskProjection({ rootDir: sqRoot, eventStore: sqStore });

      let pgOpen: ReturnType<typeof pgProj.readRuntimeInbox>;
      try {
        for (const event of events) {
          const entry = { event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] };
          pgStore.append(entry);
          sqStore.append(entry);
          sqProj.apply(event);
        }
        pgOpen = pgProj.readRuntimeInbox({ by: "open", limit: 10 });
        assert.deepEqual(pgOpen, sqProj.readRuntimeInbox({ by: "open", limit: 10 }));
        assert.deepEqual(
          pgProj.readRuntimeInbox({ by: "inbox", inboxId: "task:task-pg-1" }),
          sqProj.readRuntimeInbox({ by: "inbox", inboxId: "task:task-pg-1" }),
        );
      } finally {
        sqProj.close();
        await sqStore.drain();
        pgProj.close();
        await pgStore.drain();
      }

      const backend = await createPGliteStorageBackend({ repoId, storage });
      try {
        await backend.pool.query(
          "DELETE FROM ha_projection_values WHERE model IN ('runtime-inbox-group', 'runtime-inbox-open')",
        );
        await backend.pool.query("UPDATE ha_projection_meta SET runtime_inbox_version=0");
        assert.equal((await backend.projection.readRuntimeInbox({ by: "open", limit: 10 })).status, "pending");
      } finally {
        await backend.close();
      }

      const reopenedStore = makeTaskEventStore({ repoId, rootDir, storage }),
        reopenedProj = makeTaskProjection({ rootDir, eventStore: reopenedStore, storage });
      try {
        assert.deepEqual(reopenedProj.readRuntimeInbox({ by: "open", limit: 10 }), pgOpen);
      } finally {
        reopenedProj.close();
        await reopenedStore.drain();
      }
    });
  });
});
