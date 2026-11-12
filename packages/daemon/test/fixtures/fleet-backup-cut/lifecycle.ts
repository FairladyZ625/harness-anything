import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { fleetReplicationFixture, replicationRepoId } from "../../fleet-replication.fixture.ts";
import { fleetHostWriterOptions } from "../../fleet-store.fixture.ts";
import { cutProbe } from "./probe.ts";

export type Lifecycle = "queued-abort" | "before-pinned-failure" | "after-pinned-failure" | "after-pinned-abort";

export async function runLifecycle(t: TestContext, schedule: Lifecycle): Promise<void> {
  const fault = schedule.endsWith("failure")
    ? schedule === "before-pinned-failure"
      ? "before-pinned"
      : "after-pinned"
    : undefined;
  const { config, entries, wait, record, release } = cutProbe(t, schedule, fault);
  const f = await fleetReplicationFixture(t);
  const writer = fleetHostWriterOptions(f.userRoot, [replicationRepoId]);
  const lease = writer.writerEpochLease(replicationRepoId);
  const backup = (name: string, signal?: AbortSignal) =>
    f.host.replica(replicationRepoId).backup(
      {
        directory: path.join(f.root, name),
        writerEpochFence: {
          schema: "harness-writer-epoch-fence/v1",
          stateRoot: writer.writerEpochStateRoot,
          repoId: replicationRepoId,
          epoch: lease.epoch,
          holderId: lease.holderId,
        },
      },
      signal,
    );
  const controller = new AbortController();
  // Observe rejection immediately, including while the test waits at another discrete boundary.
  const first = backup("first", controller.signal).then(
    (archive) => ({ archive, error: null }),
    (error: Error) => ({ archive: null, error }),
  );
  const snapshot = await wait("snapshot-dispatched");
  await wait("ledger-select");
  if (schedule === "queued-abort") {
    const queuedController = new AbortController();
    const queued = backup("cancelled-before-start", queuedController.signal).then(
      () => null,
      (error: Error) => error,
    );
    const second = await wait("snapshot-dispatched", (e) => e.requestId !== snapshot.requestId);
    queuedController.abort();
    await wait("cancel-received", (e) => e.requestId === second.requestId);
    release();
    assert.equal((await first).error, null);
    const rejected = await queued;
    assert.equal(rejected?.name, "AbortError");
    const receipt = await wait("snapshot-receipt", (e) => e.requestId === second.requestId);
    assert.equal(receipt.queueHead?.requestId, snapshot.requestId);
    assert.equal(
      entries.filter((e) => e.event === "backup-created").length,
      1,
      "cancelled waiter never starts a worker",
    );
    assert.equal(existsSync(path.join(f.root, "cancelled-before-start")), false);
  } else {
    release();
    if (schedule.startsWith("after-pinned")) {
      await wait("pinned");
      await wait("archive-held");
      if (schedule === "after-pinned-abort") {
        controller.abort();
        await wait("cancel-received", (e) => e.requestId === snapshot.requestId);
      } else release(2);
    }
    const result = await first;
    const failed = await wait("snapshot-receipt", (e) => e.requestId === snapshot.requestId);
    assert.equal(result.archive, null);
    assert.equal(result.error?.message, failed.error.message, "the original worker failure survives the writer IPC");
    if (fault)
      assert.equal(
        result.error?.message,
        `injected backup failure ${fault === "before-pinned" ? "before" : "after"} pinning`,
      );
    else assert.match(result.error!.message, /base backup worker exited before completion/u);
    assert.equal(
      entries.some((e) => e.event === "pinned"),
      schedule !== "before-pinned-failure",
    );
    assert.equal(
      entries.some((e) => e.event === "archive-complete"),
      false,
    );
    await wait("backup-exit");
    release(2);
  }
  const receipt = await f.centerRun({
    kind: "task-create",
    taskId: config.taskId,
    title: "write after backup settlement",
  });
  assert.equal(receipt.outcome, "applied");
  const written = await wait("writer-receipt");
  assert.equal(written.queueHead, null, "settled snapshot leaves no stale queue owner");
  const archive = await backup("subsequent");
  assert.ok(existsSync(archive.file));
  assert.equal(archive.metadata.position.revision, f.host.replica(replicationRepoId).ledgerCut()!.revision);
  assert.ok(f.host.status().repos.some((r) => r.repoId === replicationRepoId && r.state === "attached"));
  record("lifecycle-recovered", { revision: archive.metadata.position.revision, outcome: receipt.outcome });
}
