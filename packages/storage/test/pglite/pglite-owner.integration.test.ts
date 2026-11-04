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
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createPGliteStorage } from "../../src/pglite/transaction.ts";
import { makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { bundle, eventAt } from "../store/task-event-store.fixtures.ts";

pgliteIntegrationSuite("PGlite physical owner", () => {
  test("independent scoped facades can nest reads within one embedded snapshot", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const first = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "scope-a", projectId: "scope-a", policyEpoch: 1 },
        },
        second = { ...first, scope: { tenantId: "scope-b", projectId: "scope-b", policyEpoch: 1 } },
        a = makeTaskEventStore({ repoId: "nested-a", storage: first }),
        b = makeTaskEventStore({ repoId: "nested-b", storage: second });
      let reader: ReturnType<typeof makeTaskProjectionReader> | undefined;
      try {
        a.append(bundle(eventAt(1)));
        b.append(bundle(eventAt(1)));
        reader = makeTaskProjectionReader({ repoId: "nested-b", storage: second });
        reader.withSession((queries) => {
          const before = queries.read("task-00001").snapshot;
          assert.ok(before.task);
          assert.equal(a.readHead()?.revision, 1);
          const nested = makeTaskProjectionReader({ repoId: "nested-a", storage: first });
          try {
            assert.ok(nested.withSession((inner) => inner.read("task-00001").snapshot.task));
          } finally {
            nested.close();
          }
          assert.deepEqual(queries.read("task-00001").snapshot, before);
        });
      } finally {
        reader?.close();
        await a.drain();
        await b.drain();
      }
    });
  });
  test("a second process cannot open the live owner's directory; process death releases its OS mutex", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const dataDir = join(rootDir, "database");
      let child: ChildProcess | undefined;
      const start = (mode: string) => {
        child = fork(fileURLToPath(new URL("./pglite-mutex-process.fixture.ts", import.meta.url)), [mode, dataDir], {
          execArgv: [],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        return child;
      };
      try {
        const holder = start("hold"),
          [held] = await once(holder, "message");
        assert.equal(held.held, true);
        assert.throws(() => createPGliteStorage({ dataDir }), { code: "ERR_SQLITE_ERROR", errcode: 5 });
        const exit = once(holder, "exit");
        holder.kill("SIGKILL");
        await exit;
        const reopened = createPGliteStorage({ dataDir });
        try {
          await reopened.db.waitReady;
          assert.deepEqual((await reopened.db.query("SELECT value FROM survived")).rows, [{ value: 7 }]);
          const probe = start("probe"),
            probeExit = once(probe, "exit"),
            [denied] = await once(probe, "message");
          assert.equal(denied.error?.code, "ERR_SQLITE_ERROR");
          assert.equal(denied.error?.errcode, 5);
          await probeExit;
        } finally {
          await reopened.close();
        }
        assert.equal(existsSync(`${dataDir}.harness-owner-lock`), true, "retain the lock inode across owner lifetimes");
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exit = once(child, "exit");
          child.kill("SIGKILL");
          await exit;
        }
      }
    });
  });
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
        const nestedContext = prepareStorageWorkerContext(storage, repoId);
        try {
          worker = new Worker(new URL("./pglite-owner-worker.fixture.ts", import.meta.url), {
            workerData: {
              repoId,
              storage,
              context: nestedContext.context,
              stateRoot: rootDir,
              backupDirectory: join(rootDir, "nested-backup"),
            },
            transferList: nestedContext.transferList,
          });
          worker.once("exit", nestedContext.close);
          const exited = once(worker, "exit"),
            [archive] = await once(worker, "message");
          assert.equal(archive.revision, 1);
          assert.ok(archive.size > 0);
          await exited;
        } finally {
          await worker?.terminate();
          nestedContext.close();
        }
        const readContext = prepareStorageWorkerContext(storage, repoId);
        try {
          worker = new Worker(new URL("./pglite-owner-worker.fixture.ts", import.meta.url), {
            workerData: { repoId, storage, context: readContext.context, stateRoot: rootDir, readHeld: true },
            transferList: readContext.transferList,
          });
          worker.once("exit", readContext.close);
          const [held] = await once(worker, "message");
          assert.equal(held.readHeld, true);
          await worker.terminate();
          assert.equal(store.readHead()?.revision, 1);
          assert.ok(authority.acquire(repoId).epoch > next.epoch);
        } finally {
          await worker?.terminate();
          readContext.close();
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
