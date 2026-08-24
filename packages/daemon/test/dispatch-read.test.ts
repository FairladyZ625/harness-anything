// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHarnessLayout, type RuntimeSession, type TaskProjection } from "../../kernel/src/index.ts";
import { readTaskDispatches } from "../src/dispatch-read.ts";

const dispatchId = "dispatch_a1b2c3d4e5f60718293a4b5c", runtimeSessionId = "runtime-1", taskId = "task-1";

function session(liveness: RuntimeSession["liveness"], outcome: RuntimeSession["outcome"]): RuntimeSession {
  return { runtimeSessionId, instanceId: "instance-1", installationId: "installation-1", kindId: "codex", definitionSnapshotRef: "artifact:runtime-definition/test", providerSessionId: null, transcriptRef: null, launchGeneration: 1, liveness, attachable: false, taskBindings: [], outcome, exitCode: null, resultRef: null, lastObservedAt: "2026-08-23T00:00:00.000Z" };
}

function projectionFor(current: RuntimeSession): TaskProjection {
  return { readTaskRuntimeBatch: () => ({ status: "ready", taskIds: [taskId], rows: [{ taskId, packagePath: "tasks/task-1", sessions: [current] }], watermark: 1, sourceRevision: 1 }), readReplicaBasis: () => ({ documents: [] }), readDocument: () => ({ document: null }) } as unknown as TaskProjection;
}

function statusFor(current: RuntimeSession): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-read-"));
  try {
    const streamRoot = path.join(resolveHarnessLayout(rootDir).localRoot, "runtime", "dispatches");
    mkdirSync(streamRoot, { recursive: true });
    writeFileSync(path.join(streamRoot, `${dispatchId}.jsonl`), `${JSON.stringify({ schema: "runtime-dispatch-stream/v1", kind: "dispatch", dispatchId, taskId, executionId: "execution-1", runtimeSessionId, instanceId: "instance-1", startedAt: "2026-08-23T00:00:00.000Z", eventStreamRef: `artifact:dispatch-stream/${dispatchId}` })}\n`, "utf8");
    const result = readTaskDispatches({ rootDir, projection: projectionFor(current), taskId });
    const row = result.dispatches.find((candidate) => candidate.dispatchId === dispatchId);
    assert.ok(row, "dispatch row missing");
    return row.status;
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
}

// A dispatch stream with no archived record reports status from the session field that is
// actually maintained. `outcome` stays null for every session that nobody waited on, so
// defaulting it to "running" reported exited sessions as live forever.
test("a dispatch whose session has exited reports unknown, not running", () => {
  assert.equal(statusFor(session("exited", null)), "unknown");
  assert.equal(statusFor(session("unknown", null)), "unknown");
  assert.equal(statusFor(session("stale", null)), "unknown");
});

test("a dispatch whose session is live still reports running", () => {
  assert.equal(statusFor(session("live", null)), "running");
});

test("an observed outcome outranks liveness", () => {
  assert.equal(statusFor(session("exited", "succeeded")), "succeeded");
  assert.equal(statusFor(session("live", "cancelled")), "cancelled");
});
