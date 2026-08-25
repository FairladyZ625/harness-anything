// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type RuntimeSession, type TaskProjection } from "../../kernel/src/index.ts";
import { appendRuntimeWorkerRecord, markRuntimeSessionLost, openDispatchStream, readDispatchLiveIndex } from "../src/dispatch-stream.ts";
import { readTaskDispatches } from "../src/dispatch-read.ts";

const dispatchId = "dispatch_a1b2c3d4e5f60718293a4b5c", runtimeSessionId = "runtime-1", taskId = "task-1";

function session(liveness: RuntimeSession["liveness"], outcome: RuntimeSession["outcome"]): RuntimeSession {
  return { runtimeSessionId, instanceId: "instance-1", installationId: "installation-1", kindId: "codex", definitionSnapshotRef: "artifact:runtime-definition/test", providerSessionId: null, transcriptRef: null, launchGeneration: 1, liveness, attachable: false, taskBindings: [], outcome, exitCode: null, resultRef: null, lastObservedAt: "2026-08-23T00:00:00.000Z" };
}

function projectionFor(current: RuntimeSession): TaskProjection {
  return { readTaskRuntimeBatch: () => ({ status: "ready", taskIds: [taskId], rows: [{ taskId, packagePath: "tasks/task-1", sessions: [current] }], watermark: 1, sourceRevision: 1 }), readRuntimeDispatch: () => ({ payload: { dispatchId } }), readReplicaBasis: () => { throw new Error("dispatch reads must not enumerate the replica document basis"); }, readDocument: () => ({ document: null }) } as unknown as TaskProjection;
}

function statusFor(current: RuntimeSession): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-read-"));
  try {
    openDispatchStream(rootDir, { dispatchId, taskId, executionId: "execution-1", runtimeSessionId, instanceId: "instance-1", startedAt: "2026-08-23T00:00:00.000Z" });
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

test("a daemon restart loss is a terminal lost dispatch", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-read-lost-"));
  try {
    openDispatchStream(rootDir, { dispatchId, taskId, executionId: "execution-1", runtimeSessionId, instanceId: "instance-1", startedAt: "2026-08-23T00:00:00.000Z" });
    markRuntimeSessionLost(rootDir, dispatchId, "provider pid disappeared");
    const result = readTaskDispatches({ rootDir, projection: projectionFor(session("exited", null)), taskId });
    assert.equal(result.dispatches[0]?.status, "lost");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("a dispatch whose session is live still reports running", () => {
  assert.equal(statusFor(session("live", null)), "running");
});

test("an observed outcome outranks liveness", () => {
  assert.equal(statusFor(session("exited", "succeeded")), "succeeded");
  assert.equal(statusFor(session("live", "cancelled")), "cancelled");
});

test("an unbound detached dispatch is read from the live index", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-read-unbound-"));
  try {
    openDispatchStream(rootDir, { dispatchId, taskId, executionId: "execution-1", runtimeSessionId, instanceId: "instance-1", startedAt: "2026-08-23T00:00:00.000Z" });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 12345 });
    const projection = { readTaskRuntimeBatch: () => ({ status: "ready", taskIds: [taskId], rows: [{ taskId, packagePath: "tasks/task-1", sessions: [] }], watermark: 1, sourceRevision: 1 }), readReplicaBasis: () => { throw new Error("dispatch reads must not enumerate the replica document basis"); }, readDocument: () => ({ document: null }) } as unknown as TaskProjection;
    const result = readTaskDispatches({ rootDir, projection, taskId });
    assert.equal(result.dispatches.find((row) => row.dispatchId === dispatchId)?.status, "running");
    assert.equal(readDispatchLiveIndex(rootDir, [taskId]).entries.length, 1, "unbound dispatch must remain indexed");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("a projected task binding removes the live index entry", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-read-bound-"));
  try {
    openDispatchStream(rootDir, { dispatchId, taskId, executionId: "execution-1", runtimeSessionId, instanceId: "instance-1", startedAt: "2026-08-23T00:00:00.000Z" });
    const result = readTaskDispatches({ rootDir, projection: projectionFor(session("live", null)), taskId });
    assert.equal(result.dispatches.find((row) => row.dispatchId === dispatchId)?.status, "running");
    assert.deepEqual(readDispatchLiveIndex(rootDir, [taskId]).entries, []);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("archived dispatch rows expose terminal result and task artifact references", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-read-archive-"));
  try {
    const archived = {
      schema: "runtime-dispatch/v1",
      dispatchId,
      taskId,
      executionId: "execution-1",
      runtimeSessionId,
      instanceId: "instance-1",
      providerSessionId: "provider-1",
      startedAt: "2026-08-23T00:00:00.000Z",
      endedAt: "2026-08-23T00:01:00.000Z",
      outcome: "succeeded",
      exitCode: 0,
      resultRef: "artifact:runtime-result/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const projection = {
      readTaskRuntimeBatch: () => ({
        status: "ready",
        taskIds: [taskId],
        rows: [{ taskId, packagePath: "tasks/task-1", sessions: [session("exited", "succeeded")] }],
        watermark: 1,
        sourceRevision: 1,
      }),
      readRuntimeDispatch: () => ({ payload: { dispatchId } }),
      readDocument: () => ({ document: { body: JSON.stringify(archived) } }),
      readReplicaBasis: () => { throw new Error("dispatch reads must not enumerate the replica document basis"); },
    } as unknown as TaskProjection;
    const result = readTaskDispatches({ rootDir, projection, taskId });
    assert.deepEqual(result.dispatches[0], {
      dispatchId,
      taskId,
      executionId: "execution-1",
      runtimeSessionId,
      instanceId: "instance-1",
      providerSessionId: "provider-1",
      eventStreamRef: null,
      startedAt: archived.startedAt,
      endedAt: archived.endedAt,
      outcome: "succeeded",
      status: "succeeded",
      resultRef: archived.resultRef,
      exitCode: 0,
      dispatchPath: "tasks/task-1/artifacts/dispatches/dispatch_a1b2c3d4e5f60718293a4b5c.json",
      reportPath: "tasks/task-1/artifacts/reports/dispatch_a1b2c3d4e5f60718293a4b5c.md",
    });
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
