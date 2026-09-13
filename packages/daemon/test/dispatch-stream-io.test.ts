// harness-test-tier: fast
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  dispatchStreamPath,
  openDispatchStream,
  openDispatchStreamAppender,
  readDispatchStream,
  readDispatchStreamIncrement,
} from "../src/dispatch-stream.ts";

test("incremental stream reads return only the bytes past the caller-held offset", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-increment-"));
  try {
    const target = dispatchStreamPath(rootDir, "dispatch_c1d2e3f4a5b60718293a4b5c");
    mkdirSync(path.dirname(target), { recursive: true });
    appendFileSync(target, "line-one\n");
    const first = readDispatchStreamIncrement(target, 0);
    assert.ok(first);
    assert.equal(first.bytes.toString(), "line-one\n");
    assert.equal(first.size, "line-one\n".length);
    const caughtUp = readDispatchStreamIncrement(target, first.bytes.length);
    assert.ok(caughtUp);
    assert.equal(caughtUp.bytes.length, 0);
    appendFileSync(target, "line-two\n");
    const next = readDispatchStreamIncrement(target, first.bytes.length);
    assert.ok(next);
    assert.equal(next.bytes.toString(), "line-two\n");
    assert.equal(readDispatchStreamIncrement(path.join(rootDir, "missing.jsonl"), 0), null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a held-descriptor appender lands schema-tagged records and reopens after close", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-appender-"));
  try {
    const dispatchId = "dispatch_d1e2f3a4b5c60718293a4b5c",
      target = dispatchStreamPath(rootDir, dispatchId);
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId: "runtime-appender",
      instanceId: "instance-1",
      startedAt: "2026-09-12T00:00:00.000Z",
    });
    const appender = openDispatchStreamAppender(target);
    appender.append({ kind: "provider_event", event: { seq: 1 } });
    appender.append({ kind: "provider_event", event: { seq: 2 } });
    appender.close();
    appender.append({ kind: "process_exit", exitCode: 0, signal: null });
    appender.close();
    const stream = readDispatchStream(rootDir, dispatchId);
    assert.deepEqual(
      stream?.records.map((record) => record.kind),
      ["provider_event", "provider_event", "process_exit"],
    );
    assert.deepEqual(
      stream?.records.map((record) => record.schema),
      ["runtime-dispatch-stream/v1", "runtime-dispatch-stream/v1", "runtime-dispatch-stream/v1"],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
