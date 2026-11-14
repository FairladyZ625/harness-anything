// harness-test-tier: contract
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";
import { REPO_WRITER_QUEUE_LIMIT } from "../src/writer-request-queue.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoWriterRequestV1, RepoWriterControlV1, RepoWriterCancelV1 } from "../src/repo-writer-protocol.ts";

const input = { repoId: workspaceId("syncrep-admission"), rootDir: canonicalRoot(process.cwd()), ownerId: "test" };
class HeldWriter extends EventEmitter {
  writes: RepoWriterRequestV1[] = [];
  cancels: string[] = [];
  terminated = 0;
  posted = Promise.withResolvers<void>();
  postMessage(message: RepoWriterRequestV1 | RepoWriterControlV1 | RepoWriterCancelV1) {
    if (message.schema === "harness-repo-writer-control/v1") this.receipt(message.requestId, null);
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
async function open(options: Parameters<typeof openWriterSupervisor>[1] = {}) {
  const worker = new HeldWriter();
  const opening = openWriterSupervisor(input, { ...options, createWorker: () => worker as unknown as Worker });
  worker.emit("message", {
    schema: "harness-repo-writer-status/v1",
    kind: "ready",
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
  const aborts = Array.from({ length: REPO_WRITER_QUEUE_LIMIT }, () => new AbortController());
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
  assert.equal(supervisor.status().queueDepth, 65);
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
  const first = assert.rejects(supervisor.request("run", { opId: "stuck-rollback" }), { code: "daemon_closing" });
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
