// harness-test-tier: fast
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeEventV1, RuntimeSession, TaskProjectionQueries } from "@harness-anything/kernel";
import { readLastExecutionWorkerDispatch, readTaskAgentDispatch } from "../src/dispatch-read.ts";

type DispatchEvent = Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>;

const taskId = "task-bounded",
  executionId = "execution-bounded";

function dispatchEvent(index: number, overrides: { readonly executionId?: string; readonly agentId?: string } = {}) {
  const sessionId = `runtime-session-${index}`;
  return {
    schema: "agent-runtime-event/v1",
    type: "runtime_dispatch_requested",
    occurredAt: new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString(),
    payload: {
      dispatchId: `dispatch_${String(index).padStart(24, "0")}`,
      runtimeSessionId: sessionId,
      taskId,
      executionId: overrides.executionId ?? executionId,
      instanceId: "instance-one",
      agentId: overrides.agentId ?? "worker-agent",
    },
  } as DispatchEvent;
}

/**
 * One task with 200 dispatches. Only the last one belongs to the execution's worker session.
 * The legacy path assembled every row (per-row task/document/session reads); the bounded path
 * must assemble exactly the selected row.
 */
function largeTaskProjection() {
  const events = Array.from({ length: 200 }, (_, index) => dispatchEvent(index)),
    workerEvent = events.at(-1)!,
    counts = { fullTaskBatch: 0, fullTaskEvents: 0, taskReads: 0, sessionReads: 0, typeReads: 0 },
    session: RuntimeSession = {
      runtimeSessionId: workerEvent.payload.runtimeSessionId,
      instanceId: "instance-one",
      installationId: "installation-one",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/test",
      providerSessionId: null,
      transcriptRef: null,
      launchGeneration: 1,
      liveness: "live",
      attachable: false,
      taskBindings: [],
      outcome: null,
      exitCode: null,
      resultRef: null,
      lastObservedAt: workerEvent.occurredAt,
    },
    projection = {
      readDispatchLifecycle: lifecycleReadForSync([
        { runtimeSessionId: session.runtimeSessionId, dispatchId: workerEvent.payload.dispatchId, process: "alive" },
      ]),
      readTaskRuntimeBatch: () => {
        counts.fullTaskBatch += 1;
        throw new Error("bounded dispatch selection must not assemble the task's dispatch batch");
      },
      readRuntimeDispatchesByTaskIds: () => {
        counts.fullTaskEvents += 1;
        return events;
      },
      readRuntimeDispatchesByTaskExecution: (requestedTaskId: string, requestedExecutionId: string) =>
        events
          .filter(
            (event) => event.payload.taskId === requestedTaskId && event.payload.executionId === requestedExecutionId,
          )
          .map((event) => ({ event, metrics: null, endedAt: null, outcome: null })),
      read: () => {
        counts.taskReads += 1;
        return { packagePath: "tasks/task-bounded", snapshot: { task: { taskId, title: "Bounded" } } };
      },
      readTaskIndex: (query: { readonly taskIds?: readonly string[] } = {}) => {
        counts.taskReads += 1;
        const ids = query.taskIds ?? [];
        return {
          status: "ready",
          rows: ids.map((id) => ({ taskId: id, title: "Bounded", packagePath: "tasks/task-bounded" })),
          watermark: 1,
          sourceRevision: 1,
          warnings: [],
        };
      },
      readDocument: () => ({ document: null }),
      readRuntimeSession: (id: string) => {
        counts.sessionReads += 1;
        return id === session.runtimeSessionId ? session : null;
      },
      readRuntimeSessionEvents: () => {
        throw new Error("bounded dispatch selection must not read a session's full event history");
      },
      readRuntimeSessionEventsByType: (id: string, types: readonly string[]) => {
        counts.typeReads += 1;
        assert.equal(id, session.runtimeSessionId);
        assert.deepEqual(types, ["runtime_session_outcome_observed"]);
        return [];
      },
      readRuntimeDispatchByResumeSource: () => null,
      readRuntimeDispatchesByAttemptGroup: () => [],
      readTaskRelationsBySources: () => ({ rows: [] }),
      readLeaseIntervals: () => [],
      readCanonicalEvents: () => ({ events: [] }),
      readEventWitness: () => null,
    } as unknown as TaskProjectionQueries;
  return { projection, events, workerEvent, counts };
}

test("last execution worker dispatch assembles only the selected dispatch, not the task's whole history", () => {
  const { projection, workerEvent, counts } = largeTaskProjection(),
    row = readLastExecutionWorkerDispatch(projection, {
      taskId,
      executionId,
      workerExecutorIds: new Set([`runtime-session:${workerEvent.payload.runtimeSessionId}`]),
    });

  assert.equal(row?.dispatchId, workerEvent.payload.dispatchId);
  assert.equal(row?.runtimeSessionId, workerEvent.payload.runtimeSessionId);
  assert.equal(counts.fullTaskBatch, 0, "must not call readTaskRuntimeBatch");
  assert.equal(counts.fullTaskEvents, 0, "must not read every dispatch event of the task");
  assert.equal(counts.sessionReads, 1, "one session point read for the selected row");
  assert.equal(counts.typeReads, 1, "one type-filtered session event read for the selected row");
  assert.ok(counts.taskReads <= 2, `selected-row assembly read the task ${counts.taskReads} times`);
});

test("squad worker acceptance resolves dispatch ids without assembling any dispatch row", () => {
  const { projection, events, counts } = largeTaskProjection(),
    accepted = readTaskAgentDispatch(projection, taskId, "worker-agent");

  assert.deepEqual(accepted, {
    dispatchId: events[0]!.payload.dispatchId,
    runtimeSessionId: events[0]!.payload.runtimeSessionId,
    executionId,
  });
  assert.equal(counts.fullTaskBatch, 0);
  assert.equal(counts.taskReads, 0, "acceptance needs the dispatch event only");
  assert.equal(counts.sessionReads, 0, "acceptance needs the dispatch event only");
});

test("no execution worker match returns null without assembling a row", () => {
  const { projection, counts } = largeTaskProjection(),
    row = readLastExecutionWorkerDispatch(projection, {
      taskId,
      executionId,
      workerExecutorIds: new Set(["runtime-session:somebody-else"]),
    });
  assert.equal(row, undefined);
  assert.equal(counts.taskReads, 0);
});
