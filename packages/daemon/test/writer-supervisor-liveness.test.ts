// harness-test-tier: contract
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import type { RepoCellOpenInput } from "../src/repo-cell-open.ts";
import type { RepoCellStatus } from "../src/repo-cell-types.ts";
import { beginDaemonOperation, withDaemonObservation } from "../src/daemon-operation.ts";
import {
  REPO_WRITER_PROTOCOL_VERSION,
  type RepoWriterControlV1,
  type RepoWriterStatusV1,
} from "../src/repo-writer-protocol.ts";
import { openWriterSupervisor, WRITER_READY_WATCHDOG_MS } from "../src/writer-supervisor.ts";

const supervisorInput = {
  repoId: "writer-liveness",
  rootDir: "/tmp/writer-liveness",
  ownerId: "writer-liveness-test",
} as RepoCellOpenInput;

test("a writer may open beyond the ready watchdog when attach progress advances the ready watchdog", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new FakeWriter(),
    published: RepoCellStatus[] = [],
    opening = openWriterSupervisor(supervisorInput, {
      createWorker: () => writer as unknown as Worker,
      onAttachStatus: (status) => published.push(status),
    });

  context.mock.timers.tick(WRITER_READY_WATCHDOG_MS - 1);
  writer.publish(
    writerStatus(
      "attach-progress",
      warmingStatus({ phase: "catching-up", applied: 4_096, total: 8_192, watermark: 4_096 }),
    ),
  );
  context.mock.timers.tick(WRITER_READY_WATCHDOG_MS - 1);
  assert.equal(writer.terminateCalls, 0);
  writer.publish(writerStatus("ready", attachedStatus()));
  writer.publish(
    writerStatus(
      "attach-progress",
      warmingStatus({ phase: "catching-up", applied: 8_192, total: 8_192, watermark: 8_192 }),
    ),
  );

  const supervisor = await opening;
  assert.equal(supervisor.status().state, "attached");
  assert.equal(supervisor.status().generation, 1);
  assert.equal(supervisor.status().attach, undefined);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0]?.attach, {
    phase: "catching-up",
    applied: 4_096,
    total: 8_192,
    watermark: 4_096,
  });
  await supervisor.close();
});

test("a writer with no messages is terminated after the ready watchdog of inactivity", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new FakeWriter(),
    opening = openWriterSupervisor(supervisorInput, {
      createWorker: () => writer as unknown as Worker,
    }),
    rejected = assert.rejects(opening, /RepoWriterCell did not publish ready/u);

  context.mock.timers.tick(WRITER_READY_WATCHDOG_MS - 1);
  assert.equal(writer.terminateCalls, 0);
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(writer.terminateCalls, 1);
});

test("an attach status heartbeat keeps a slow projection open alive beyond the ready watchdog", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new FakeWriter(),
    opening = openWriterSupervisor(supervisorInput, { createWorker: () => writer as unknown as Worker }),
    heartbeat = warmingStatus({ phase: "opening", applied: null, total: null, watermark: null });

  writer.publish(writerStatus("attach-progress", heartbeat));
  writer.publish(writerStatus("status", heartbeat));
  context.mock.timers.tick(WRITER_READY_WATCHDOG_MS - 1);
  writer.publish(writerStatus("status", heartbeat));
  context.mock.timers.tick(WRITER_READY_WATCHDOG_MS - 1);

  assert.equal(writer.terminateCalls, 0);
  writer.publish(writerStatus("ready", attachedStatus()));
  const supervisor = await opening;
  assert.equal(supervisor.status().state, "attached");
  await supervisor.close();
});

test("runtime restoration heartbeats remain live after projection phases advance", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new FakeWriter(),
    opening = openWriterSupervisor(supervisorInput, { createWorker: () => writer as unknown as Worker }),
    publish = (kind: RepoWriterStatusV1["kind"], attach: NonNullable<RepoCellStatus["attach"]>) =>
      writer.publish(writerStatus(kind, warmingStatus(attach)));

  publish("attach-progress", { phase: "recovering", applied: 1, total: 1, watermark: null });
  publish("attach-progress", { phase: "catching-up", applied: 1, total: 1, watermark: 1 });
  publish("attach-progress", { phase: "restoring-runtimes", applied: 0, total: null, watermark: null });
  context.mock.timers.tick(WRITER_READY_WATCHDOG_MS - 1);
  publish("status", { phase: "restoring-runtimes", applied: 0, total: null, watermark: null });
  context.mock.timers.tick(WRITER_READY_WATCHDOG_MS - 1);

  assert.equal(writer.terminateCalls, 0);
  writer.publish(writerStatus("ready", attachedStatus()));
  const supervisor = await opening;
  assert.equal(supervisor.status().state, "attached");
  await supervisor.close();
});

test("a failed first open does not prevent a later supervisor from opening", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const first = new FakeWriter(true),
    second = new FakeWriter(),
    workers = [first, second],
    createWorker = () => workers.shift() as unknown as Worker,
    opening = openWriterSupervisor(supervisorInput, { createWorker }),
    rejected = assert.rejects(opening, new RegExp(`${WRITER_READY_WATCHDOG_MS}ms without progress`));

  context.mock.timers.tick(WRITER_READY_WATCHDOG_MS);
  await rejected;
  context.mock.timers.tick(1_000);
  assert.equal(first.terminateCalls, 1);
  assert.equal(workers.length, 1);

  const reopened = openWriterSupervisor(supervisorInput, { createWorker });
  second.publish(writerStatus("ready", attachedStatus()));
  const supervisor = await reopened;
  assert.equal(supervisor.status().state, "attached");
  assert.equal(first.terminateCalls, 1);
  await supervisor.close();
});

test("advancing watermark may continue beyond ten minutes; repeated watermark cannot renew it", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const writer = new FakeWriter();
  const opening = openWriterSupervisor(supervisorInput, { createWorker: () => writer as unknown as Worker });
  const rejected = assert.rejects(opening, new RegExp(`${WRITER_READY_WATCHDOG_MS}ms without progress`));
  for (let watermark = 1; watermark <= 31; watermark += 1) {
    context.mock.timers.tick(20_000);
    writer.publish(
      writerStatus(
        "attach-progress",
        warmingStatus({ phase: "catching-up", applied: watermark, total: 100, watermark }),
      ),
    );
    assert.equal(writer.terminateCalls, 0);
  }
  context.mock.timers.tick(20_000);
  writer.publish(
    writerStatus("attach-progress", warmingStatus({ phase: "catching-up", applied: 31, total: 100, watermark: 31 })),
  );
  context.mock.timers.tick(WRITER_READY_WATCHDOG_MS - 20_000 - 1);
  assert.equal(writer.terminateCalls, 0);
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(writer.terminateCalls, 1);
});

test("a writer becomes ready after multiple completed runtime restorations beyond the ready watchdog", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new FakeWriter(),
    opening = openWriterSupervisor(supervisorInput, { createWorker: () => writer as unknown as Worker });
  writer.publish(
    writerStatus("attach-progress", warmingStatus({ phase: "catching-up", applied: 100, total: 100, watermark: 100 })),
  );
  for (const applied of [1, 2, 3]) {
    context.mock.timers.tick(20_000);
    writer.publish(
      writerStatus(
        "attach-progress",
        warmingStatus({ phase: "restoring-runtimes", applied, total: null, watermark: null }),
      ),
    );
    assert.equal(writer.terminateCalls, 0);
  }
  writer.publish(writerStatus("ready", attachedStatus()));
  const supervisor = await opening;
  assert.equal(supervisor.status().state, "attached");
  await supervisor.close();
});

test("completed runtime restorations extend startup, but duplicate, older and stale phase progress cannot", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new FakeWriter(),
    opening = openWriterSupervisor(supervisorInput, { createWorker: () => writer as unknown as Worker }),
    rejected = assert.rejects(opening, new RegExp(`${WRITER_READY_WATCHDOG_MS}ms without progress`));
  writer.publish(
    writerStatus("attach-progress", warmingStatus({ phase: "catching-up", applied: 100, total: 100, watermark: 100 })),
  );
  for (const applied of [1, 2, 3]) {
    context.mock.timers.tick(20_000);
    writer.publish(
      writerStatus(
        "attach-progress",
        warmingStatus({ phase: "restoring-runtimes", applied, total: null, watermark: null }),
      ),
    );
    assert.equal(writer.terminateCalls, 0);
  }
  context.mock.timers.tick(20_000);
  for (const applied of [3, 2])
    writer.publish(
      writerStatus(
        "attach-progress",
        warmingStatus({ phase: "restoring-runtimes", applied, total: null, watermark: null }),
      ),
    );
  writer.publish(
    writerStatus("attach-progress", warmingStatus({ phase: "catching-up", applied: 101, total: 101, watermark: 101 })),
  );
  context.mock.timers.tick(WRITER_READY_WATCHDOG_MS - 20_000 - 1);
  assert.equal(writer.terminateCalls, 0);
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(writer.terminateCalls, 1);
});

test("a writer receipt records the queue head a waiting request was behind", async () => {
  const writer = new FakeWriter(),
    opening = openWriterSupervisor(supervisorInput, { createWorker: () => writer as unknown as Worker });
  writer.publish(writerStatus("ready", attachedStatus()));
  const supervisor = await opening;
  try {
    const trace = await withDaemonObservation(
      { begin: () => ({ update: () => undefined, end: () => undefined }) },
      async () => {
        const scope = beginDaemonOperation({ method: "repo.task.run" });
        assert.ok(scope !== null, "the observer establishes an operation for the request");
        try {
          await scope.run(() => supervisor.request("run", { action: { kind: "task-create" } }));
          return scope.handle.trace();
        } finally {
          scope.end();
        }
      },
    );
    assert.deepEqual(trace.queueHead, {
      requestId: "writer-request-head",
      command: "builtin:ledger-backup",
      executingMs: 592_000,
    });
  } finally {
    await supervisor.close();
  }
});

class FakeWriter extends EventEmitter {
  terminateCalls = 0;
  private readonly emitExitOnTerminate: boolean;

  constructor(emitExitOnTerminate = false) {
    super();
    this.emitExitOnTerminate = emitExitOnTerminate;
  }

  postMessage(message: unknown): void {
    if (isWriteRequest(message)) {
      this.emit("message", {
        schema: "harness-repo-writer-receipt/v1",
        protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
        requestId: message.requestId,
        outcome: "ok",
        value: { outcome: "applied" },
        startedAtMs: 100,
        executionStartedAtMs: 500,
        finishedAtMs: 600,
        queueHead: {
          requestId: "writer-request-head",
          command: "builtin:ledger-backup",
          executingMs: 592_000,
        },
      });
      return;
    }
    if (!isControl(message)) return;
    this.emit("message", {
      schema: "harness-repo-writer-receipt/v1",
      protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
      requestId: message.requestId,
      outcome: "ok",
    });
  }

  publish(message: RepoWriterStatusV1): void {
    this.emit("message", message);
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    if (this.emitExitOnTerminate) this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

function writerStatus(kind: RepoWriterStatusV1["kind"], status: RepoCellStatus): RepoWriterStatusV1 {
  return {
    schema: "harness-repo-writer-status/v1",
    protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
    kind,
    status,
  };
}

function warmingStatus(attach: NonNullable<RepoCellStatus["attach"]>): RepoCellStatus {
  return {
    repoId: supervisorInput.repoId,
    rootDir: supervisorInput.rootDir,
    mode: "local",
    state: "warming",
    generation: null,
    queueDepth: 0,
    lastError: null,
    causeClass: null,
    recoveryMs: null,
    attach,
  };
}

function attachedStatus(): RepoCellStatus {
  return {
    repoId: supervisorInput.repoId,
    rootDir: supervisorInput.rootDir,
    mode: "local",
    state: "attached",
    generation: 1,
    queueDepth: 0,
    lastError: null,
    causeClass: null,
    recoveryMs: 1,
  };
}

function isControl(value: unknown): value is RepoWriterControlV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly schema?: unknown }).schema === "harness-repo-writer-control/v1"
  );
}

function isWriteRequest(value: unknown): value is { readonly requestId: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly schema?: unknown }).schema === "harness-repo-writer-request/v1"
  );
}
