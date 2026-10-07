// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TaskV2 } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, archiveDispatchStream, openDispatchStream } from "../src/dispatch-stream.ts";
import { cancelRejectedSquadChildren } from "../src/squad-run-state.ts";

test("owner orphan cancellation recovers the latest local control state from archived streams", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-orphan-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dispatchId = "dispatch_000000000000000000000001",
    squadRunId = "squad_000000000000000000000001",
    binding = { actor: { principal: { personId: "person-test" }, executor: null }, source: "local" },
    state = {
      schema: "squad-run/v1",
      squadRunId,
      stateDispatchId: dispatchId,
      executionId: "execution-parent",
      publicMission: "Orphan recovery",
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
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId: "runtime-parent",
    instanceId: "test",
    startedAt: "2026-10-07T00:00:00Z",
  });
  appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "squad_run_state", state });
  archiveDispatchStream(rootDir, dispatchId);
  const cancelled: string[] = [],
    input = {
      rootDir,
      readTask: (taskId: string) => ({ taskId, status: "active" }) as TaskV2,
      cancel: async (action: { taskId?: unknown }, authority: unknown) => {
        assert.deepEqual(authority, binding);
        cancelled.push(String(action.taskId));
        return { outcome: "applied" };
      },
    };
  await cancelRejectedSquadChildren(input);
  assert.deepEqual(cancelled, ["task-orphan"]);
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "squad_run_state",
    state: { ...state, phase: "planning", revision: 2 },
  });
  cancelled.length = 0;
  await cancelRejectedSquadChildren(input);
  assert.deepEqual(
    cancelled,
    [],
    "active runs retain their children; no canonical cache can override newer control state",
  );
});
