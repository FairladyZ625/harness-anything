// harness-test-tier: integration
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  runtimeEventContentClaims,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { canonicalEventWritePlan, makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import {
  appendTaskTerminalLifecycleHistory,
  history,
  requested,
  snapshot,
} from "../store/dispatch-lifecycle.fixtures.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

const LIFECYCLE_MODELS = [
  "dispatch-lifecycle-group",
  "dispatch-lifecycle-session",
  "dispatch-lifecycle-dispatch",
  "dispatch-lifecycle-active",
  "dispatch-lifecycle-execution",
  "dispatch-lifecycle-task",
  "dispatch-lifecycle-task-lease",
];

function append(store: ReturnType<typeof makeTaskEventStore>, event: AgentRuntimeEventV1): void {
  store.append({
    event,
    plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
    blobs: runtimeEventContentClaims(event).map((claim) => ({ ...claim, body: "" })),
  });
}

function rowsOf(read: ReturnType<typeof snapshot>) {
  return Object.fromEntries(
    Object.entries(read).map(([key, page]) => [key, page.status === "ready" ? page.rows : page.status]),
  );
}

pgliteIntegrationSuite("PGlite dispatch lifecycle", () => {
  test("a projection without the lifecycle model is pending, then refolded by the same reducer", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const repoId = "pglite-dispatch-lifecycle",
        scope = { tenantId: "t", projectId: "p", policyEpoch: 1 },
        storage = { backend: "pglite" as const, dataDir: join(rootDir, "database"), scope },
        open = () => {
          const store = makeTaskEventStore({ repoId, rootDir, storage });
          return { store, projection: makeTaskProjection({ rootDir, eventStore: store, storage }) };
        };
      const first = open();
      let online: ReturnType<typeof snapshot>;
      try {
        for (const event of history()) append(first.store, event);
        online = snapshot(first.projection);
        assert.ok(online.active.status === "ready");
        assert.deepEqual(
          online.active.rows.map((row) => [row.attemptGroupId, row.attempt.dispatchId, row.policy.capacityDisposition]),
          [
            ["dispatch-a", "dispatch-a2", "busy"],
            ["dispatch-b", "dispatch-b", "recovering"],
          ],
        );
        // Admission is refused by the center writer, not by storage: a canonical event the reducer
        // rejects (here a second admission into the running group, as legacy ledgers contain)
        // still appends and replays, and the fold leaves the lifecycle unchanged on both backends.
        append(first.store, requested("dispatch-a3", "session-a3", "dispatch-a"));
        const after = snapshot(first.projection);
        assert.deepEqual(rowsOf(after), rowsOf(online));
        online = after;
      } finally {
        first.projection.close();
        await first.store.drain();
      }

      // Simulate a projection written before this cut: every lifecycle value is absent.
      const backend = await createPGliteStorageBackend({ repoId, storage });
      try {
        await backend.pool.query("DELETE FROM ha_projection_values WHERE model = ANY($1::text[])", [LIFECYCLE_MODELS]);
        await backend.pool.query("UPDATE ha_projection_meta SET dispatch_lifecycle_version=0");
        const read = await backend.projection.readDispatchLifecycle({ by: "active", limit: 10 });
        assert.equal(read.status, "pending", "a missing lifecycle model is never a ready empty page");
      } finally {
        await backend.close();
      }

      const second = open();
      try {
        assert.deepEqual(snapshot(second.projection), online, "the upgrade refolds the same state");
      } finally {
        second.projection.close();
        await second.store.drain();
      }
    });
  });

  test("terminal task events close stopped historical groups, clean dispatch-lifecycle-task, and refold on v5 upgrade", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const repoId = "pglite-dispatch-lifecycle-terminal",
        scope = { tenantId: "t", projectId: "p", policyEpoch: 1 },
        storage = { backend: "pglite" as const, dataDir: join(rootDir, "database"), scope },
        open = () => {
          const store = makeTaskEventStore({ repoId, rootDir, storage });
          return { store, projection: makeTaskProjection({ rootDir, eventStore: store, storage }) };
        };
      const first = open();
      let active: ReturnType<typeof first.projection.readDispatchLifecycle>;
      try {
        appendTaskTerminalLifecycleHistory(first.store);
        active = first.projection.readDispatchLifecycle({ by: "active", limit: 20 });
        assert.ok(active.status === "ready");
        assert.deepEqual(
          active.rows.map((row) => [row.attemptGroupId, row.groupPhase, row.attempt.stopProof]),
          [
            ["d-live", "running", "unproven"],
            ["d-nonterm", "waiting_backoff", "proven_stopped"],
          ],
        );
      } finally {
        first.projection.close();
        await first.store.drain();
      }

      const backend = await createPGliteStorageBackend({ repoId, storage });
      try {
        const taskIndexRows = await backend.pool.query<{ entity_id: string; owner_id: string }>(
          "SELECT entity_id, owner_id FROM ha_projection_values WHERE model='dispatch-lifecycle-task' ORDER BY entity_id",
        );
        assert.deepEqual(taskIndexRows.rows, [
          { entity_id: "d-live", owner_id: "task-live" },
          { entity_id: "d-nonterm", owner_id: "task-nonterm" },
        ]);

        // Simulate a stale v5 PG projection before backfill refolds to v6.
        await backend.pool.query("DELETE FROM ha_projection_values WHERE model = 'dispatch-lifecycle-task'");
        await backend.pool.query("UPDATE ha_projection_meta SET dispatch_lifecycle_version=5");
        assert.equal((await backend.projection.readDispatchLifecycle({ by: "active", limit: 10 })).status, "pending");
      } finally {
        await backend.close();
      }

      const second = open();
      try {
        assert.deepEqual(second.projection.readDispatchLifecycle({ by: "active", limit: 20 }), active);
        const closed = second.projection.readDispatchLifecycle({
          by: "dispatch",
          dispatchIds: ["d-done", "d-cancel", "d-supersede", "d-retire", "d-replace"],
        });
        assert.ok(closed.status === "ready");
        assert.deepEqual(
          closed.rows.map((row) => [row.attemptGroupId, row.groupPhase, row.ruling, row.successor.admissible]),
          [
            ["d-done", "closed", null, false],
            ["d-cancel", "closed", null, false],
            ["d-supersede", "closed", null, false],
            ["d-retire", "closed", null, false],
            ["d-replace", "closed", null, false],
          ],
        );
      } finally {
        second.projection.close();
        await second.store.drain();
      }
    });
  });
});
