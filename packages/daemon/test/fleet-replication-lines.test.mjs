// harness-test-tier: fast
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { replicationSocketLines } from "./fixtures/fleet-replication-lines.mjs";

// A turn boundary detects a reader parked after terminal close without waiting on a wall clock.
async function terminalRead(nextLine) {
  return Promise.race([
    nextLine().then(
      () => "unexpected line",
      (error) => error,
    ),
    new Promise((resolve) => setImmediate(() => resolve("parked after close"))),
  ]);
}

async function close(socket) {
  const closed = once(socket, "close");
  socket.destroy();
  await closed;
}

test("replication reader rejects a read started after socket close", async () => {
  const socket = new PassThrough(),
    nextLine = replicationSocketLines(socket);
  await close(socket);
  const result = await terminalRead(nextLine);
  assert.ok(result instanceof Error, String(result));
  assert.match(result.message, /closed/u);
});

test("replication reader drains complete buffered lines after close then rejects", async () => {
  const socket = new PassThrough(),
    nextLine = replicationSocketLines(socket);
  const first = nextLine();
  socket.write("commit\nobject\npayload\npartial");
  assert.equal(await first, "commit");
  // Simulate close arriving while runWalReceiver awaits its asynchronous filesystem work.
  await close(socket);
  assert.equal(await nextLine(), "object");
  assert.equal(await nextLine(), "payload");
  const result = await terminalRead(nextLine);
  assert.ok(result instanceof Error, String(result));
  assert.match(result.message, /closed/u);
});

test("replication reader rejects a pending read when the socket closes", async () => {
  const socket = new PassThrough(),
    nextLine = replicationSocketLines(socket);
  const pending = assert.rejects(nextLine(), /closed/u);
  await close(socket);
  await pending;
});

test("replication reader preserves split and coalesced lines while open", async () => {
  const socket = new PassThrough(),
    nextLine = replicationSocketLines(socket);
  const first = nextLine();
  socket.write("fir");
  socket.write("st\nsecond\nthi");
  assert.equal(await first, "first");
  assert.equal(await nextLine(), "second");
  const third = nextLine();
  socket.write("rd\n");
  assert.equal(await third, "third");
  await close(socket);
});
