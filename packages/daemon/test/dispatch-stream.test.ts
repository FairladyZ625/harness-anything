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
