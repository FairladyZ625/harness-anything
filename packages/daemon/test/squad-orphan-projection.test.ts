// harness-test-tier: fast
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TaskProjection, TaskV2 } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, archiveDispatchStream, openDispatchStream } from "../src/dispatch-stream.ts";
import { cancelRejectedSquadChildren } from "../src/squad-run-state.ts";

test("attach orphan cancellation reuses ready squad projection and rebuilds dirty state from archived streams", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-orphan-projection-")),
    dispatchId = "dispatch_000000000000000000000001",
    squadRunId = "squad_000000000000000000000001",
    binding = { actor: { principal: { personId: "person-test" }, executor: null }, source: "local" },
    state = {
      schema: "squad-run/v1",
      squadRunId,
      stateDispatchId: dispatchId,
      baseSha: null,
      leaderTurns: [],
      observedWorkerRuntimeSessionIds: [],
      workerWaits: [],
      pendingLeaderTriggers: [],
      leaderTurnBudget: 1,
      revision: 1,
      phase: "failed",
      binding,
      workerAttempts: [{ workerId: "worker", taskId: "task-orphan", runtimeSessionId: null, rejection: "rejected" }],
    };
  let ready = true,
    rows = [{ squadRunId, revision: 1, state: state as Readonly<Record<string, unknown>> }],
    rebuilds = 0,
    streamOpens = 0;
  const projection: Pick<TaskProjection, "squadRunProjectionReady" | "readSquadRuns" | "replaceSquadRuns"> = {
      squadRunProjectionReady: () => ready,
      readSquadRuns: () => rows,
      replaceSquadRuns: (next) => {
        rows = [...next];
        ready = true;
        rebuilds++;
      },
    },
    cancelled: string[] = [],
    input = {
      rootDir,
      projection,
      readTask: (taskId: string) => ({ taskId, status: "active" }) as TaskV2,
      cancel: async (action: { readonly taskId: string }, authority: unknown) => {
        assert.deepEqual(authority, binding);
        cancelled.push(action.taskId);
        return { outcome: "applied" };
      },
    };
  try {
    for (let i = 1; i <= 200; i++)
      openDispatchStream(rootDir, {
        dispatchId: `dispatch_${i.toString(16).padStart(24, "0")}`,
        taskId: null,
        executionId: null,
        runtimeSessionId: `runtime-${i}`,
        instanceId: "test",
        startedAt: "2026-09-30T00:00:00.000Z",
      });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "squad_run_state", state });
    archiveDispatchStream(rootDir, dispatchId);
    const original = fs.openSync;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).endsWith(".jsonl")) streamOpens++;
      return original(...args);
    });
    syncBuiltinESMExports();
    await cancelRejectedSquadChildren(input);
    assert.deepEqual(cancelled, ["task-orphan"]);
    assert.equal(streamOpens, 0, "ready attach must not open unrelated live or archived streams");
    assert.equal(rebuilds, 0);

    // Simulate a crash after the durable append but before projection publication.
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "squad_run_state",
      state: { ...state, revision: 2, phase: "planning" },
    });
    ready = false;
    cancelled.length = 0;
    await cancelRejectedSquadChildren(input);
    assert.deepEqual(cancelled, [], "recovered active runs retain their rejected children");
    assert.equal(rebuilds, 1);
    assert.ok(streamOpens >= 200, "dirty projection rebuild includes archived authority");
    assert.equal(rows[0]?.revision, 2);
    streamOpens = 0;
    await cancelRejectedSquadChildren(input);
    assert.equal(streamOpens, 0, "rebuilt projection is reused");
    assert.equal(rebuilds, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
