// harness-test-tier: integration
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { assertWriterEpochFactory } from "../writer-epoch-factory.assertions.ts";
import { assertCanonicalFactoryLifecycle } from "../canonical-factory.assertions.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

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
        // Closing one facade cannot stop the owner still used by the other facade.
        projection.close();
        assert.equal(store.readHead()?.revision, events.length);
        await store.drain();
        const reopened = makeTaskEventStore({ repoId, rootDir, storage }),
          reader = makeTaskProjectionReader({ repoId, storage });
        try {
          assert.equal(reopened.readHead()?.revision, events.length);
          assert.deepEqual(
            reader.withSession((queries) => queries.read("task-factory").snapshot),
            snapshot,
          );
        } finally {
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
