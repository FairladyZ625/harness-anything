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
  referenced = true;
  ref() {
    this.referenced = true;
  }
  unref() {
    this.referenced = false;
  }
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

test("close awaits handle release and reuses the unreferenced worker for the same repository", async () => {
  const workers: Reader[] = [],
    input = { repoId: "release" as never, rootDir: "/unused" as never, ownerId: "test" },
    factory = () => {
      const worker = new Reader();
      workers.push(worker);
      queueMicrotask(() => worker.ready());
      return worker as unknown as Worker;
    },
    first = openRepoReadClient(input, factory);
  try {
    await first.request("probe", []);
    const worker = workers[0]!;
    worker.hold = true;
    let closed = false;
    const closing = first.close().then(() => {
      closed = true;
    });
    await turn();
    assert.equal(closed, false, "close must wait for the worker's handle-release receipt");
    assert.equal(worker.stopped, false, "releasing handles must retain the warm isolate");
    assert.equal(worker.referenced, true, "pending release must keep the process alive");
    worker.release();
    await closing;
    assert.equal(worker.referenced, false, "an idle warm worker must not prevent process exit");
    await assert.rejects(first.request("probe", []), { code: "repo_unavailable" });
    const second = openRepoReadClient(input, factory);
    try {
      await second.request("probe", []);
      assert.equal(workers.length, 1, "reopening must reuse the existing isolate");
    } finally {
      await second.close();
    }
  } finally {
    workers.forEach((worker) => {
      worker.release();
      worker.emit("exit", 0);
    });
    await first.close();
  }
});

test("a release failure terminates the reader and rejects close with its own error", async () => {
  let worker!: Reader;
  const client = openRepoReadClient(
    { repoId: "release-error" as never, rootDir: "/unused" as never, ownerId: "test" },
    () => {
      worker = new Reader();
      queueMicrotask(() => worker.ready());
      return worker as unknown as Worker;
    },
  );
  await client.request("probe", []);
  worker.hold = true;
  const closing = client.close(),
    rejected = assert.rejects(closing, { code: "release_failed" });
  await turn();
  const release = worker.held[0]!;
  worker.emit("message", {
    requestId: release.requestId,
    outcome: "error",
    error: { code: "release_failed", message: "Native handle did not close." },
  });
  await rejected;
  assert.equal(worker.stopped, true, "a failed release cannot leave native handles in the reusable pool");
  assert.equal(client.close(), closing, "repeated close returns the same failure");
});

test("close drains an active read and reserves its worker until release is acknowledged", async () => {
  const workers: Reader[] = [],
    factory = () => {
      const worker = new Reader();
      workers.push(worker);
      queueMicrotask(() => worker.ready());
      return worker as unknown as Worker;
    },
    input = { repoId: "drain" as never, rootDir: "/unused" as never, ownerId: "test" },
    client = openRepoReadClient(input, factory);
  try {
    await client.request("probe", []);
    const worker = workers[0]!;
    worker.hold = true;
    const read = client.request("busy", []);
    await turn();
    const closing = client.close();
    assert.equal(client.close(), closing);
    await turn();
    assert.equal(worker.held.length, 1, "no release may overlap the active read");
    worker.reply(worker.held.shift()!);
    await read;
    await turn();
    assert.equal((worker.held[0]!.payload as { method: string }).method, "close");
    worker.release();
    await closing;
    assert.equal(worker.stopped, false);
  } finally {
    workers.forEach((worker) => {
      worker.release();
      worker.emit("exit", 0);
    });
    await client.close();
  }
});

test("the previous owner waits for an in-flight repository handoff before close resolves", async () => {
  let worker!: Reader;
  const factory = () => {
      worker = new Reader();
      queueMicrotask(() => worker.ready());
      return worker as unknown as Worker;
    },
    first = openRepoReadClient({ repoId: "before" as never, rootDir: "/unused" as never, ownerId: "test" }, factory),
    second = openRepoReadClient({ repoId: "after" as never, rootDir: "/unused" as never, ownerId: "test" }, factory);
  try {
    await first.request("probe", []);
    worker.hold = true;
    const next = second.request("probe", []);
    await turn();
    let closed = false;
    const closing = first.close().then(() => {
      closed = true;
    });
    await turn();
    assert.equal(closed, false, "ownership assignment alone does not prove old handles were released");
    worker.release();
    await Promise.all([next, closing]);
  } finally {
    worker.release();
    await Promise.all([first.close(), second.close()]);
    worker.emit("exit", 0);
  }
});

test("a failed repository handoff quarantines the reader until termination releases old handles", async () => {
  let worker!: Reader;
  const terminated = Promise.withResolvers<number>(),
    factory = () => {
      worker = new Reader();
      queueMicrotask(() => worker.ready());
      return worker as unknown as Worker;
    },
    first = openRepoReadClient({ repoId: "old-error" as never, rootDir: "/unused" as never, ownerId: "test" }, factory),
    second = openRepoReadClient(
      { repoId: "new-error" as never, rootDir: "/unused" as never, ownerId: "test" },
      factory,
    );
  try {
    await first.request("probe", []);
    worker.hold = true;
    worker.terminate = async () => {
      worker.stopped = true;
      return terminated.promise;
    };
    const next = second.request("probe", []),
      rejected = assert.rejects(next, { code: "handoff_failed" });
    await turn();
    let closed = false;
    const closing = first.close().then(() => {
      closed = true;
    });
    worker.emit("message", {
      requestId: worker.held[0]!.requestId,
      outcome: "error",
      error: { code: "handoff_failed", message: "Previous query runtime did not close." },
    });
    await rejected;
    await turn();
    assert.equal(worker.stopped, true, "an error receipt does not prove the old runtime released its handles");
    assert.equal(closed, false, "the previous owner must wait for worker termination");
    terminated.resolve(0);
    await closing;
  } finally {
    terminated.resolve(0);
    worker.release();
    await Promise.all([first.close(), second.close()]);
    worker.emit("exit", 0);
  }
});
