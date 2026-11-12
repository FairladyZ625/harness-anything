// harness-test-tier: contract
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import { openWriterSupervisor, WRITER_IDLE_TIMEOUT_MS, WRITER_READY_WATCHDOG_MS } from "../src/writer-supervisor.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoWriterControlV1, RepoWriterRequestV1 } from "../src/repo-writer-protocol.ts";

const input = { repoId: workspaceId("idle-writer"), rootDir: canonicalRoot(process.cwd()), ownerId: "idle-test" };
const turn = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
class Writer extends EventEmitter {
  controls: RepoWriterControlV1[] = [];
  writes: RepoWriterRequestV1[] = [];
  terminated = 0;
  readonly exit = Promise.withResolvers<number>();
  holdTermination = false;
  holdWrites = false;
  hibernate: boolean | "hold" = true;
  postMessage(message: RepoWriterControlV1 | RepoWriterRequestV1) {
    if (message.schema === "harness-repo-writer-control/v1") {
      this.controls.push(message);
      if (message.command === "hibernate" && this.hibernate === "hold") return;
      this.receipt(message.requestId, message.command === "hibernate" ? this.hibernate : null);
    } else {
      this.writes.push(message);
      if (!this.holdWrites) this.receipt(message.requestId, message.payload);
    }
  }
  receipt(requestId: string, value: unknown) {
    this.emit("message", { schema: "harness-repo-writer-receipt/v1", requestId, outcome: "ok", value });
  }
  ready(generation: number) {
    this.emit("message", {
      schema: "harness-repo-writer-status/v1",
      kind: "ready",
      status: { ...input, state: "attached", generation, queueDepth: 0 },
    });
  }
  terminate() {
    this.terminated++;
    if (!this.holdTermination) this.finish();
    return this.exit.promise;
  }
  finish() {
    this.emit("exit", 0);
    this.exit.resolve(0);
  }
}
async function open(first: Writer, more: Writer[] = []) {
  const created: Writer[] = [],
    available = [first, ...more];
  const opening = openWriterSupervisor(input, {
    createWorker: () => {
      const writer = available.shift()!;
      assert.ok(writer, "unexpected overlapping/redundant writer");
      created.push(writer);
      if (created.length > 1) queueMicrotask(() => writer.ready(created.length));
      return writer as unknown as Worker;
    },
  });
  first.ready(1);
  return { supervisor: await opening, created };
}

test("idle retirement fences twenty concurrent writes until the old isolate exits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = new Writer(),
    next = new Writer();
  old.holdTermination = true;
  const { supervisor, created } = await open(old, [next]);
  t.mock.timers.tick(WRITER_IDLE_TIMEOUT_MS);
  await turn();
  assert.equal(old.terminated, 1);
  const writes = Array.from({ length: 20 }, (_, index) => supervisor.request("run", index));
  await turn();
  assert.equal(created.length, 1, "the closing writer still owns the slot");
  old.finish();
  assert.deepEqual(
    await Promise.all(writes),
    Array.from({ length: 20 }, (_, index) => index),
  );
  assert.equal(created.length, 2);
  assert.equal(next.writes.length, 20, "zero lost or duplicated requests");
  assert.equal(new Set(next.writes.map((request) => request.requestId)).size, 20);
  assert.equal(old.writes.length, 0);
  assert.equal(supervisor.status().generation, 2);
  // Late messages from the retired generation cannot overwrite status or reject the new queue.
  old.ready(0);
  old.emit("error", new Error("late old error"));
  assert.equal(supervisor.status().generation, 2);
  await supervisor.close();
});

test("admission before the timeout cancels retirement even before posting the write", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new Writer();
  writer.holdWrites = true;
  const { supervisor } = await open(writer);
  const write = supervisor.request("run", "one");
  t.mock.timers.tick(WRITER_IDLE_TIMEOUT_MS * 2);
  await turn();
  assert.equal(writer.controls.length, 0);
  writer.receipt(writer.writes[0]!.requestId, "one");
  assert.equal(await write, "one");
  t.mock.timers.tick(WRITER_IDLE_TIMEOUT_MS);
  await turn();
  assert.equal(writer.terminated, 1);
  assert.equal(supervisor.status().state, "attached", "idle readers retain the completed cut");
  await supervisor.close();
});

test("a busy background owner vetoes hibernation and remains usable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new Writer();
  writer.hibernate = false;
  const { supervisor } = await open(writer);
  t.mock.timers.tick(WRITER_IDLE_TIMEOUT_MS);
  await turn();
  assert.equal(writer.terminated, 0);
  assert.equal(await supervisor.request("run", "live"), "live");
  writer.hibernate = true;
  t.mock.timers.tick(WRITER_IDLE_TIMEOUT_MS);
  await turn();
  assert.equal(writer.terminated, 1);
  await supervisor.close();
});

test("close during idle drain rejects waiting writes without starting a successor", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new Writer();
  writer.hibernate = "hold";
  const { supervisor, created } = await open(writer);
  t.mock.timers.tick(WRITER_IDLE_TIMEOUT_MS);
  const write = assert.rejects(supervisor.request("run", "late"), /closed/u);
  const closing = supervisor.close();
  writer.receipt(writer.controls[0]!.requestId, true);
  await Promise.all([write, closing]);
  assert.equal(created.length, 1);
});

test("a missing idle drain acknowledgement fails closed with a bounded control error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new Writer();
  writer.hibernate = "hold";
  const { supervisor, created } = await open(writer);
  t.mock.timers.tick(WRITER_IDLE_TIMEOUT_MS);
  const request = assert.rejects(supervisor.request("run", "blocked"), { code: "writer_control_timeout" });
  t.mock.timers.tick(WRITER_READY_WATCHDOG_MS);
  await request;
  assert.equal(created.length, 1);
  assert.equal(writer.writes.length, 0);
  assert.equal(supervisor.status().state, "unavailable");
  await assert.rejects(supervisor.close(), { code: "writer_control_timeout" });
  assert.equal(writer.terminated, 1);
});
