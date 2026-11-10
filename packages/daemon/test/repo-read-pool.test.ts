// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import { openRepoReadClient } from "../src/repo-read-pool.ts";
import { REPO_WRITER_PROTOCOL_VERSION, type RepoWriterRequestV1 } from "../src/repo-writer-protocol.ts";

class Reader extends EventEmitter {
  readonly received: RepoWriterRequestV1[] = [];
  readonly held: RepoWriterRequestV1[] = [];
  hold = false;
  stopped = false;
  ready() {
    this.emit("message", {
      schema: "harness-repo-writer-status/v1",
      protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
      kind: "attach-progress",
    });
  }
  postMessage(request: RepoWriterRequestV1) {
    this.received.push(request);
    if (this.hold) this.held.push(request);
    else this.reply(request);
  }
  reply(request: RepoWriterRequestV1) {
    queueMicrotask(() => this.emit("message", { requestId: request.requestId, outcome: "ok", value: request.payload }));
  }
  release() {
    this.hold = false;
    this.held.splice(0).forEach((request) => this.reply(request));
  }
  async terminate() {
    this.stopped = true;
    return 0;
  }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a free ready reader serves queued work while another reader is still starting", async () => {
  const workers: Reader[] = [],
    client = openRepoReadClient({ repoId: "readiness" as never, rootDir: "/unused" as never, ownerId: "test" }, () => {
      const worker = new Reader();
      worker.hold = workers.length > 0;
      workers.push(worker);
      return worker as unknown as Worker;
    }),
    pending: Promise<unknown>[] = [];
  try {
    const initial = client.request("initial", []);
    pending.push(initial);
    await turn();
    workers[0]!.ready();
    await initial;

    workers[0]!.hold = true;
    const busy = client.request("busy", []);
    pending.push(busy);
    await turn();
    const queued = client.request("queued", []);
    pending.push(queued);
    await turn();
    assert.equal(workers.length, 2);
    workers[1]!.hold = true; // Its module initialization has not reached the readiness event.
    workers[0]!.release();
    await busy;
    await turn();

    assert.equal(workers[1]!.received.length, 0, "an unready worker must not own a request");
    assert.equal(workers[0]!.received.length, 3, "the ready worker must take the queued request immediately");
    await queued;
  } finally {
    workers.forEach((worker) => {
      worker.release();
      worker.ready();
    });
    await Promise.allSettled(pending);
    await client.close();
  }
});

test("closing a client before worker creation prevents a detached reader from starting", async () => {
  let created = 0;
  const client = openRepoReadClient(
    { repoId: "close-before-start" as never, rootDir: "/unused" as never, ownerId: "test" },
    () => {
      created++;
      return new Reader() as unknown as Worker;
    },
  );
  const pending = client.request("read", []);
  const closing = client.close();
  const rejected = assert.rejects(pending, { code: "repo_unavailable" });
  await Promise.all([closing, rejected]);
  await turn();
  assert.equal(created, 0);
});
