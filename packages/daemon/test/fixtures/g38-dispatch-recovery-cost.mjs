import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const taskId = "task-dispatch-recovery-cost",
  executionId = "execution-dispatch-recovery-cost";

/**
 * `runtime-run` admission reads the dispatch history of one task execution: a stopped worker can be
 * recovered hundreds of times. Measure the production admission at that collection size, through a
 * fenced recovery naming the last dispatch, and count the dispatch rows and keyed reads it performs.
 */
export async function measureTaskDispatchAdmission(rootDir, size) {
  const { admitTaskDispatch } = await import(
      pathToFileURL(path.join(rootDir, "packages/daemon/src/task-dispatch-recovery.ts")).href
    ),
    counts = { dispatchRowsExamined: 0, keyedReads: 0 },
    events = Array.from({ length: size }, (_, index) => ({
      schema: "agent-runtime-event/v1",
      type: "runtime_dispatch_requested",
      occurredAt: new Date(Date.UTC(2026, 10, 7) + index * 1000).toISOString(),
      payload: {
        dispatchId: `dispatch_${String(index).padStart(24, "0")}`,
        runtimeSessionId: `runtime_${String(index).padStart(24, "0")}`,
        taskId,
        executionId,
        startedAt: new Date(Date.UTC(2026, 10, 7) + index * 1000).toISOString(),
      },
    })),
    rows = new Proxy(
      events.map((event) => ({ event })),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^(0|[1-9]\d*)$/u.test(property)) counts.dispatchRowsExamined += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    ),
    byId = new Map(events.map((event) => [event.payload.dispatchId, event])),
    keyed = (value) => {
      counts.keyedReads += 1;
      return value;
    },
    snapshot = {
      revision: 7,
      task: { taskId, status: "active", iteration: 1 },
      executions: [{ executionId, state: "active", iteration: 1, submission: null }],
    },
    projection = {
      read: () =>
        keyed({
          status: "ready",
          snapshot,
          packagePath: `tasks/${taskId}`,
          watermark: snapshot.revision,
          sourceRevision: snapshot.revision,
          warnings: [],
          catchUp: { maxItems: 0, reducedItems: 0, storeTransactions: 0 },
        }),
      readTaskIndex: ({ taskIds } = {}) =>
        keyed({
          status: "ready",
          rows: taskIds?.includes(taskId)
            ? [{ taskId, title: "Dispatch recovery cost", packagePath: `tasks/${taskId}`, status: "active" }]
            : [],
          watermark: snapshot.revision,
          sourceRevision: snapshot.revision,
          warnings: [],
        }),
      readDocument: () => keyed({ document: null }),
      readRuntimeDispatchesByTaskExecution: () => keyed(rows),
      readRuntimeDispatchById: (dispatchId) => keyed(byId.has(dispatchId) ? { event: byId.get(dispatchId) } : null),
      readRuntimeDispatchByResumeSource: () => keyed(null),
      readRuntimeDispatchesByAttemptGroup: () => keyed([]),
      readRuntimeSession: (runtimeSessionId) =>
        keyed({
          runtimeSessionId,
          liveness: "exited",
          outcome: "stopped",
          exitCode: 0,
          resultRef: null,
          lastObservedAt: "2026-11-07T12:00:00.000Z",
        }),
      readRuntimeSessionEventsByType: () => keyed([]),
      readLeaseIntervals: () => keyed([]),
      readTaskRelationsBySources: () => keyed({ rows: [] }),
      readSquadRun: () => keyed(null),
      readCanonicalEvents: () => keyed({ events: [] }),
      readEventWitness: () => keyed(null),
    },
    root = mkdtempSync(path.join(tmpdir(), "g38-dispatch-recovery-"));
  try {
    const source = events.at(-1).payload.dispatchId,
      admitted = admitTaskDispatch({
        repoId: "g38-dispatch-recovery",
        rootDir: root,
        projection,
        payload: {
          taskId,
          agentId: "worker",
          dispatchKey: "g38-recovery",
          recovery: { dispatchId: source, executionId, expectedVersion: snapshot.revision },
        },
        ownsLiveProcess: () => false,
      });
    assert.equal(admitted.kind, "spawn", "the measurement must reach the admitted dispatch");
    assert.equal(admitted.recovery.sourceDispatchId, source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(counts.dispatchRowsExamined >= size, "admission must examine the execution's dispatch rows");
  return { size, counts };
}
