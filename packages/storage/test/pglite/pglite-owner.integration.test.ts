// harness-test-tier: integration
import assert from "node:assert/strict";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { prepareStorageWorkerContext } from "../../src/storage-worker-context.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { openPersistentWriterEpoch } from "../../src/writer-epoch.ts";
import { openStorageMigrationEndpoint } from "../../src/migration/open.ts";
import { openFleetStorage } from "../../src/storage-daemon-composition.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

pgliteIntegrationSuite("PGlite physical owner", () => {
  test("worker loss releases its fence after the accepted append and leaves other readers usable", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const repoId = "pglite-worker-owner",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "owner", projectId: "owner", policyEpoch: 1 },
        },
        store = makeTaskEventStore({ repoId, storage }),
        context = prepareStorageWorkerContext(storage, repoId),
        authority = openPersistentWriterEpoch({ stateRoot: rootDir, holderId: "replacement", storage });
      let worker: Worker | undefined;
      try {
        const held = await new Promise<{ readonly epoch: number }>((resolve, reject) => {
          worker = new Worker(new URL("./pglite-owner-worker.fixture.ts", import.meta.url), {
            workerData: { repoId, storage, context: context.context, stateRoot: rootDir },
            transferList: context.transferList,
          });
          worker.once("exit", context.close);
          worker.once("message", resolve);
          worker.once("error", reject);
          worker.once("exit", (code) => reject(new Error(`Writer exited before holding fence (${code})`)));
        });
        assert.equal(store.readHead()?.revision, 1);
        await worker!.terminate();
        const next = authority.acquire(repoId);
        assert.ok(next.epoch > held.epoch);
        assert.equal(store.readHead()?.revision, 1);
        const endpoint = await openStorageMigrationEndpoint(repoId, { storage });
        try {
          assert.equal(await endpoint.state(), null);
          assert.equal(await endpoint.epoch(), next.epoch);
        } finally {
          await endpoint.close();
        }
        const source = openFleetStorage({ rootDir, repoId, storage });
        try {
          assert.equal(source.replicationPosition().revision, 1);
          const backup = await source.startBackup(join(rootDir, "backup"), "unused");
          assert.equal(backup.metadata.position.revision, 1);
          const archive = await backup.complete;
          assert.ok(archive.size > 0);
        } finally {
          source.close();
        }
      } finally {
        await worker?.terminate();
        context.close();
        authority.close();
        await store.drain();
      }
    });
  });
});
