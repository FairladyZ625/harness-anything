// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendRuntimeWorkerRecord,
  openDispatchStream,
  readDispatchStreamSummary,
} from "../src/daemon-host/dispatch-stream.ts";
import {
  observeRecordedProcessGroup,
  probeProcessGroup,
  reconcileProcessGroup,
  requestProcessGroupStop,
  sweepOrphanedProcessGroup,
  sweepUntilProvenStopped,
  type ProcessGroupReconcilerDeps,
} from "../src/daemon-host/runtime/process-group-reconciler.ts";
import {
  establishWindowsProcessGroup,
  minimalWindowsPowerShellEnv,
  observeWindowsProcessGroup,
} from "../src/daemon-host/runtime/windows-process-group-port.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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
    removeTempRepository(rootDir);
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
    removeTempRepository(rootDir);
  }
});

test("sweep sends SIGKILL only after an alive probe and requires a second stop proof", () => {
  const stopped = scripted([{ signal: 0 }, { signal: "SIGKILL" }, { signal: 0, error: "ESRCH" }]);
  assert.equal(sweepOrphanedProcessGroup({ pid: 42 }, stopped), "proven_stopped");
  assert.deepEqual(stopped.calls, ["42:0", "42:SIGKILL", "42:0"]);

  const stillRunning = scripted([{ signal: 0 }, { signal: "SIGKILL" }, { signal: 0 }]);
  assert.equal(reconcileProcessGroup(43, stillRunning), "running");
});

test("stop polling waits through transient live probes after SIGKILL", async () => {
  let killRequested = false,
    probesAfterKill = 0;
  const deps: ProcessGroupReconcilerDeps = {
    platform: "linux",
    signalGroup: (_pid, signal) => {
      if (signal === "SIGKILL") killRequested = true;
      else if (killRequested && ++probesAfterKill >= 3)
        throw Object.assign(new Error("process group stopped"), { code: "ESRCH" });
    },
  };

  assert.equal(await sweepUntilProvenStopped(44, deps), "proven_stopped");
  assert.equal(killRequested, true);
  assert.ok(probesAfterKill >= 3);
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

test("observeRecordedProcessGroup trusts Windows containment stop proof and otherwise probes leader reachability", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-recorded-group-alive-")),
    dispatchId = "dispatch_444444444444444444444444";
  try {
    openDispatchStream(rootDir, {
      dispatchId,
      runtimeSessionId: "runtime_444444444444444444444444",
      instanceId: "test",
      taskId: null,
      executionId: null,
      startedAt: new Date().toISOString(),
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_containment",
      pid: process.pid,
      containmentId: "Global\\stopped-job",
    });
    assert.equal(
      observeRecordedProcessGroup(
        { pgid: process.pid, dispatch: { rootDir, dispatchId } },
        { platform: "win32", observeWindowsGroup: () => ({ activeProcesses: 0, uptimeMs: 5_000 }) },
      ),
      "proven_stopped",
    );
    assert.equal(observeRecordedProcessGroup({ pgid: process.pid }, { platform: "win32" }), "running");
    assert.equal(observeRecordedProcessGroup({ pgid: 2_147_483_647 }, { platform: "win32" }), "unknown_unreachable");
    assert.equal(observeRecordedProcessGroup({ pgid: 42 }, scripted([{ signal: 0 }])), "running");
    assert.equal(observeRecordedProcessGroup({ pgid: 42 }, scripted([{ signal: 0, error: "EPERM" }])), "running");
    assert.equal(observeRecordedProcessGroup(1, scripted([])), "unknown_unreachable");
  } finally {
    removeTempRepository(rootDir);
  }
});

test("minimalWindowsPowerShellEnv preserves Windows runtime variables and strips oversized parent env entries", () => {
  const env = minimalWindowsPowerShellEnv({
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    TEMP: "C:\\Temp",
    tmp: "C:\\Temp",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    Path: "C:\\Windows\\System32",
    PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
    HARNESS_TEST_TIER_MANIFEST: "x".repeat(80_000),
    UNRELATED_LARGE_VAR: "y".repeat(20_000),
  });
  assert.deepEqual(env, {
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    TEMP: "C:\\Temp",
    tmp: "C:\\Temp",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    Path: "C:\\Windows\\System32",
    PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
  });
});

test(
  "observeWindowsProcessGroup succeeds under a >70KB parent environment block",
  { skip: process.platform !== "win32" ? "requires Windows PowerShell Add-Type" : false, timeout: 60_000 },
  () => {
    const previous = process.env.HARNESS_TEST_TIER_MANIFEST;
    process.env.HARNESS_TEST_TIER_MANIFEST = "x".repeat(80_000);
    try {
      const observation = observeWindowsProcessGroup(undefined, false);
      assert.equal(observation.activeProcesses, null);
      assert.ok(Number.isSafeInteger(observation.uptimeMs) && observation.uptimeMs >= 0);
    } finally {
      if (previous === undefined) delete process.env.HARNESS_TEST_TIER_MANIFEST;
      else process.env.HARNESS_TEST_TIER_MANIFEST = previous;
    }
  },
);

test("establishWindowsProcessGroup accepts Global and Local job names and fails closed on unexpected output", async () => {
  const baseName = "HarnessRuntime-test-fallback";
  const invocations: string[] = [];
  const decode = (args: readonly string[]) => Buffer.from(args.at(-1)!, "base64").toString("utf16le");
  const globalName = await establishWindowsProcessGroup({
    baseName,
    runPowerShell: async (_cmd, args) => {
      invocations.push(decode(args));
      return `Global\\${baseName}\r\n`;
    },
  });
  assert.equal(globalName, `Global\\${baseName}`);
  assert.match(invocations[0]!, /creationError == 5/u);
  assert.match(invocations[0]!, /"Local\\\\" \+ baseName/u);

  const localName = await establishWindowsProcessGroup({
    baseName,
    runPowerShell: async () => `Local\\${baseName}\r\n`,
  });
  assert.equal(localName, `Local\\${baseName}`);

  await assert.rejects(
    establishWindowsProcessGroup({
      baseName,
      runPowerShell: async () => "Global\\HarnessRuntime-wrong\r\n",
    }),
    /Unexpected Windows runtime job name/u,
  );
  await assert.rejects(
    establishWindowsProcessGroup({
      baseName,
      runPowerShell: async () => "",
    }),
    /Unexpected Windows runtime job name/u,
  );
});

test(
  "establishWindowsProcessGroup attaches a live Windows child job and observeWindowsProcessGroup tracks exit",
  { skip: process.platform !== "win32" ? "requires Windows Job Objects" : false, timeout: 60_000 },
  async () => {
    const portModule = new URL("../src/daemon-host/runtime/windows-process-group-port.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { establishWindowsProcessGroup } from ${JSON.stringify(portModule)};
         const name = await establishWindowsProcessGroup();
         process.send(name);
         process.stdin.resume();`,
      ],
      { stdio: ["pipe", "ignore", "pipe", "ipc"], windowsHide: true },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = once(child, "exit");
    try {
      const [containmentId] = (await Promise.race([
        once(child, "message"),
        exited.then(([code]) => {
          throw new Error(`child exited early (${String(code)}): ${stderr}`);
        }),
      ])) as [string];
      assert.match(containmentId, /^(?:Global|Local)\\HarnessRuntime-[0-9a-f-]+$/u);
      const alive = observeWindowsProcessGroup(containmentId, false);
      assert.ok((alive.activeProcesses ?? 0) >= 1, JSON.stringify(alive));
      child.stdin.end();
      await exited;
      const stopped = observeWindowsProcessGroup(containmentId, false);
      assert.equal(stopped.activeProcesses, 0, JSON.stringify(stopped));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        child.kill("SIGKILL");
        await exited;
      }
    }
  },
);
