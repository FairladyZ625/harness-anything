// harness-test-tier: integration
import { assertEntityFactory } from "../entity-factory.assertions.ts";
import { openEntityStore } from "../../src/store/entity-store.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { assertWriterEpochFactory } from "../writer-epoch-factory.assertions.ts";
import { assertCanonicalFactoryLifecycle } from "../canonical-factory.assertions.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";

pgliteIntegrationSuite("PGlite synchronous factories", () => {
  test("canonical, projection and independent readers share one durable owner", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const repoId = "pglite-factory",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "tenant", projectId: "project", policyEpoch: 1 },
        },
        store = makeTaskEventStore({ repoId, rootDir, storage }),
        projection = makeTaskProjection({ rootDir, eventStore: store, storage });
      try {
        const { events, snapshot } = assertCanonicalFactoryLifecycle({
          store,
          projection,
          taskId: "task-factory",
          executionId: "execution-factory",
          reader: () => makeTaskProjectionReader({ repoId, storage }),
        });
        assertEntityFactory({
          store,
          open: () => openEntityStore(rootDir, { repoId, storage }),
          withReadSession: (read) => {
            const reader = makeTaskProjectionReader({ repoId, storage });
            try {
              reader.withSession(() => read());
            } finally {
              reader.close();
            }
          },
        });
        // Closing one facade cannot stop the owner still used by the other facade.
        projection.close();
        assert.equal(store.readHead()?.revision, events.length + 5);
        await store.drain();
        // Simulate a pre-expansion database, using the physical owner only after all facades closed.
        const old = await createPGliteStorageBackend({ repoId, storage });
        try {
          await old.pool.query("DELETE FROM ha_entity_declaration_heads");
          await old.pool.query("UPDATE ha_projection_meta SET entity_declaration_watermark=0");
        } finally {
          await old.close();
        }
        const progress: number[] = [];
        const reopened = makeTaskEventStore({ repoId, rootDir, storage }),
          reader = makeTaskProjectionReader({ repoId, storage }),
          warmed = makeTaskProjection({
            rootDir,
            eventStore: reopened,
            storage,
            catchUpLimit: 1,
            onProgress: ({ watermark }) => progress.push(watermark),
          });
        try {
          const receipt = await warmed.catchUpAsync!();
          assert.equal(receipt.watermark, events.length + 5);
          assert.equal(receipt.metrics.maxBatchItems, 1);
          assert.deepEqual(
            progress,
            Array.from({ length: events.length + 5 }, (_, i) => i + 1),
          );
          assert.equal(warmed.catchUp!().metrics.reducedItems, 0);
          assert.equal(reopened.readHead()?.revision, events.length + 5);
          assert.deepEqual(
            reader.withSession((queries) => queries.read("task-factory").snapshot),
            snapshot,
          );
        } finally {
          warmed.close();
          reader.close();
          await reopened.drain();
        }
      } finally {
        projection.close();
        await store.drain();
      }
    });
  });
  test("embedded append fence releases the physical session for its canonical append", async () => {
    await withTempStoreAsync(async (rootDir) => {
      await assertWriterEpochFactory({
        rootDir,
        repoId: "pglite-epoch",
        storage: {
          backend: "pglite",
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "epoch", projectId: "epoch", policyEpoch: 1 },
        },
      });
    });
  });
});
