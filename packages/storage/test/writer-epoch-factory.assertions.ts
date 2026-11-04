import assert from "node:assert/strict";
import { join } from "node:path";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { makeTaskEventStore } from "../src/store/task-event-store.ts";
import type { StorageBackendConfig } from "../src/storage-backend.ts";
import { bundle, eventAt } from "./store/task-event-store.fixtures.ts";

export async function assertWriterEpochFactory(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly storage?: StorageBackendConfig;
}) {
  const { rootDir, repoId, storage } = input,
    stateRoot = join(rootDir, "epochs"),
    first = openPersistentWriterEpoch({ stateRoot, holderId: "holder-first", storage }),
    second = openPersistentWriterEpoch({ stateRoot, holderId: "holder-second", storage });
  let lease = first.acquire(repoId);
  const store = makeTaskEventStore({
    rootDir,
    repoId,
    storage,
    writerFence: () => lease,
  });
  try {
    first.withAppendFence(repoId, lease.epoch, lease.holderId, () => store.append(bundle(eventAt(1))));
    assert.equal(store.readHead()?.revision, 1);
    assert.deepEqual(first.current(repoId), lease);
    const newer = second.acquire(repoId);
    assert.ok(newer.epoch > lease.epoch);
    assert.throws(() => first.assert(repoId, lease.epoch), { code: "writer_epoch_stale" });
    assert.throws(
      () => first.withAppendFence(repoId, lease.epoch, lease.holderId, () => store.append(bundle(eventAt(2)))),
      { code: "writer_epoch_stale" },
    );
    assert.equal(store.readHead()?.revision, 1);
    lease = first.acquire(repoId);
    assert.ok(lease.epoch > newer.epoch);
    first.withAppendFence(repoId, lease.epoch, lease.holderId, () => store.append(bundle(eventAt(2))));
    assert.equal(store.readHead()?.revision, 2);
    first.retireCurrent(repoId);
    assert.equal(first.current(repoId), null);
    assert.equal(first.highWatermark(repoId), lease.epoch);
  } finally {
    await store.drain();
    first.close();
    second.close();
  }
}
