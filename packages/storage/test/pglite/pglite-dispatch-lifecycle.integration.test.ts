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
import { history, requested, snapshot } from "../store/dispatch-lifecycle.fixtures.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

const LIFECYCLE_MODELS = [
  "dispatch-lifecycle-group",
  "dispatch-lifecycle-session",
  "dispatch-lifecycle-dispatch",
  "dispatch-lifecycle-active",
  "dispatch-lifecycle-execution",
  "dispatch-lifecycle-task-lease",
  "dispatch-lifecycle-cursor",
];

function append(store: ReturnType<typeof makeTaskEventStore>, event: AgentRuntimeEventV1): void {
  store.append({
    event,
    plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
    blobs: runtimeEventContentClaims(event).map((claim) => ({ ...claim, body: "" })),
  });
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
        // The append path refuses a second admission into the running group inside the ledger
        // transaction: the caller receives the kernel's code and nothing is appended.
        const head = first.store.readHead()?.revision;
        assert.throws(() => append(first.store, requested("dispatch-a3", "session-a3", "dispatch-a")), {
          code: "dispatch_group_busy",
        });
        assert.equal(first.store.readHead()?.revision, head);
        assert.deepEqual(snapshot(first.projection), online);
      } finally {
        first.projection.close();
        await first.store.drain();
      }

      // Simulate a projection written before this cut: every lifecycle value is absent.
      const backend = await createPGliteStorageBackend({ repoId, storage });
      try {
        await backend.pool.query("DELETE FROM ha_projection_values WHERE model = ANY($1::text[])", [LIFECYCLE_MODELS]);
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
});
