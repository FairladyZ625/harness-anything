// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createBaseBackupQueue } from "../src/fleet/basebackup-queue.ts";

test("base backup construction is FIFO bounded and reports measured queue estimates", async () => {
  const queue = createBaseBackupQueue(1),
    first = await queue.acquire(new AbortController().signal, () => undefined),
    secondStatus: { queuePosition: number; estimatedWaitMs: number | null }[] = [],
    thirdStatus: { queuePosition: number; estimatedWaitMs: number | null }[] = [],
    secondController = new AbortController(),
    thirdController = new AbortController(),
    second = queue.acquire(secondController.signal, (status) => secondStatus.push(status)),
    third = queue.acquire(thirdController.signal, (status) => thirdStatus.push(status));
  assert.deepEqual(secondStatus.at(-1), { queuePosition: 1, estimatedWaitMs: null });
  assert.deepEqual(thirdStatus.at(-1), { queuePosition: 2, estimatedWaitMs: null });
  first(true);
  const releaseSecond = await second;
  assert.equal(thirdStatus.at(-1)?.queuePosition, 1, "the waiter behind the admitted build moves to the head");
  releaseSecond(true);
  const releaseThird = await third;
  assert.equal(thirdStatus.at(-1)?.estimatedWaitMs !== null, true, "completed build duration supplies an ETA");
  releaseThird();
});

test("an aborted queued backup leaves the active lease and queue moving", async () => {
  const queue = createBaseBackupQueue(1),
    active = await queue.acquire(new AbortController().signal, () => undefined),
    controller = new AbortController(),
    queued = queue.acquire(controller.signal, () => undefined);
  controller.abort(new Error("connection closed"));
  await assert.rejects(queued, /connection closed/u);
  active();
});

test("closing the backup queue rejects waiters and waits for active leases", async () => {
  const queue = createBaseBackupQueue(1),
    active = await queue.acquire(new AbortController().signal, () => undefined),
    queued = queue.acquire(new AbortController().signal, () => undefined),
    closing = queue.close();
  await assert.rejects(queued, /queue is closed/u);
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  assert.equal(closed, false);
  active();
  await closing;
  assert.equal(closed, true);
  await assert.rejects(
    queue.acquire(new AbortController().signal, () => undefined),
    /queue is closed/u,
  );
});

test("one thousand queued replicas never exceed the configured backup build limit", async () => {
  const queue = createBaseBackupQueue(2),
    controllers = Array.from({ length: 1_000 }, () => new AbortController());
  let activeCount = 0,
    peakActive = 0;
  const leases = controllers.map((controller) =>
    queue
      .acquire(controller.signal, () => undefined)
      .then((release) => {
        activeCount += 1;
        peakActive = Math.max(peakActive, activeCount);
        return (completed = false) => {
          activeCount -= 1;
          release(completed);
        };
      }),
  );
  const active = await Promise.all(leases.slice(0, 2));
  assert.equal(activeCount, 2);
  for (let index = 2; index < leases.length; index += 1) {
    const release = active.shift()!;
    release(true);
    active.push(await leases[index]!);
  }
  active.forEach((release) => release());
  assert.equal(activeCount, 0);
  assert.equal(peakActive, 2);
});
