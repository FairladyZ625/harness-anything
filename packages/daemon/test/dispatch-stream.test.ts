// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendRuntimeWorkerRecord,
  dispatchLiveIndexPath,
  openDispatchStream,
  readDispatchLiveIndex,
  readRuntimeSessionIndex,
} from "../src/dispatch-stream.ts";

test("the live index rebuilds exactly from dispatch stream headers", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-live-index-"));
  try {
    for (const suffix of ["111111111111111111111111", "222222222222222222222222"] as const) {
      const dispatchId = `dispatch_${suffix}`;
      openDispatchStream(rootDir, { dispatchId, taskId: "task-1", executionId: "execution-1", runtimeSessionId: `runtime_${suffix}`, instanceId: "instance-1", startedAt: "2026-08-24T00:00:00.000Z" });
      appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", event: { text: "tail records are not needed to rebuild the header index" } });
    }
    const before = readDispatchLiveIndex(rootDir, ["task-1"]);
    rmSync(dispatchLiveIndexPath(rootDir, "task-1"));
    const rebuilt = readDispatchLiveIndex(rootDir, ["task-1"]);
    assert.deepEqual(rebuilt, before);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("the runtime session index records process exit and preserves a lost terminal reason", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-session-index-"));
  try {
    const dispatchId = "dispatch_333333333333333333333333";
    openDispatchStream(rootDir, { dispatchId, taskId: "task-2", executionId: "execution-2", runtimeSessionId: "runtime_333333333333333333333333", instanceId: "instance-1", startedAt: "2026-08-24T00:00:00.000Z" });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 4321 });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: null, signal: "SIGKILL", occurredAt: "2026-08-24T00:01:00.000Z" });
    const row = readRuntimeSessionIndex(rootDir)[0];
    assert.equal(row?.state, "exited");
    assert.equal(row?.pid, 4321);
    assert.equal(row?.signal, "SIGKILL");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
