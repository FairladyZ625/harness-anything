// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendRuntimeWorkerRecord,
  dispatchStreamPath,
  openDispatchStream,
  readDispatchStreamSummary,
} from "../src/dispatch-stream.ts";

test("dispatch summaries keep a lifecycle record that straddles the head window edge", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-summary-straddle-"));
  try {
    const dispatchId = "dispatch_555555555555555555555555",
      stream = openDispatchStream(rootDir, {
        dispatchId,
        taskId: "task-5",
        executionId: "execution-5",
        runtimeSessionId: "runtime_555555555555555555555555",
        instanceId: "instance-1",
        startedAt: "2026-09-14T00:00:00.000Z",
        prompt: "p",
      }),
      target = dispatchStreamPath(rootDir, dispatchId),
      headWindowBytes = 16 * 1024,
      beforeFiller = statSync(target).size;
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", event: { text: "" } });
    const fillerOverhead = statSync(target).size - beforeFiller;
    truncateSync(target, beforeFiller);
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      event: { text: "f".repeat(headWindowBytes - 20 - beforeFiller - fillerOverhead) },
    });
    const bindingOffset = statSync(target).size;
    stream.appendProviderBinding("provider-session-straddle", "2026-09-14T00:00:01.000Z");
    assert.ok(bindingOffset < headWindowBytes && statSync(target).size > headWindowBytes);
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      event: { text: "x".repeat(512 * 1024) },
    });
    assert.equal(readDispatchStreamSummary(rootDir, dispatchId)?.providerSessionId, "provider-session-straddle");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
