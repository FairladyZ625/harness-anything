// harness-test-tier: fast
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import type { AgentRuntimeEventV1, RuntimeSession, TaskProjection } from "@harness-anything/kernel";
import {
  readRuntimeAttemptChain,
  readSessionGroupDispatches,
  readTaskDispatches,
  readTaskDispatchSession,
  taskDispatchRowsSettled,
} from "../src/dispatch-read.ts";

const dispatchId = "dispatch_a1b2c3d4e5f60718293a4b5c",
  runtimeSessionId = "runtime-1",
  taskId = "task-1";
type Dispatch = Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>;
function session(
  liveness: RuntimeSession["liveness"],
  outcome: RuntimeSession["outcome"],
  evidence: Partial<RuntimeSession> = {},
): RuntimeSession {
  return {
    runtimeSessionId,
    instanceId: "instance-1",
    installationId: "installation-1",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definition/test",
    providerSessionId: "provider-session",
    transcriptRef: null,
    launchGeneration: 1,
    liveness,
    attachable: false,
    taskBindings: [],
    outcome,
    exitCode: null,
    resultRef: null,
    lastObservedAt: "2026-08-23T00:00:00.000Z",
    ...evidence,
  };
}
function fixture(
  current = session("live", null),
  options: { archive?: Record<string, unknown>; successor?: Dispatch; metrics?: Record<string, unknown> } = {},
) {
  const event = {
    schema: "agent-runtime-event/v1",
    type: "runtime_dispatch_requested",
    occurredAt: "2026-08-23T00:00:00.000Z",
    payload: {
      dispatchId,
      runtimeSessionId,
      taskId,
      executionId: "execution-1",
      instanceId: "instance-1",
      agentId: "terra",
      definitionSnapshotRef: current.definitionSnapshotRef,
      attemptGroupId: dispatchId,
      attemptIndex: 0,
      reviewTarget: { kind: "decision", decisionId: "decision-1", digest: "a".repeat(64) },
    },
  } as unknown as Dispatch;
  const events = options.successor ? [event, options.successor] : [event];
  const projection = {
    read: () => ({ watermark: 1, sourceRevision: 1, packagePath: "tasks/task-1", snapshot: { task: { taskId } } }),
    readTaskRuntimeBatch: () => ({
      status: "ready",
      taskIds: [taskId],
      rows: [{ taskId, packagePath: "tasks/task-1", sessions: [current] }],
      watermark: 1,
      sourceRevision: 1,
    }),
    readRuntimeSession: () => current,
    readRuntimeDispatch: () => event,
    readRuntimeDispatches: () => events,
    readRuntimeDispatchById: (id: string) => {
      const event = events.find((e) => e.payload.dispatchId === id);
      return event ? { event } : null;
    },
    readRuntimeDispatchByResumeSource: () => (options.successor ? { event: options.successor } : null),
    readRuntimeDispatchesBySession: () => [{ event }],
    readRuntimeDispatchesByAttemptGroup: () => events.map((event) => ({ event })),
    readRuntimeSessionEvents: () =>
      options.metrics
        ? [
            {
              schema: "agent-runtime-event/v1",
              type: "runtime_session_outcome_observed",
              payload: { runtimeMetrics: options.metrics },
            },
          ]
        : [],
    readDocument: (path: string) => ({
      document:
        options.archive && path.endsWith(".json")
          ? { body: JSON.stringify({ schema: "runtime-dispatch/v1", ...options.archive }) }
          : null,
    }),
  } as unknown as TaskProjection;
  return { projection, event, rows: () => readTaskDispatches({ projection, taskId }).dispatches };
}

test("accepted liveness and terminal evidence determine public dispatch status without a local stream", () => {
  for (const [liveness, outcome, expected] of [
    ["live", null, "running"],
    ["exited", null, "unknown"],
    ["unknown", null, "unknown"],
    ["stale", null, "unknown"],
    ["live", "failed", "failed"],
    ["exited", "cancelled", "cancelled"],
    ["exited", "unknown", "unknown"],
  ] as const) {
    const row = fixture(session(liveness, outcome)).rows()[0]!;
    assert.equal(row.status, expected);
    assert.equal(row.eventStreamRef, null);
    assert.equal(taskDispatchRowsSettled([row]), outcome !== null);
  }
});

test("public dispatch, session group and attempt chain queries tolerate a filesystem trap", (t) => {
  const f = fixture(session("live", null));
  for (const method of ["readFileSync", "openSync", "readdirSync", "statSync", "existsSync", "unlinkSync"] as const)
    t.mock.method(fs, method, () => {
      throw new Error(`public reader touched ${method}`);
    });
  syncBuiltinESMExports();
  try {
    assert.equal(f.rows().length, 1);
    assert.equal(
      readSessionGroupDispatches({ projection: f.projection, sessions: [session("live", null)], events: [f.event] })
        .length,
      1,
    );
    assert.equal(readRuntimeAttemptChain(runtimeSessionId, f.projection)?.attempts.length, 1);
    assert.deepEqual(readTaskDispatchSession(f.projection, taskId, dispatchId), { runtimeSessionId });
    assert.equal(readTaskDispatchSession(f.projection, "other-task", dispatchId), null);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("resume is derived from canonical provider identity and withdrawn by an accepted successor", () => {
  const f = fixture(session("exited", "failed"));
  assert.deepEqual(f.rows()[0]?.resume, { dispatchId, agentId: "terra" });
  const successor = {
    ...f.event,
    payload: {
      ...f.event.payload,
      dispatchId: "dispatch_fedcba987654321001234567",
      runtimeSessionId: "runtime-2",
      attemptIndex: 1,
    },
  };
  const resumed = fixture(session("exited", "failed"), { successor });
  assert.equal(resumed.rows()[0]?.resume, undefined);
  assert.equal(resumed.rows()[0]?.nextDispatchId, successor.payload.dispatchId);
  assert.equal(resumed.rows()[0]?.fallbackState, "dispatched");
  assert.equal(readRuntimeAttemptChain(runtimeSessionId, resumed.projection)?.attempts.length, 2);
});

test("only accepted outcome metrics appear and unknown live telemetry stays absent", () => {
  assert.equal(fixture().rows()[0]?.metrics, undefined);
  const metrics = {
    inputTokens: 40,
    cacheReadTokens: 10,
    outputTokens: 20,
    totalTokens: 60,
    toolCallCount: 2,
    usageUnavailable: false,
  };
  assert.deepEqual(fixture(session("exited", "succeeded"), { metrics }).rows()[0]?.metrics, {
    ...metrics,
    compacted: null,
  });
});

test("canonical archive preserves result, artifact, delegation and provider quota evidence", () => {
  const resultRef = `artifact:runtime-result/sha256/${"a".repeat(64)}`;
  const row = fixture(session("exited", null), {
    archive: {
      resultRef,
      exitCode: 1,
      outcome: "failed",
      classification: "provider_quota",
      reason: "quota exhausted",
      parentRuntimeSessionId: "runtime-parent",
      delegatedByAgentId: "leader",
      providerSessionId: "provider-session",
    },
  }).rows()[0]!;
  assert.equal(row.resultRef, resultRef);
  assert.equal(row.status, "failed");
  assert.equal(row.parentRuntimeSessionId, "runtime-parent");
  assert.equal(row.delegatedByAgentId, "leader");
  assert.equal(row.dispatchPath, `tasks/task-1/artifacts/dispatches/${dispatchId}.json`);
  assert.equal(row.reportPath, undefined);
  assert.match(row.nextAction!, /--resume-dispatch/u);
  assert.equal(row.reviewTarget?.kind, "decision");
});

test("unknown outcome is not promoted by a zero exit and result reference", () => {
  assert.equal(
    fixture(
      session("exited", "unknown", { exitCode: 0, resultRef: "artifact:runtime-result/sha256/" + "a".repeat(64) }),
    ).rows()[0]?.status,
    "unknown",
  );
});

test("point dispatch lookup cannot attribute a canonical dispatch to a different task", () => {
  const f = fixture();
  assert.equal(readTaskDispatchSession(f.projection, "wrong-task", dispatchId), null);
  assert.equal(readTaskDispatchSession(f.projection, taskId, "missing"), null);
});

test("missing task and missing package are reported explicitly", () => {
  for (const task of [null, { taskId }]) {
    const projection = {
      ...fixture().projection,
      readTaskRuntimeBatch: () => ({
        status: "ready",
        taskIds: [taskId],
        rows: [{ taskId, packagePath: null, sessions: [] }],
        watermark: 1,
        sourceRevision: 1,
      }),
      read: () => ({ snapshot: { task }, packagePath: null, watermark: 1, sourceRevision: 1 }),
    } as unknown as TaskProjection;
    assert.throws(() => readTaskDispatches({ projection, taskId }), /Task task-1/u);
  }
});

test("accepted dispatch before session binding is visible without a live index", () => {
  const f = fixture();
  const projection = {
    ...f.projection,
    readTaskRuntimeBatch: () => ({
      status: "ready",
      taskIds: [taskId],
      rows: [{ taskId, packagePath: "tasks/task-1", sessions: [] }],
      watermark: 1,
      sourceRevision: 1,
    }),
  } as unknown as TaskProjection;
  const row = readTaskDispatches({ projection, taskId }).dispatches[0]!;
  assert.equal(row.dispatchId, dispatchId);
  assert.equal(row.status, "unknown");
});

test("a dispatch without canonical attempt-group attribution does not advertise an empty chain", () => {
  const f = fixture(),
    { attemptGroupId: _group, ...payload } = f.event.payload;
  const projection = {
    ...f.projection,
    readRuntimeDispatchesBySession: () => [{ event: { ...f.event, payload } }],
  } as TaskProjection;
  assert.equal(readRuntimeAttemptChain(runtimeSessionId, projection), undefined);
});
