// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDaemonTraceCompletions,
  readDaemonTraceCompletions,
  type DaemonTraceCompletion,
} from "../src/daemon-trace-completions.ts";

const sample = (method: string, nodeId: string | null = null): DaemonTraceCompletion => ({
  method,
  nodeId,
  endedAtMs: 120,
  durationMs: 30,
  ok: false,
});

test("completion overflow is counted without overwriting unread requests, then capacity is reusable", () => {
  const writer = createDaemonTraceCompletions(2),
    reader = readDaemonTraceCompletions(writer.buffer),
    rows: DaemonTraceCompletion[] = [];
  writer.record(sample("one", "节点"));
  writer.record(sample("two", ""));
  writer.record(sample("dropped"));
  reader.drain((row) => rows.push(row));
  assert.deepEqual(rows, [sample("one", "节点"), sample("two", "")]);
  assert.equal(reader.dropped, 1);
  rows.length = 0;
  writer.record(sample("reused"));
  reader.drain((row) => rows.push(row));
  assert.deepEqual(rows, [sample("reused")]);
  assert.equal(reader.dropped, 1);
});

test("completion drain stops at the published prefix when the producer appends during consumption", () => {
  const writer = createDaemonTraceCompletions(2),
    reader = readDaemonTraceCompletions(writer.buffer),
    rows: DaemonTraceCompletion[] = [];
  writer.record(sample("first"));
  reader.drain((row) => {
    rows.push(row);
    writer.record(sample("next"));
  });
  assert.deepEqual(rows, [sample("first")]);
  rows.length = 0;
  reader.drain((row) => rows.push(row));
  assert.deepEqual(rows, [sample("next")]);
});

test("completion sequence wrap preserves order and bounded text on a reused slot", () => {
  const writer = createDaemonTraceCompletions(2),
    reader = readDaemonTraceCompletions(writer.buffer),
    rows: DaemonTraceCompletion[] = [];
  const header = new Int32Array(writer.buffer);
  Atomics.store(header, 0, -2);
  Atomics.store(header, 1, -2);
  writer.record(sample("a".repeat(300), "n".repeat(300)));
  writer.record(sample("after-wrap"));
  reader.drain((row) => rows.push(row));
  assert.deepEqual(rows, [sample("a".repeat(256), "n".repeat(256)), sample("after-wrap")]);
  assert.equal(reader.dropped, 0);
});
