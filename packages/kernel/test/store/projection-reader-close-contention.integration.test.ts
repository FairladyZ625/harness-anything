// harness-test-tier: integration
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { withTempStoreAsync } from "./helpers.ts";

interface WorkerResult {
  readonly ok: boolean;
  readonly role: "reader" | "writer";
  readonly samples?: number;
  readonly error?: {
    readonly code: string | null;
    readonly errcode: number | null;
    readonly errstr: string | null;
    readonly message: string;
  };
}

test("a persistent writer owner keeps query-only readers on the completed cut after a large commit", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const eventStore = {
        readHead: () => null,
        readBatch: () => ({
          sourceRevision: 0,
          events: [],
          cursor: null,
          done: true,
          accessedItems: 0,
          prefetchContent: () => new Map(),
        }),
        readContentBlob: () => null,
      },
      projection = makeTaskProjection({ rootDir, eventStore }),
      start = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      stop = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      common = {
        rootDir,
        projectionPath: projection.path,
        start,
        stop,
        rows: 1024,
        payloadBytes: 1024 * 1024,
      };
    projection.catchUp();
    projection.close();

    const readers = Array.from({ length: 3 }, () => startWorker({ ...common, role: "reader" })),
      writer = startWorker({ ...common, role: "writer" });
    await Promise.all([...readers.map(({ ready }) => ready), writer.ready]);
    await writer.closing;
    Atomics.store(new Int32Array(start), 0, 1);
    Atomics.notify(new Int32Array(start), 0);
    await Promise.all([writer.written, ...readers.map(({ firstSettled }) => firstSettled)]);
    Atomics.store(new Int32Array(stop), 0, 1);
    Atomics.notify(new Int32Array(stop), 0);
    const [writerResult, ...readerResults] = await Promise.all([writer.result, ...readers.map(({ result }) => result)]);
    assert.equal(writerResult.ok, true, JSON.stringify(writerResult));
    assert.ok(
      readerResults.every(({ samples }) => (samples ?? 0) > 0),
      JSON.stringify(readerResults),
    );
    assert.deepEqual(
      readerResults.filter(({ ok }) => !ok),
      [],
      `query-only reader failures: ${JSON.stringify(readerResults)}`,
    );
  });
});

function startWorker(input: object): {
  readonly ready: Promise<void>;
  readonly closing: Promise<void>;
  readonly written: Promise<void>;
  readonly firstSettled: Promise<void>;
  readonly result: Promise<WorkerResult>;
} {
  const worker = new Worker(new URL("./projection-reader-close-contention.fixture.ts", import.meta.url), {
    execArgv: process.execArgv.filter(
      (argument) => argument === "--experimental-strip-types" || argument === "--enable-source-maps",
    ),
    workerData: input,
  });
  let signalReady!: () => void,
    signalClosing!: () => void,
    signalWritten!: () => void,
    signalFirstSettled!: () => void,
    accept!: (result: WorkerResult) => void,
    reject!: (error: Error) => void;
  const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    }),
    result = new Promise<WorkerResult>((resolve, rejectResult) => {
      accept = resolve;
      reject = rejectResult;
    }),
    closing = new Promise<void>((resolve) => {
      signalClosing = resolve;
    }),
    written = new Promise<void>((resolve) => {
      signalWritten = resolve;
    }),
    firstSettled = new Promise<void>((resolve) => {
      signalFirstSettled = resolve;
    });
  worker.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    if (record.ready === true) signalReady();
    if (record.closing === true) signalClosing();
    if (record.written === true) signalWritten();
    if (record.sampled === true) signalFirstSettled();
    if (typeof record.ok === "boolean") {
      signalReady();
      signalClosing();
      signalWritten();
      signalFirstSettled();
      accept(record as unknown as WorkerResult);
    }
  });
  const fail = (error: Error) => {
    signalReady();
    signalClosing();
    signalWritten();
    signalFirstSettled();
    reject(error);
  };
  worker.once("error", fail);
  worker.once("exit", (code) => {
    if (code !== 0) fail(new Error(`projection contention worker exited ${code}`));
  });
  return { ready, closing, written, firstSettled, result };
}
