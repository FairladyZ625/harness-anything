// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { chainRepoCellWrite, withRepoCellWriteSlot } from "../src/daemon-host/repo-cell.ts";
import type { RepoCellQueueObservation, RepoCellWriteQueueState } from "../src/daemon-host/repo-cell-types.ts";

test("queue admission is reported before the preceding write releases its turn", async () => {
  const head = Promise.withResolvers<void>(),
    events: string[] = [];
  const pending = withRepoCellWriteSlot(
    async (work) => {
      events.push("acquired");
      return await work();
    },
    async () => await chainRepoCellWrite(head.promise, () => events.push("work")),
    () => events.push("queued"),
  );
  assert.deepEqual(events, ["queued"]);
  head.resolve();
  await pending;
  assert.deepEqual(events, ["queued", "acquired", "work"]);
});

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
  const queue: RepoCellWriteQueueState = { waiting: [], nowMs: () => nowMs },
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
  assert.equal(queue.waiting.length, 0, "the head clears when the owning turn settles");
});

test("an idle queue records no head and the next waiter sees the turn that started meanwhile", async () => {
  let nowMs = 0,
    release!: () => void;
  const queue: RepoCellWriteQueueState = { waiting: [], nowMs: () => nowMs },
    idle: RepoCellQueueObservation = { label: { command: "fact-record", requestId: "writer-request-1" } },
    first = chainRepoCellWrite(Promise.resolve(), () => undefined, {
      queue,
      label: idle.label,
      observation: idle,
    });
  assert.equal(idle.head, null, "an empty queue has no head to blame");
  await first;
  assert.equal(queue.waiting.length, 0);
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
  for (let turn = 0; turn < 10 && queue.waiting[0]?.startedAtMs === undefined; turn += 1)
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

test("a turn appended in the same tick behind a not-yet-started turn still names it", async () => {
  let nowMs = 10,
    release!: () => void;
  const queue: RepoCellWriteQueueState = { waiting: [], nowMs: () => nowMs },
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  let tail: Promise<void> = Promise.resolve();
  const first = chainRepoCellWrite(tail, () => gate, {
    queue,
    label: { command: "task-review-execution", requestId: "writer-request-1" },
  });
  tail = first.then(
    () => undefined,
    () => undefined,
  );
  nowMs = 25;
  const behind: RepoCellQueueObservation = { label: { command: "task-create", requestId: "writer-request-2" } },
    second = chainRepoCellWrite(tail, () => undefined, {
      queue,
      label: behind.label,
      observation: behind,
    });
  // The first turn has not run yet, so the honest executed time is zero; naming it is still required.
  assert.deepEqual(behind.head, {
    requestId: "writer-request-1",
    command: "task-review-execution",
    executingMs: 0,
  });
  release();
  await Promise.all([first, second]);
});

test("a synchronous throw removes its turn so the next waiter names the real head", async () => {
  let nowMs = 0,
    release!: () => void;
  const queue: RepoCellWriteQueueState = { waiting: [], nowMs: () => nowMs },
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  let tail: Promise<void> = Promise.resolve();
  const failing = chainRepoCellWrite(
    tail,
    () => {
      throw new Error("prune failed synchronously");
    },
    { queue, label: { command: "replication-prune", requestId: "writer-request-1" } },
  );
  tail = failing.then(
    () => undefined,
    () => undefined,
  );
  const blocking = chainRepoCellWrite(tail, () => gate, {
    queue,
    label: { command: "task-review-execution", requestId: "writer-request-2" },
  });
  tail = blocking.then(
    () => undefined,
    () => undefined,
  );
  await assert.rejects(failing, /prune failed synchronously/u);
  assert.deepEqual(
    queue.waiting.map((entry) => entry.label.command),
    ["task-review-execution"],
    "the thrown turn must not stay at the head",
  );
  for (let turn = 0; turn < 20 && queue.waiting[0]?.startedAtMs === undefined; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  nowMs = 700;
  const behind: RepoCellQueueObservation = { label: { command: "task-create", requestId: "writer-request-3" } },
    waiting = chainRepoCellWrite(tail, () => undefined, { queue, label: behind.label, observation: behind });
  assert.deepEqual(behind.head, {
    requestId: "writer-request-2",
    command: "task-review-execution",
    executingMs: 700,
  });
  release();
  await Promise.all([blocking, waiting]);
  assert.equal(queue.waiting.length, 0);
});

test("a rejected host slot dequeues once, removes its head, and never invokes database work", async () => {
  const queue: RepoCellWriteQueueState = { waiting: [], nowMs: () => 0 };
  let dequeued = 0,
    effects = 0;
  const abort = new DOMException("cancelled before write turn", "AbortError");
  await assert.rejects(
    withRepoCellWriteSlot(
      async () => {
        throw abort;
      },
      () =>
        chainRepoCellWrite(
          Promise.resolve(),
          () => {
            effects++;
          },
          {
            queue,
            label: { command: "task-create", requestId: "aborted" },
            onDequeued: () => {
              dequeued++;
            },
          },
        ),
    ),
    { name: "AbortError" },
  );
  assert.equal(effects, 0);
  assert.equal(dequeued, 1);
  assert.deepEqual(queue.waiting, []);
  await chainRepoCellWrite(Promise.resolve(), () => {
    effects++;
  });
  assert.equal(effects, 1, "the next independent turn must still run");
});

test("host slot context remains scoped to its RepoCell and releases before external continuation", async () => {
  const order: string[] = [];
  const continuation = Promise.withResolvers<void>();
  const turnDone = Promise.withResolvers<void>();
  const first = withRepoCellWriteSlot(
    async (work) => {
      order.push("acquire");
      try {
        return await work();
      } finally {
        order.push("release");
      }
    },
    async () => {
      await chainRepoCellWrite(Promise.resolve(), () => order.push("write"));
      turnDone.resolve();
      await continuation.promise;
      order.push("continuation");
    },
  );
  await turnDone.promise;
  await chainRepoCellWrite(Promise.resolve(), () => order.push("independent-cell"));
  assert.deepEqual(order, ["acquire", "write", "release", "independent-cell"]);
  continuation.resolve();
  await first;
});
