// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendRuntimeWorkerRecord, openDispatchStream, readDispatchStreamSummary } from "../src/dispatch-stream.ts";
import {
  probeProcessGroup,
  reconcileProcessGroup,
  requestProcessGroupStop,
  sweepOrphanedProcessGroup,
  type ProcessGroupReconcilerDeps,
} from "../src/runtime/process-group-reconciler.ts";

function scripted(
  signals: Array<{ signal: NodeJS.Signals | 0; error?: string }>,
): ProcessGroupReconcilerDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    platform: "linux",
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

test("Windows probes witnessed job accounting and sweeps the job rather than a recycled PID", () => {
  const calls: unknown[] = [],
    identity = { pid: 42, containmentId: "Global\\HarnessRuntime-test" },
    deps: ProcessGroupReconcilerDeps = {
      platform: "win32",
      signalGroup: () => assert.fail("Windows must never signal a POSIX group"),
      observeWindowsGroup: (name, terminate) => {
        calls.push([name, terminate]);
        return { activeProcesses: terminate ? 0 : 3, uptimeMs: 50_000 };
      },
    };
  assert.equal(probeProcessGroup(identity, deps), "running");
  assert.equal(reconcileProcessGroup(identity, deps), "proven_stopped");
  assert.deepEqual(calls, [
    [identity.containmentId, false],
    [identity.containmentId, true],
  ]);
});

test("Windows termination requests require zero accounting, and inaccessible jobs stay unknown", () => {
  const identity = { pid: 42, containmentId: "Global\\HarnessRuntime-test" };
  assert.equal(
    reconcileProcessGroup(identity, {
      platform: "win32",
      observeWindowsGroup: () => ({ activeProcesses: 1, uptimeMs: 100 }),
    }),
    "running",
  );
  for (const code of ["EPERM", "ESRCH", "ETIMEDOUT"])
    assert.equal(
      reconcileProcessGroup(identity, {
        platform: "win32",
        observeWindowsGroup: () => {
          throw Object.assign(new Error(code), { code });
        },
      }),
      "unknown_unreachable",
    );
});

test("Windows runtime stop requests target containment and retain an unproven failure", () => {
  const identity = { pid: 42, containmentId: "Global\\HarnessRuntime-test" };
  assert.doesNotThrow(() =>
    requestProcessGroupStop(identity, {
      platform: "win32",
      signalGroup: () => assert.fail("must not terminate a recycled PID"),
      observeWindowsGroup: (name, terminate) => {
        assert.equal(name, identity.containmentId);
        assert.equal(terminate, true);
        return { activeProcesses: 1, uptimeMs: 100 };
      },
    }),
  );
  assert.throws(
    () =>
      requestProcessGroupStop(identity, {
        platform: "win32",
        observeWindowsGroup: () => {
          throw new Error("access denied");
        },
      }),
    { code: "runtime_process_group_unproven" },
  );
});

test("Windows legacy recovery persists one uptime witness and proves only an observed system restart", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-stop-uptime-")),
    dispatchId = "dispatch_424242424242424242424242",
    identity = { pid: 42, dispatch: { rootDir, dispatchId } };
  try {
    openDispatchStream(rootDir, {
      dispatchId,
      runtimeSessionId: "runtime_424242424242424242424242",
      instanceId: "test",
      taskId: null,
      executionId: null,
      startedAt: new Date().toISOString(),
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 42 });
    let uptimeMs = 50_000;
    const deps: ProcessGroupReconcilerDeps = {
      platform: "win32",
      observeWindowsGroup: (name) => {
        assert.equal(name, undefined, "an unwitnessed job must never be treated as an empty job");
        return { activeProcesses: null, uptimeMs };
      },
    };
    assert.equal(reconcileProcessGroup(identity, deps), "unknown_unreachable");
    uptimeMs = 60_000;
    assert.equal(reconcileProcessGroup(identity, deps), "unknown_unreachable");
    assert.equal(
      readDispatchStreamSummary(rootDir, dispatchId)!.records.filter(
        (record) => record.kind === "process_stop_unproven",
      ).length,
      1,
    );
    uptimeMs = 1_000;
    assert.equal(reconcileProcessGroup(identity, deps), "proven_stopped");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Windows binds the containment witness to the exact runtime root", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-stop-witness-")),
    dispatchId = "dispatch_434343434343434343434343";
  try {
    openDispatchStream(rootDir, {
      dispatchId,
      runtimeSessionId: "runtime_434343434343434343434343",
      instanceId: "test",
      taskId: null,
      executionId: null,
      startedAt: new Date().toISOString(),
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_containment",
      pid: 42,
      containmentId: "Global\\exact-job",
    });
    const deps: ProcessGroupReconcilerDeps = {
      platform: "win32",
      observeWindowsGroup: (name) => ({ activeProcesses: name ? 0 : null, uptimeMs: 5_000 }),
    };
    assert.equal(probeProcessGroup({ pid: 43, dispatch: { rootDir, dispatchId } }, deps), "unknown_unreachable");
    assert.equal(probeProcessGroup({ pid: 42, dispatch: { rootDir, dispatchId } }, deps), "proven_stopped");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
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
