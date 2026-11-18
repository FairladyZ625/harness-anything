// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";

// dec_04A9211B073F29F0FC1E1CA573 CH2 / F2: each mutation lane excludes takeover,
// while only the append lane reserves the canonical epoch database's writer lock.
test("follower publication leaves canonical append writable and both lanes fence stale owners", (t) => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "ha-epoch-lanes-")),
    repoId = "lane-probe";
  const first = openPersistentWriterEpoch({ stateRoot, holderId: "first" }),
    second = openPersistentWriterEpoch({ stateRoot, holderId: "second" }),
    lease = first.acquire(repoId);
  t.after(() => {
    first.close();
    second.close();
    rmSync(stateRoot, { recursive: true, force: true });
  });
  first.withFollowerFence(repoId, lease.epoch, lease.holderId, () => {
    second.withAppendFence(repoId, lease.epoch, lease.holderId, () => assert.deepEqual(second.current(repoId), lease));
    const follower = new DatabaseSync(path.join(stateRoot, "writer-epochs", `${repoId}.follower.sqlite`));
    try {
      assert.throws(() => follower.exec("BEGIN IMMEDIATE"), /database is locked/u);
    } finally {
      follower.close();
    }
  });
  const next = second.acquire(repoId);
  assert.ok(next.epoch > lease.epoch);
  for (const fence of [first.withAppendFence, first.withFollowerFence])
    assert.throws(() => fence(repoId, lease.epoch, lease.holderId, () => assert.fail("stale mutation")), {
      code: "writer_epoch_stale",
    });
  second.retireCurrent(repoId);
  for (const fence of [second.withAppendFence, second.withFollowerFence])
    assert.throws(() => fence(repoId, next.epoch, next.holderId, () => assert.fail("retired mutation")), {
      code: "writer_epoch_stale",
    });
  assert.equal(second.highWatermark(repoId), next.epoch);
  second.close();
  const restarted = openPersistentWriterEpoch({ stateRoot, holderId: "restart" });
  try {
    assert.ok(restarted.acquire(repoId).epoch > next.epoch);
  } finally {
    restarted.close();
  }
});
