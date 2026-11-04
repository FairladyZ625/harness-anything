// harness-test-tier: integration
import test from "node:test";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { assertCanonicalFactoryLifecycle } from "../canonical-factory.assertions.ts";
import { assertWriterEpochFactory } from "../writer-epoch-factory.assertions.ts";
import { withTempStoreAsync } from "./helpers.ts";

test("SQLite synchronous factories satisfy the shared canonical lifecycle contract", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const repoId = "sqlite-factory",
      store = makeTaskEventStore({ rootDir, repoId }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      assertCanonicalFactoryLifecycle({
        store,
        projection,
        taskId: "task-factory",
        executionId: "execution-factory",
        reader: () => makeTaskProjectionReader({ rootDir }),
      });
    } finally {
      projection.close();
      await store.drain();
    }
  });
});

test("SQLite writer epoch factories preserve append fencing", async () => {
  await withTempStoreAsync(async (rootDir) => {
    await assertWriterEpochFactory({ rootDir, repoId: "sqlite-epoch" });
  });
});
