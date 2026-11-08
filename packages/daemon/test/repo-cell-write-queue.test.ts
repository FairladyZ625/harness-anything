// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { chainRepoCellWrite } from "../src/repo-cell.ts";
import type { RepoCellQueueObservation, RepoCellWriteQueueState } from "../src/repo-cell-types.ts";

test("a second write starts only after the first queued write settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    order: string[] = [];
  let tail: Promise<void> = Promise.resolve();
  const first = chainRepoCellWrite(tail, async () => {
    order.push("first-start");
    await gate;
    order.push("first-end");
  });
  tail = first.then(
    () => undefined,
    () => undefined,
  );
  const second = chainRepoCellWrite(tail, () => {
    order.push("second-start");
  });
  for (let turn = 0; turn < 10 && order.length === 0; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("a waiting write names the live head, its request id and how long it had run", async () => {
  let nowMs = 0,
    release!: () => void;
  const queue: RepoCellWriteQueueState = { head: null, nowMs: () => nowMs },
    gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started: string[] = [];
  let tail: Promise<void> = Promise.resolve();
  const first = chainRepoCellWrite(
    tail,
    async () => {
      started.push("task-create");
      await gate;
    },
    { queue, label: { command: "task-create", requestId: "writer-request-1" } },
  );
  tail = first.then(
    () => undefined,
    () => undefined,
  );
  for (let turn = 0; turn < 10 && started.length === 0; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  nowMs = 1_250;
  const observation: RepoCellQueueObservation = { label: { command: "task-push", requestId: "writer-request-2" } },
    second = chainRepoCellWrite(tail, () => started.push("task-push"), {
      queue,
      label: observation.label,
      observation,
    });
  assert.deepEqual(observation.head, {
    requestId: "writer-request-1",
    command: "task-create",
    executingMs: 1_250,
  });
  release();
  await Promise.all([first, second]);
  assert.equal(queue.head, null, "the head clears when the owning turn settles");
});

test("an idle queue records no head and the next waiter sees the turn that started meanwhile", async () => {
  let nowMs = 0,
    release!: () => void;
  const queue: RepoCellWriteQueueState = { head: null, nowMs: () => nowMs },
    idle: RepoCellQueueObservation = { label: { command: "fact-record", requestId: "writer-request-1" } },
    first = chainRepoCellWrite(Promise.resolve(), () => undefined, {
      queue,
      label: idle.label,
      observation: idle,
    });
  assert.equal(idle.head, null, "an empty queue has no head to blame");
  await first;
  let tail: Promise<void> = Promise.resolve();
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    head = chainRepoCellWrite(tail, () => gate, {
      queue,
      label: { command: "task-review-execution", requestId: "writer-request-2" },
    });
  tail = head.then(
    () => undefined,
    () => undefined,
  );
  for (let turn = 0; turn < 10 && queue.head === null; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  nowMs = 4_000;
  const waiter: RepoCellQueueObservation = { label: { command: "task-create", requestId: "writer-request-3" } },
    waiting = chainRepoCellWrite(tail, () => undefined, { queue, label: waiter.label, observation: waiter });
  assert.deepEqual(waiter.head, {
    requestId: "writer-request-2",
    command: "task-review-execution",
    executingMs: 4_000,
  });
  release();
  await Promise.all([head, waiting]);
});
