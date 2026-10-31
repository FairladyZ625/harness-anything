// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  probeProcessGroup,
  reconcileProcessGroup,
  sweepOrphanedProcessGroup,
  type ProcessGroupReconcilerDeps,
} from "../src/runtime/process-group-reconciler.ts";

function scripted(
  signals: Array<{ signal: NodeJS.Signals | 0; error?: string }>,
): ProcessGroupReconcilerDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    signalGroup: (pid, signal) => {
      calls.push(`${pid}:${signal}`);
      const next = signals.shift();
      if (next?.error) {
        const error = Object.assign(new Error(next.error), { code: next.error });
        throw error;
      }
    },
  };
}

test("ESRCH proves a group stopped, while EPERM remains unknown", () => {
  const absent = scripted([{ signal: 0, error: "ESRCH" }]);
  assert.equal(probeProcessGroup(42, absent), "proven_stopped");
  const inaccessible = scripted([{ signal: 0, error: "EPERM" }]);
  assert.equal(probeProcessGroup(42, inaccessible), "unknown_unreachable");
  const probeFailed = scripted([{ signal: 0, error: "EINVAL" }]);
  assert.equal(probeProcessGroup(42, probeFailed), "unknown_unreachable");
});

test("sweep sends SIGKILL only after an alive probe and requires a second stop proof", () => {
  const stopped = scripted([{ signal: 0 }, { signal: "SIGKILL" }, { signal: 0, error: "ESRCH" }]);
  assert.equal(sweepOrphanedProcessGroup({ pid: 42 }, stopped), "proven_stopped");
  assert.deepEqual(stopped.calls, ["42:0", "42:SIGKILL", "42:0"]);

  const stillRunning = scripted([{ signal: 0 }, { signal: "SIGKILL" }, { signal: 0 }]);
  assert.equal(reconcileProcessGroup(43, stillRunning), "running");
});

test("invalid and non-POSIX groups fail closed without signalling", () => {
  const deps = scripted([]);
  assert.equal(sweepOrphanedProcessGroup(1, deps), "unknown_unreachable");
  assert.equal(sweepOrphanedProcessGroup(42, { ...deps, platform: "win32" }), "unknown_unreachable");
  assert.deepEqual(deps.calls, []);
});

test("the reference pgid identity spelling addresses the same process group", () => {
  const deps = scripted([{ signal: 0, error: "ESRCH" }]);
  assert.equal(probeProcessGroup({ pgid: 44, startedAt: "tick" }, deps), "proven_stopped");
  assert.deepEqual(deps.calls, ["44:0"]);
});
