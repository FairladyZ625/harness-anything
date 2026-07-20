// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  runDaemonProductCommand,
  type DaemonControlLifecycle
} from "../src/commands/daemon/productization.ts";
import {
  stopDaemonReplacement,
  type DaemonReplacementStopRuntime
} from "../src/commands/daemon/replacement-cleanup.ts";

const controlTarget = {
  repoId: "canonical",
  canonicalRoot: "/repo",
  userRoot: "/user-root",
  daemonId: "default",
  socketPath: "/user-root/daemon.sock",
  legacySocketPath: "/repo/legacy.sock",
  registered: true
} as const;

const runningLaunchConfiguration = {
  execPath: "/usr/bin/node",
  execArgv: ["--import", "tsx"],
  entrypoint: "/repo/packages/cli/src/index.ts",
  args: ["--root", "/repo", "daemon", "serve", "--repo", "canonical", "--socket", controlTarget.socketPath]
} as const;

test("handoff rejects and cleans up a v2 supervisor replacement loaded from the wrong identity", async () => {
  const stoppedPids: number[] = [];
  let replacementStarts = 0;
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => v2DaemonStatus(
      84,
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    ),
    ownerIsAlive: () => false,
    startReplacement: async () => {
      replacementStarts += 1;
      return v2DaemonStatus(85);
    },
    stopReplacement: async (_target: typeof controlTarget, pid: number) => {
      stoppedPids.push(pid);
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, [], "refresh");

  assert.equal(exitCode, 1);
  assert.equal(replacementStarts, 0);
  assert.deepEqual(stoppedPids, [84]);
  assert.match(controlErrorHint(receipt), /loaded identity did not converge on the installed identity/u);
});

test("handoff waits for this operation to clear before adopting the v2 supervisor replacement", async () => {
  let probes = 0;
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => {
      probes += 1;
      return probes < 3 ? v2DaemonStatus(84, undefined, undefined, "control-refresh") : v2DaemonStatus(84);
    },
    ownerIsAlive: () => false,
    startReplacement: async () => {
      throw new Error("the supervisor replacement must be adopted");
    },
    stopReplacement: async () => {
      throw new Error("a converging replacement must not be stopped");
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode } = await runCapturedControl(lifecycle, ["--timeout-ms", "500"], "refresh");

  assert.equal(exitCode, 0);
  assert.equal(probes, 3);
});

test("handoff rejects and cleans up a v2 supervisor replacement that never clears this operation", async () => {
  let probes = 0;
  const stoppedPids: number[] = [];
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => {
      probes += 1;
      return v2DaemonStatus(84, undefined, undefined, "control-refresh");
    },
    ownerIsAlive: () => false,
    startReplacement: async () => {
      throw new Error("an occupied endpoint must not autostart");
    },
    stopReplacement: async (_target: typeof controlTarget, pid: number) => {
      stoppedPids.push(pid);
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, ["--timeout-ms", "200"], "refresh");

  assert.equal(exitCode, 1);
  assert.ok(probes > 1);
  assert.deepEqual(stoppedPids, [84]);
  assert.match(controlErrorHint(receipt), /did not clear the accepted control operation control-refresh/u);
});

test("handoff does not kill a healthy v2 replacement while another operation is active", async () => {
  let probes = 0;
  const stoppedPids: number[] = [];
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => {
      probes += 1;
      return v2DaemonStatus(84, undefined, undefined, "control-someone-else");
    },
    ownerIsAlive: () => false,
    startReplacement: async () => {
      throw new Error("an occupied endpoint must not autostart");
    },
    stopReplacement: async (_target: typeof controlTarget, pid: number) => {
      stoppedPids.push(pid);
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, ["--timeout-ms", "200"], "refresh");

  assert.equal(exitCode, 1);
  assert.ok(probes > 1);
  assert.deepEqual(stoppedPids, []);
  assert.match(controlErrorHint(receipt), /another daemon control operation remained active/u);
  assert.match(controlErrorHint(receipt), /left running/u);
});

test("replacement cleanup validates target ownership, escalates to SIGKILL, and verifies endpoint quiescence", async () => {
  const signals: NodeJS.Signals[] = [];
  let alive = true;
  const runtime = stopRuntime({
    probeStatus: async () => alive ? v2DaemonStatus(84) : undefined,
    processIsAlive: () => alive,
    signal: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") alive = false;
    }
  });

  await stopDaemonReplacement(controlTarget, 84, 100, runtime);

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("replacement cleanup refuses to signal a PID not owned by the target endpoint", async () => {
  const signals: NodeJS.Signals[] = [];
  const runtime = stopRuntime({
    probeStatus: async () => v2DaemonStatus(85),
    processIsAlive: () => true,
    signal: (_pid, signal) => signals.push(signal)
  });

  await assert.rejects(
    stopDaemonReplacement(controlTarget, 84, 100, runtime),
    /target endpoint reports pid 85; refusing to signal pid 84/u
  );
  assert.deepEqual(signals, []);
});

test("replacement cleanup revalidates endpoint ownership before SIGKILL after PID reuse", async () => {
  const signals: NodeJS.Signals[] = [];
  let ownerPid = 84;
  const runtime = stopRuntime({
    probeStatus: async () => v2DaemonStatus(ownerPid),
    processIsAlive: () => true,
    signal: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") ownerPid = 85;
    }
  });

  await assert.rejects(
    stopDaemonReplacement(controlTarget, 84, 100, runtime),
    /target endpoint reports pid 85; refusing to signal pid 84/u
  );
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("replacement cleanup detects supervisor resurrection during the endpoint stability window", async () => {
  const signals: NodeJS.Signals[] = [];
  let alive = true;
  let probes = 0;
  const runtime = stopRuntime({
    probeStatus: async () => {
      probes += 1;
      return probes === 1 ? v2DaemonStatus(84) : v2DaemonStatus(85);
    },
    processIsAlive: () => alive,
    signal: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") alive = false;
    },
    endpointStabilityMs: 100
  });

  await assert.rejects(
    stopDaemonReplacement(controlTarget, 84, 100, runtime),
    /target endpoint became reachable again with pid 85/u
  );
  assert.deepEqual(signals, ["SIGTERM"]);
});

function stopRuntime(
  overrides: Pick<DaemonReplacementStopRuntime, "probeStatus" | "processIsAlive" | "signal">
    & Partial<Pick<DaemonReplacementStopRuntime, "endpointStabilityMs">>
): DaemonReplacementStopRuntime {
  return {
    ...overrides,
    statusPid: daemonStatusPid,
    wait: async () => undefined,
    endpointStabilityMs: overrides.endpointStabilityMs ?? 0
  };
}

async function runCapturedControl(
  daemonControlLifecycle: DaemonControlLifecycle,
  extraArgs: ReadonlyArray<string>,
  kind: "restart" | "refresh"
): Promise<{ readonly exitCode: number; readonly receipt: Record<string, unknown> }> {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => output.push(String(message));
  try {
    const exitCode = await runDaemonProductCommand({
      rootDir: "/repo",
      json: true,
      args: ["daemon", kind, ...extraArgs],
      runServe: async () => undefined,
      requestDaemonControl: async () => ({
        schema: "daemon-control-accepted/v1",
        accepted: true,
        operationId: `control-${kind}`,
        kind,
        before: {
          pid: 42,
          loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          launchConfiguration: runningLaunchConfiguration
        }
      }),
      daemonControlLifecycle,
      calculateInstalledIdentity: () => "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });
    return { exitCode, receipt: JSON.parse(output.at(-1) ?? "") as Record<string, unknown> };
  } finally {
    console.log = originalLog;
  }
}

function controlErrorHint(receipt: Record<string, unknown>): string {
  const error = receipt.error;
  return typeof error === "object" && error !== null && "hint" in error ? String(error.hint) : "";
}

function daemonStatusPid(status: Record<string, unknown>): number | undefined {
  const service = status.schema === "daemon-status/v2" ? status.service : status;
  if (typeof service !== "object" || service === null || !("pid" in service)) return undefined;
  return typeof service.pid === "number" ? service.pid : undefined;
}

function v2DaemonStatus(
  pid: number,
  loadedIdentity = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  installedIdentity = loadedIdentity,
  activeOperationId?: string
): Record<string, unknown> {
  return {
    schema: "daemon-status/v2",
    service: {
      started: true,
      pid,
      build: { loadedIdentity, installedIdentity },
      activeControl: activeOperationId ? {
        operationId: activeOperationId,
        kind: "refresh",
        phase: "replacing",
        requestedAt: "2026-07-20T12:00:00.000Z"
      } : null
    }
  };
}
