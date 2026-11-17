// harness-test-tier: contract
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import { openWriterSupervisor } from "../src/daemon-host/writer-supervisor.ts";
import { REPO_WRITER_QUEUE_LIMIT } from "../src/daemon-host/writer-request-queue.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import type {
  RepoWriterRequestV1,
  RepoWriterControlV1,
  RepoWriterCancelV1,
  RepoWriterCapabilityCallV1,
  RepoWriterCapabilityResultV1,
} from "../src/daemon-host/repo-writer-protocol.ts";

const input = {
  repoId: workspaceId("syncrep-admission"),
  rootDir: canonicalRoot(process.cwd()),
  ownerId: "test",
  storage: {
    backend: "postgres" as const,
    connectionString: "postgres://test",
    authorityConnectionString: "postgres://test",
  },
};
class HeldWriter extends EventEmitter {
  writes: RepoWriterRequestV1[] = [];
  cancels: string[] = [];
  terminated = 0;
  posted = Promise.withResolvers<void>();
  capabilities = new Map<string, PromiseWithResolvers<RepoWriterCapabilityResultV1>>();
  capability(capability: RepoWriterCapabilityCallV1["capability"], payload: unknown) {
    const callId = `call-${this.capabilities.size}`,
      done = Promise.withResolvers<RepoWriterCapabilityResultV1>();
    this.capabilities.set(callId, done);
    this.emit("message", { schema: "harness-repo-writer-capability-call/v1", callId, capability, payload });
    return done.promise;
  }
  postMessage(message: RepoWriterRequestV1 | RepoWriterControlV1 | RepoWriterCancelV1 | RepoWriterCapabilityResultV1) {
    if (message.schema === "harness-repo-writer-capability-result/v1")
      this.capabilities.get(message.callId)!.resolve(message);
    else if (message.schema === "harness-repo-writer-control/v1") this.receipt(message.requestId, null);
    else if (message.schema === "harness-repo-writer-cancel/v1") this.cancels.push(message.requestId);
    else {
      this.writes.push(message);
      this.posted.resolve();
    }
  }
  receipt(requestId: string, value: unknown = "committed") {
    this.emit("message", { schema: "harness-repo-writer-receipt/v1", requestId, outcome: "ok", value });
  }
  terminate() {
    this.terminated++;
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
  unref() {}
}
async function open(
  options: Parameters<typeof openWriterSupervisor>[1] = {},
  config: Parameters<typeof openWriterSupervisor>[0] = input,
  stagedWriteSlot = false,
) {
  const worker = new HeldWriter();
  const opening = openWriterSupervisor(config, { ...options, createWorker: () => worker as unknown as Worker });
  worker.emit("message", {
    schema: "harness-repo-writer-status/v1",
    kind: "ready",
    stagedWriteSlot,
    status: { ...input, state: "attached", generation: 1, queueDepth: 0 },
  });
  return { supervisor: await opening, worker };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("C3/C4: queued abort removes admission immediately and overload never enters the worker", async () => {
  const { supervisor, worker } = await open();
  const first = supervisor.request("run", { opId: "first" });
  await worker.posted.promise;
  const abort = new AbortController();
  const cancelled = assert.rejects(supervisor.request("run", { opId: "queued" }, undefined, abort.signal), {
    name: "AbortError",
  });
  await turn();
  const before = performance.now();
  abort.abort();
  await cancelled;
  const cancelMs = performance.now() - before;
  assert.equal(worker.writes.length, 1, "a queued cancellation must have zero worker/database effects");
  const aborts = Array.from({ length: REPO_WRITER_QUEUE_LIMIT - 1 }, () => new AbortController());
  const waiting = aborts.map((controller, i) =>
    supervisor.request("run", { opId: `queued-${i}` }, undefined, controller.signal),
  );
  const rejected = waiting.map((result) => assert.rejects(result, { name: "AbortError" }));
  const atLimit = performance.now();
  await assert.rejects(supervisor.request("run", { opId: "overload" }), {
    code: "write_overloaded",
    data: { retryable: true },
  });
  const overloadMs = performance.now() - atLimit;
  assert.equal(supervisor.status().queueDepth, 64);
  assert.equal(worker.writes.length, 1);
  for (const controller of aborts) controller.abort();
  worker.receipt(worker.writes[0]!.requestId);
  await first;
  await supervisor.close();
  await Promise.all(rejected);
  console.log(
    "S3_C3_C4",
    JSON.stringify({ cancelMs, overloadMs, queueLimit: REPO_WRITER_QUEUE_LIMIT, posted: worker.writes.length }),
  );
});

for (const cancelBy of ["signal", "timeout", "close"] as const)
  test(`C5/C6b: ${cancelBy} detaches the caller and retains the slot until its real receipt`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const warnings: unknown[] = [];
    const { supervisor, worker } = await open({
      requestTimeoutMs: 200,
      syncRepDrainGraceMs: 5_000,
      onWarning: (warning) => warnings.push(warning),
    });
    const abort = new AbortController();
    const first = supervisor.request<{ outcome: string; opId: string }>(
      "run",
      { opId: "Attempt_X" },
      undefined,
      abort.signal,
    );
    await worker.posted.promise;
    const request = worker.writes[0]!,
      state = request.writeRequest!.state;
    assert.equal(state.byteLength, 12);
    assert.equal(Atomics.compareExchange(state, 1, 0, 1), 0);
    const second = supervisor.request("run", { opId: "next" });
    const secondResult = cancelBy === "close" ? assert.rejects(second, { code: "daemon_closing" }) : second;
    if (cancelBy === "signal") abort.abort();
    else if (cancelBy === "timeout") t.mock.timers.tick(200);
    else {
      const closing = supervisor.close();
      t.mock.timers.tick(5_000);
      await closing;
      assert.equal(warnings.length, 1);
    }
    assert.deepEqual(await first, {
      outcome: "indeterminate",
      code: "publication_indeterminate",
      opId: "Attempt_X",
      origin: "daemon",
    });
    await turn();
    assert.equal(worker.writes.length, 1);
    assert.equal(Atomics.load(state, 1), 1);
    assert.equal(worker.terminated, 0);
    assert.equal(worker.cancels.length, 0);
    worker.posted = Promise.withResolvers<void>();
    worker.receipt(request.requestId);
    if (cancelBy !== "close") {
      await worker.posted.promise;
      assert.equal(worker.writes.length, 2);
      assert.notEqual(worker.writes[1]!.writeRequest!.state.buffer, state.buffer);
      worker.receipt(worker.writes[1]!.requestId);
    }
    await secondResult;
    if (cancelBy !== "close") await supervisor.close();
    else await turn();
    console.log("S3_C6B", JSON.stringify({ cancelBy, phase: state[1], terminateDuringSyncRep: 0, warnings }));
  });

test("C6a: host abort wins once, sends cancellation, and keeps the slot through rollback", async () => {
  const { supervisor, worker } = await open();
  const abort = new AbortController();
  const first = assert.rejects(supervisor.request("run", { opId: "Attempt_X" }, undefined, abort.signal), {
    name: "AbortError",
  });
  await worker.posted.promise;
  const request = worker.writes[0]!,
    state = request.writeRequest!.state;
  abort.abort();
  assert.equal(Atomics.compareExchange(state, 1, 0, 1), -1);
  assert.equal(worker.terminated, 0);
  const second = supervisor.request("run", { opId: "next" });
  await turn();
  assert.equal(worker.writes.length, 1);
  worker.posted = Promise.withResolvers<void>();
  worker.receipt(request.requestId, "rolled-back");
  await first;
  await worker.posted.promise;
  worker.receipt(worker.writes[1]!.requestId);
  await second;
  await supervisor.close();
});

test("C6a: close terminates a stuck rollback only after abort wins and the full grace elapses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { supervisor, worker } = await open({ rollbackGraceMs: 5_000 });
  const first = assert.rejects(supervisor.request("run", { opId: "stuck-rollback" }), {
    code: "writer_rollback_timeout",
  });
  await worker.posted.promise;
  const state = worker.writes[0]!.writeRequest!.state;
  const closing = supervisor.close();
  assert.equal(state[1], -1);
  assert.equal(worker.terminated, 0);
  t.mock.timers.tick(4_999);
  assert.equal(worker.terminated, 0);
  t.mock.timers.tick(1);
  await Promise.all([first, closing]);
  assert.equal(worker.terminated, 1);
});

test("SQLite close drains its active batch without treating an absent PG phase as pre-commit", async () => {
  const { supervisor, worker } = await open({}, { ...input, storage: undefined });
  const first = supervisor.request("run", { opId: "sqlite-batch" });
  await worker.posted.promise;
  const queued = assert.rejects(supervisor.request("run", { opId: "queued" }), { code: "daemon_closing" });
  const closing = supervisor.close();
  await turn();
  assert.equal(worker.cancels.length, 0);
  assert.equal(worker.terminated, 0);
  assert.equal(worker.writes.length, 1);
  worker.receipt(worker.writes[0]!.requestId, "batch completed");
  assert.equal(await first, "batch completed");
  await queued;
  await closing;
  assert.equal(worker.terminated, 1, "retirement follows the batch receipt and drain");
});

test("staged turns keep preparation concurrent, hold detached SyncRep, and release before RPC continuation", async () => {
  const { supervisor, worker } = await open({}, input, true);
  const abort = new AbortController();
  const first = supervisor.request("run", { opId: "Attempt_X" }, undefined, abort.signal);
  await worker.posted.promise;
  worker.posted = Promise.withResolvers<void>();
  const preparation = supervisor.request("spawnRuntime", {});
  await worker.posted.promise;
  assert.equal(worker.writes.length, 2, "external preparation does not occupy the DB slot");
  assert.equal(worker.writes[0]!.writeRequest, undefined);
  const acquired = await worker.capability("acquireWriteSlot", { requestId: worker.writes[0]!.requestId });
  assert.equal(acquired.outcome, "ok");
  const slot = acquired.value as { state: Int32Array; id: number };
  assert.equal(slot.state.byteLength, 12);
  assert.equal(Atomics.compareExchange(slot.state, 1, 0, 1), 0);
  const waiting = supervisor.request("run", { opId: "next" });
  abort.abort();
  assert.deepEqual(await first, {
    outcome: "indeterminate",
    code: "publication_indeterminate",
    opId: "Attempt_X",
    origin: "daemon",
  });
  await turn();
  assert.equal(worker.writes.length, 2);
  assert.equal(worker.terminated, 0);
  assert.equal(worker.cancels.length, 0);
  // The real work() has now returned, but its RPC's external continuation remains blocked.
  worker.posted = Promise.withResolvers<void>();
  await worker.capability("releaseWriteSlot", { slotId: slot.id });
  await worker.posted.promise;
  assert.equal(worker.writes.length, 3);
  assert.equal(Atomics.load(slot.state, 1), 1, "release never resets a committed phase");
  worker.receipt(worker.writes[2]!.requestId);
  await waiting;
  worker.receipt(worker.writes[0]!.requestId);
  worker.receipt(worker.writes[1]!.requestId);
  await preparation;
  await supervisor.close();
});

test("staged preparation abort vetoes late DB work and retains ownership through its cleanup receipt", async () => {
  const { supervisor, worker } = await open({}, input, true);
  const abort = new AbortController();
  const result = assert.rejects(supervisor.request("run", {}, undefined, abort.signal), { name: "AbortError" });
  await worker.posted.promise;
  const requestId = worker.writes[0]!.requestId;
  abort.abort();
  assert.equal(await Promise.race([result.then(() => true), turn().then(() => false)]), true);
  assert.deepEqual(worker.cancels, [requestId]);
  const acquired = await worker.capability("acquireWriteSlot", { requestId });
  assert.equal(acquired.outcome, "error");
  assert.equal(acquired.error!.name, "AbortError");
  assert.equal(supervisor.status().queueDepth, 1, "preparation remains counted until its raw receipt");
  worker.receipt(requestId);
  await result;
  await turn();
  await supervisor.close();
});

test("C3: a pre-dispatched queued turn cancels before another request leaves SyncRep", async () => {
  const { supervisor, worker } = await open({}, input, true),
    abort = new AbortController(),
    first = supervisor.request("run", { opId: "sync-rep" }),
    second = supervisor.request("run", { opId: "pre-dispatched" }, undefined, abort.signal),
    cancelled = assert.rejects(second, { name: "AbortError" });
  await turn();
  const [head, waiting] = worker.writes;
  assert.equal(worker.writes.length, 2);
  // The real seam reports queue admission before waiting for the preceding turn.
  await worker.capability("writeQueued", { requestId: waiting!.requestId });
  const slot = (await worker.capability("acquireWriteSlot", { requestId: head!.requestId })).value as {
    state: Int32Array;
    id: number;
  };
  assert.equal(Atomics.compareExchange(slot.state, 1, 0, 1), 0);
  try {
    abort.abort();
    assert.equal(
      await Promise.race([cancelled.then(() => "cancelled"), turn().then(() => "still waiting")]),
      "cancelled",
      "cancellation must settle without releasing the SyncRep barrier",
    );
    assert.equal(supervisor.status().queueDepth, 2, "the bounded owner retains both raw receipts");
    assert.equal(worker.terminated, 0);
    const late = await worker.capability("acquireWriteSlot", { requestId: waiting!.requestId });
    assert.equal(late.outcome, "error", "a cancelled turn never reaches work, even after a late acquire");
  } finally {
    await worker.capability("releaseWriteSlot", { slotId: slot.id });
    worker.receipt(head!.requestId);
    worker.receipt(waiting!.requestId);
    await Promise.all([first, cancelled]);
    await turn();
    assert.equal(supervisor.status().queueDepth, 0);
    await supervisor.close();
  }
});

test("C3: cancellation preceding the queue notification still settles behind SyncRep", async () => {
  const { supervisor, worker } = await open({}, input, true),
    first = supervisor.request("run", {}),
    abort = new AbortController(),
    second = assert.rejects(supervisor.request("run", {}, undefined, abort.signal), { name: "AbortError" });
  await turn();
  const [head, waiting] = worker.writes,
    slot = (await worker.capability("acquireWriteSlot", { requestId: head!.requestId })).value as {
      state: Int32Array;
      id: number;
    };
  Atomics.compareExchange(slot.state, 1, 0, 1);
  abort.abort();
  await worker.capability("writeQueued", { requestId: waiting!.requestId });
  assert.equal(await Promise.race([second.then(() => true), turn().then(() => false)]), true);
  const late = await worker.capability("acquireWriteSlot", { requestId: waiting!.requestId });
  assert.equal(late.outcome, "error");
  assert.equal(worker.terminated, 0);
  await worker.capability("releaseWriteSlot", { slotId: slot.id });
  worker.receipt(head!.requestId);
  worker.receipt(waiting!.requestId);
  await Promise.all([first, second]);
  await supervisor.close();
});

test("C3: a later queued turn retains cancellation after an earlier turn releases its slot", async () => {
  const { supervisor, worker } = await open({}, input, true),
    abort = new AbortController(),
    result = assert.rejects(supervisor.request("run", {}, undefined, abort.signal), { name: "AbortError" });
  await worker.posted.promise;
  const requestId = worker.writes[0]!.requestId;
  await worker.capability("writeQueued", { requestId });
  await worker.capability("writeQueued", { requestId });
  const slot = (await worker.capability("acquireWriteSlot", { requestId })).value as { id: number };
  await worker.capability("releaseWriteSlot", { slotId: slot.id });
  abort.abort();
  assert.equal(await Promise.race([result.then(() => true), turn().then(() => false)]), true);
  assert.equal((await worker.capability("acquireWriteSlot", { requestId })).outcome, "error");
  worker.receipt(requestId);
  await result;
  await supervisor.close();
});

test("detached queue cleanup retains admission and reports unexpected failure with its own code", async () => {
  const warnings: unknown[] = [],
    { supervisor, worker } = await open({ onWarning: (warning) => warnings.push(warning) }, input, true),
    abort = new AbortController(),
    result = assert.rejects(supervisor.request("run", { opId: "queued-cleanup" }, undefined, abort.signal), {
      name: "AbortError",
    });
  await worker.posted.promise;
  const requestId = worker.writes[0]!.requestId;
  await worker.capability("writeQueued", { requestId });
  abort.abort();
  await result;
  assert.equal(supervisor.status().queueDepth, 1);
  worker.emit("message", {
    schema: "harness-repo-writer-receipt/v1",
    requestId,
    outcome: "error",
    error: { name: "Error", message: "private worker detail", code: "cleanup_failed" },
  });
  await turn();
  assert.equal(supervisor.status().queueDepth, 0);
  assert.deepEqual(warnings, [
    { event: "writer_detached_request_failed", repoId: input.repoId, opId: "queued-cleanup", code: "cleanup_failed" },
  ]);
  await supervisor.close();
});

for (const code of ["write_aborted_pre_commit", "unexpected_sql_failure"])
  test(`pre-commit cancellation distinguishes its rollback acknowledgement from ${code}`, async () => {
    const { supervisor, worker } = await open(),
      abort = new AbortController(),
      reason = Object.assign(new Error("caller cancelled"), { code: "caller_cancelled" }),
      result = assert.rejects(supervisor.request("run", {}, undefined, abort.signal), {
        code: code === "write_aborted_pre_commit" ? reason.code : code,
      });
    await worker.posted.promise;
    abort.abort(reason);
    worker.emit("message", {
      schema: "harness-repo-writer-receipt/v1",
      requestId: worker.writes[0]!.requestId,
      outcome: "error",
      error: { name: "Error", message: "database result", code },
    });
    await result;
    assert.equal(worker.terminated, 0);
    await supervisor.close();
  });

test("staged slot waiters are FIFO and each exclusive turn owns fresh absorbing phase state", async () => {
  const { supervisor, worker } = await open({}, input, true);
  const first = supervisor.request("run", {});
  await worker.posted.promise;
  const requestId = worker.writes[0]!.requestId;
  const acquired = await worker.capability("acquireWriteSlot", { requestId });
  const slot = acquired.value as { state: Int32Array; id: number };
  const next = worker.capability("acquireWriteSlot", {});
  let started = false;
  void next.then(() => {
    started = true;
  });
  await turn();
  assert.equal(started, false);
  assert.equal(Atomics.compareExchange(slot.state, 1, 0, 1), 0);
  await worker.capability("releaseWriteSlot", { slotId: slot.id });
  const backgroundSlot = (await next).value as { state: Int32Array; id: number };
  assert.notEqual(backgroundSlot.state.buffer, slot.state.buffer);
  assert.equal(backgroundSlot.state[1], 0);
  assert.equal(slot.state[1], 1);
  await worker.capability("releaseWriteSlot", { slotId: backgroundSlot.id });
  worker.receipt(requestId);
  await first;
  await supervisor.close();
});

test("staged pre-commit abort keeps its turn until rollback and never dispatches the queued RPC", async () => {
  const { supervisor, worker } = await open({}, input, true);
  const abort = new AbortController();
  const result = assert.rejects(supervisor.request("run", {}, undefined, abort.signal), { name: "AbortError" });
  await worker.posted.promise;
  const requestId = worker.writes[0]!.requestId;
  const slot = (await worker.capability("acquireWriteSlot", { requestId })).value as { state: Int32Array; id: number };
  const waiting = supervisor.request("run", {});
  abort.abort();
  assert.equal(Atomics.compareExchange(slot.state, 1, 0, 1), -1);
  assert.equal(worker.terminated, 0);
  await turn();
  assert.equal(worker.writes.length, 1);
  worker.posted = Promise.withResolvers<void>();
  await worker.capability("releaseWriteSlot", { slotId: slot.id });
  await worker.posted.promise;
  assert.equal(worker.writes.length, 2);
  worker.receipt(requestId);
  await result;
  worker.receipt(worker.writes[1]!.requestId);
  await waiting;
  await supervisor.close();
});

test("staged admission counts all dispatched preparation even without an exclusive write slot", async () => {
  const { supervisor, worker } = await open({}, input, true);
  const abort = new AbortController();
  const results = Array.from({ length: REPO_WRITER_QUEUE_LIMIT }, () =>
    assert.rejects(supervisor.request("run", {}, undefined, abort.signal), { name: "AbortError" }),
  );
  await turn();
  assert.equal(worker.writes.length, 64);
  await assert.rejects(supervisor.request("run", {}), { code: "write_overloaded", data: { retryable: true } });
  abort.abort();
  assert.equal(supervisor.status().queueDepth, 64);
  await assert.rejects(supervisor.request("run", {}), { code: "write_overloaded", data: { retryable: true } });
  for (const request of worker.writes) worker.receipt(request.requestId);
  await Promise.all(results);
  await turn();
  const next = supervisor.request("run", {}),
    admitted = assert.doesNotReject(next);
  await turn();
  assert.equal(worker.writes.length, 65, "raw receipt cleanup returns admission capacity");
  worker.receipt(worker.writes.at(-1)!.requestId);
  await admitted;
  await supervisor.close();
});

test("cancelling an out-of-slot operation preserves its cleanup failure receipt", async () => {
  const { supervisor, worker } = await open({}, input, true),
    abort = new AbortController(),
    result = assert.rejects(supervisor.request("fleetBackup", {}, undefined, abort.signal), {
      message: "archive worker cleanup failed",
      code: "archive_cleanup_failed",
    });
  await worker.posted.promise;
  const slot = (await worker.capability("acquireWriteSlot", { requestId: worker.writes[0]!.requestId })).value as {
    id: number;
  };
  await worker.capability("releaseWriteSlot", { slotId: slot.id });
  abort.abort();
  await turn();
  assert.equal(worker.cancels.length, 1);
  worker.emit("message", {
    schema: "harness-repo-writer-receipt/v1",
    requestId: worker.writes[0]!.requestId,
    outcome: "error",
    error: { name: "Error", message: "archive worker cleanup failed", code: "archive_cleanup_failed" },
  });
  await result;
  await supervisor.close();
});
