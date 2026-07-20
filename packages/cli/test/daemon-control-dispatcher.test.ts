// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderDaemonHelp } from "../src/commands/daemon/help.ts";
import {
  runDaemonProductCommand,
  type DaemonControlLifecycle
} from "../src/commands/daemon/productization.ts";

type ControlRequest = {
  readonly method: string;
  readonly params: Record<string, unknown>;
};

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
  args: [
    "--root", "/repo",
    "daemon", "serve",
    "--repo", "canonical",
    "--socket", "/user-root/daemon.sock",
    "--user-root", "/user-root",
    "--idle-ms", "0",
    "--authority-manifest", "/authority/production.json",
    "--future-daemon-flag", "future-value"
  ]
} as const;

test("daemon dispatcher routes restart and every refresh trigger through canonical admin RPC", async () => {
  const scenarios = [
    { action: "restart", args: ["restart"], method: "admin.daemon.restart", trigger: undefined },
    { action: "refresh", args: ["refresh"], method: "admin.daemon.refresh", trigger: "explicit" },
    { action: "refresh", args: ["refresh", "--trigger", "post-merge"], method: "admin.daemon.refresh", trigger: "post-merge" },
    { action: "refresh", args: ["refresh", "--trigger", "dist-watcher"], method: "admin.daemon.refresh", trigger: "dist-watcher" }
  ] as const;

  for (const scenario of scenarios) {
    const requests: ControlRequest[] = [];
    const output: string[] = [];
    let released = false;
    let replacementStarts = 0;
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      const exitCode = await runDaemonProductCommand({
        rootDir: "/repo",
        json: true,
        args: ["daemon", ...scenario.args, "--timeout-ms", "30000"],
        runServe: async () => undefined,
        requestDaemonControl: async (request: ControlRequest) => {
          requests.push(request);
          return {
            ok: true,
            schema: "CommandReceipt/v1",
            details: {
              data: {
                schema: "daemon-control-accepted/v1",
                accepted: true,
                operationId: `control-${scenario.action}`,
                kind: scenario.action,
                scope: "service",
                requestedAt: "2026-07-16T08:30:00.000Z",
                before: {
                  pid: 42,
                  loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  repoCount: 2,
                  queueDepth: 0,
                  launchConfiguration: runningLaunchConfiguration
                }
              }
            }
          };
        },
        daemonControlLifecycle: {
          target: controlTarget,
          probeStatus: async () => {
            released = true;
            return undefined;
          },
          ownerIsAlive: () => false,
          startReplacement: async (target, _timeoutMs, launchConfiguration) => {
            assert.equal(released, true);
            assert.equal(target.userRoot, controlTarget.userRoot);
            assert.deepEqual(launchConfiguration, runningLaunchConfiguration);
            replacementStarts += 1;
            return v2DaemonStatus(84);
          },
          wait: async () => undefined
        },
        calculateInstalledIdentity: () => "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      });

      assert.equal(exitCode, 0);
      assert.equal(requests.length, 1);
      assert.equal(replacementStarts, 1);
      assert.equal(requests[0]?.method, scenario.method);
      const payload = requests[0]?.params.payload as Record<string, unknown>;
      assert.equal(payload.drainTimeoutMs, 30_000);
      assert.equal(typeof payload.reason, "string");
      if (scenario.trigger) assert.equal(payload.trigger, scenario.trigger);
      else assert.equal("trigger" in payload, false);

      const receipt = JSON.parse(output.at(-1) ?? "") as Record<string, unknown>;
      assert.equal(receipt.ok, true);
      assert.equal(receipt.schema, "daemon-command/v1");
      assert.equal(receipt.command, `daemon-${scenario.action}`);
      assert.equal(receipt.operationId, `control-${scenario.action}`);
      assert.equal(receipt.controlSchema, "daemon-control-accepted/v1");
      assert.deepEqual(receipt.replacement, {
        ...v2DaemonStatus(84),
        userRoot: controlTarget.userRoot,
        endpoint: controlTarget.socketPath
      });
    } finally {
      console.log = originalLog;
    }
  }
});

test("daemon control waits for endpoint and owner release before exactly one v2 replacement autostart", async () => {
  const events: string[] = [];
  let ownerProbe = 0;
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => {
      events.push("endpoint-released");
      return undefined;
    },
    ownerIsAlive: () => {
      ownerProbe += 1;
      const alive = ownerProbe === 1;
      events.push(alive ? "owner-alive" : "owner-released");
      return alive;
    },
    startReplacement: async () => {
      events.push("replacement-start");
      return v2DaemonStatus(84);
    },
    wait: async () => {
      events.push("poll-wait");
    }
  } satisfies DaemonControlLifecycle;

  const { exitCode } = await runCapturedControl(lifecycle);

  assert.equal(exitCode, 0);
  assert.deepEqual(events, [
    "endpoint-released",
    "owner-alive",
    "poll-wait",
    "endpoint-released",
    "owner-released",
    "replacement-start"
  ]);
  assert.equal(events.filter((event) => event === "replacement-start").length, 1);
});

test("daemon control adopts a v2 replacement already exposed by the service supervisor", async () => {
  let replacementStarts = 0;
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => v2DaemonStatus(84),
    ownerIsAlive: () => false,
    startReplacement: async () => {
      replacementStarts += 1;
      return v2DaemonStatus(85);
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle);

  assert.equal(exitCode, 0);
  assert.equal(replacementStarts, 0);
  assert.deepEqual(receipt.replacement, {
    ...v2DaemonStatus(84),
    userRoot: controlTarget.userRoot,
    endpoint: controlTarget.socketPath
  });
});

test("refresh accepts a healthy no-delta replacement converged on the installed identity", async () => {
  const identity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    startReplacement: async () => v2DaemonStatus(84, identity, identity),
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, [], "refresh", identity);

  assert.equal(exitCode, 0, JSON.stringify(receipt));
});

test("restart accepts a healthy same-version replacement converged on the installed identity", async () => {
  const identity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    startReplacement: async () => v2DaemonStatus(84, identity, identity),
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle);

  assert.equal(exitCode, 0, JSON.stringify(receipt));
});

test("refresh accepts a new expected identity when the old daemon reported a legacy identity", async () => {
  const expectedIdentity = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    prepareReplacement: async () => runningLaunchConfiguration,
    startReplacement: async () => v2DaemonStatus(84),
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, [], "refresh", expectedIdentity);

  assert.equal(exitCode, 0, JSON.stringify(receipt));
  const replacement = receipt.replacement as Record<string, unknown>;
  const service = replacement.service as Record<string, unknown>;
  const build = service.build as Record<string, unknown>;
  assert.equal(build.loadedIdentity, "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(build.loadedIdentity, build.installedIdentity);
});

test("refresh rejects a self-consistent replacement that did not load the expected new identity", async () => {
  const staleIdentity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const expectedIdentity = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const stoppedPids: number[] = [];
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    prepareReplacement: async () => runningLaunchConfiguration,
    startReplacement: async () => v2DaemonStatus(84, staleIdentity, staleIdentity),
    stopReplacement: async (_target: typeof controlTarget, pid: number) => {
      stoppedPids.push(pid);
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, [], "refresh", expectedIdentity);

  assert.equal(exitCode, 1);
  assert.deepEqual(stoppedPids, [84]);
  assert.match(controlErrorHint(receipt), /did not match the replacement identity calculated before handoff/u);
});

test("refresh rejects and cleans up a replacement that loaded an old identity", async () => {
  const stoppedPids: number[] = [];
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    startReplacement: async () => v2DaemonStatus(
      84,
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    ),
    stopReplacement: async (_target: typeof controlTarget, pid: number) => {
      stoppedPids.push(pid);
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, [], "refresh");

  assert.equal(exitCode, 1);
  assert.deepEqual(stoppedPids, [84]);
  assert.match(controlErrorHint(receipt), /loaded identity did not converge on the installed identity/u);
  assert.match(controlErrorHint(receipt), /stopped and endpoint remained unowned$/u);
});

test("refresh rejects and cleans up a replacement that retains the accepted operation", async () => {
  const stoppedPids: number[] = [];
  const status = v2DaemonStatus(84);
  (status.service as Record<string, unknown>).activeControl = {
    operationId: "control-refresh",
    kind: "refresh",
    phase: "replacing",
    requestedAt: "2026-07-20T12:00:00.000Z"
  };
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => status,
    ownerIsAlive: () => false,
    startReplacement: async () => status,
    stopReplacement: async (_target: typeof controlTarget, pid: number) => {
      stoppedPids.push(pid);
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, [], "refresh");

  assert.equal(exitCode, 1);
  assert.deepEqual(stoppedPids, [84]);
  assert.match(controlErrorHint(receipt), /did not clear the accepted control operation/u);
});

test("refresh reports cleanup unavailable separately from a replacement that was stopped", async () => {
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    startReplacement: async () => v2DaemonStatus(
      84,
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    ),
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, [], "refresh");

  assert.equal(exitCode, 1);
  assert.match(controlErrorHint(receipt), /cleanup unavailable; replacement may still be serving$/u);
  assert.doesNotMatch(controlErrorHint(receipt), /was stopped/u);
});

test("refresh reports a SIGTERM timeout cleanup failure as possibly still serving", async () => {
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    startReplacement: async () => v2DaemonStatus(
      84,
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    ),
    stopReplacement: async () => {
      throw new Error("SIGTERM timed out; SIGKILL failed");
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, [], "refresh");

  assert.equal(exitCode, 1);
  assert.match(controlErrorHint(receipt), /cleanup failed and replacement may still be serving: SIGTERM timed out; SIGKILL failed$/u);
  assert.doesNotMatch(controlErrorHint(receipt), /cleanup unavailable/u);
  assert.doesNotMatch(controlErrorHint(receipt), /was stopped/u);
});

test("daemon control rejects and cleans up v1 supervisor status that cannot prove replacement convergence", async () => {
  let replacementStarts = 0;
  const stoppedPids: number[] = [];
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => ({ schema: "daemon-status/v1", started: true, pid: 84 }),
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

  const { exitCode, receipt } = await runCapturedControl(lifecycle, ["--timeout-ms", "100"]);

  assert.equal(exitCode, 1);
  assert.equal(replacementStarts, 0);
  assert.deepEqual(stoppedPids, [84]);
  assert.match(controlErrorHint(receipt), /did not expose daemon-status\/v2 replacement criteria/u);
});

test("accepted control does not adopt a reachable new endpoint while the old owner remains alive", async () => {
  let replacementStarts = 0;
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => v2DaemonStatus(84),
    ownerIsAlive: () => true,
    startReplacement: async () => {
      replacementStarts += 1;
      return v2DaemonStatus(85);
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, ["--timeout-ms", "100"]);

  assert.equal(exitCode, 1);
  assert.equal(replacementStarts, 0);
  assert.match(controlErrorHint(receipt), /old daemon endpoint was not released/u);
});

test("daemon control does not accept a reachable endpoint that still reports the old PID", async () => {
  let replacementStarts = 0;
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => v2DaemonStatus(42),
    ownerIsAlive: () => false,
    startReplacement: async () => {
      replacementStarts += 1;
      return v2DaemonStatus(84);
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, ["--timeout-ms", "100"]);

  assert.equal(exitCode, 1);
  assert.equal(replacementStarts, 0);
  assert.match(controlErrorHint(receipt), /old daemon endpoint was not released/u);
});

test("daemon control fails closed on reachable malformed v2 status without starting", async () => {
  let replacementStarts = 0;
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => ({ schema: "daemon-status/v2", service: { started: true } }),
    ownerIsAlive: () => false,
    startReplacement: async () => {
      replacementStarts += 1;
      return v2DaemonStatus(84);
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle, ["--timeout-ms", "100"]);

  assert.equal(exitCode, 1);
  assert.equal(replacementStarts, 0);
  assert.match(controlErrorHint(receipt), /old daemon endpoint was not released/u);
});

test("daemon control fails when the released endpoint replacement is unreachable", async () => {
  let replacementStarts = 0;
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    startReplacement: async () => {
      replacementStarts += 1;
      throw new Error("autostart failed");
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle);

  assert.equal(exitCode, 1);
  assert.equal(replacementStarts, 1);
  assert.match(controlErrorHint(receipt), /DAEMON_RESTART_REPLACEMENT_FAILED_AFTER_HANDOFF: autostart failed/u);
  assert.match(controlErrorHint(receipt), /Restore the daemon with: \/usr\/bin\/node --import tsx/u);
  assert.match(controlErrorHint(receipt), /--authority-manifest \/authority\/production\.json/u);
});

test("daemon control rejects an accepted receipt that omits derived launch configuration before replacement", async () => {
  let replacementStarts = 0;
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => output.push(String(message));
  try {
    const exitCode = await runDaemonProductCommand({
      rootDir: "/repo",
      json: true,
      args: ["daemon", "restart"],
      runServe: async () => undefined,
      requestDaemonControl: async () => ({
        schema: "daemon-control-accepted/v1",
        accepted: true,
        operationId: "control-restart",
        kind: "restart",
        before: {
          pid: 42,
          loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      }),
      daemonControlLifecycle: {
        target: controlTarget,
        probeStatus: async () => undefined,
        ownerIsAlive: () => false,
        startReplacement: async () => {
          replacementStarts += 1;
          return v2DaemonStatus(84);
        },
        wait: async () => undefined
      }
    });

    assert.equal(exitCode, 1);
    assert.equal(replacementStarts, 0);
    const receipt = JSON.parse(output.at(-1) ?? "") as Record<string, unknown>;
    assert.match(controlErrorHint(receipt), /did not include the running daemon launch configuration/u);
  } finally {
    console.log = originalLog;
  }
});

test("refresh rejects a pre-launch-spec daemon before sending control and leaves its PID alive", async () => {
  let controlRequests = 0;
  const runningPid = process.pid;
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => output.push(String(message));
  try {
    const exitCode = await runDaemonProductCommand({
      rootDir: "/repo",
      json: true,
      args: ["daemon", "refresh"],
      runServe: async () => undefined,
      requestDaemonControl: async () => {
        controlRequests += 1;
        throw new Error("control must not be sent to a pre-launch-spec daemon");
      },
      daemonControlLifecycle: {
        target: controlTarget,
        probeStatus: async () => v2DaemonStatus(runningPid),
        ownerIsAlive: () => true,
        prepareReplacement: async () => {
          throw new Error(
            "DAEMON_REFRESH_LAUNCH_SPEC_UNAVAILABLE: the running daemon predates the launch-spec protocol. "
            + "Leave this daemon running and manually restart it once with --authority-manifest /authority/production.json."
          );
        },
        startReplacement: async () => {
          throw new Error("replacement must not start");
        },
        wait: async () => undefined
      }
    });

    assert.equal(exitCode, 1);
    assert.equal(controlRequests, 0);
    process.kill(runningPid, 0);
    const receipt = JSON.parse(output.at(-1) ?? "") as Record<string, unknown>;
    assert.match(controlErrorHint(receipt), /predates the launch-spec protocol/u);
    assert.match(controlErrorHint(receipt), /--authority-manifest \/authority\/production\.json/u);
    assert.doesNotMatch(controlErrorHint(receipt), /did not become reachable|ENOENT/u);
  } finally {
    console.log = originalLog;
  }
});

test("daemon control fails when the replacement PID does not change", async () => {
  const stoppedPids: number[] = [];
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    startReplacement: async () => v2DaemonStatus(42),
    stopReplacement: async (_target: typeof controlTarget, pid: number) => {
      stoppedPids.push(pid);
    },
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle);

  assert.equal(exitCode, 1);
  assert.deepEqual(stoppedPids, []);
  assert.match(controlErrorHint(receipt), /replacement PID did not change/u);
});

test("daemon control RPC rejection is returned as a failed daemon receipt", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => output.push(String(message));
  try {
    const exitCode = await runDaemonProductCommand({
      rootDir: "/repo",
      json: true,
      args: ["daemon", "refresh"],
      runServe: async () => undefined,
      requestDaemonControl: async () => {
        throw new Error("daemon control rejected");
      },
      daemonControlLifecycle: {
        target: controlTarget,
        probeStatus: async () => {
          throw new Error("lifecycle must not run after RPC rejection");
        },
        ownerIsAlive: () => {
          throw new Error("lifecycle must not run after RPC rejection");
        },
        startReplacement: async () => {
          throw new Error("lifecycle must not run after RPC rejection");
        },
        wait: async () => {
          throw new Error("lifecycle must not run after RPC rejection");
        }
      }
    });

    assert.equal(exitCode, 1);
    const receipt = JSON.parse(output.at(-1) ?? "") as {
      readonly ok: boolean;
      readonly error: { readonly hint: string };
    };
    assert.equal(receipt.ok, false);
    assert.match(receipt.error.hint, /daemon control rejected/u);
  } finally {
    console.log = originalLog;
  }
});

test("daemon help exposes logs, restart, refresh, and refresh trigger selection", () => {
  const help = renderDaemonHelp();
  assert.match(help, /logs \[options\]/u);
  assert.match(help, /--levels <csv>/u);
  assert.match(help, /restart/u);
  assert.match(help, /refresh/u);
  assert.match(help, /explicit\|post-merge\|dist-watcher/u);
});

async function runCapturedControl(
  daemonControlLifecycle: DaemonControlLifecycle,
  extraArgs: ReadonlyArray<string> = [],
  kind: "restart" | "refresh" = "restart",
  expectedIdentity = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
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
      calculateInstalledIdentity: () => expectedIdentity
    });
    return {
      exitCode,
      receipt: JSON.parse(output.at(-1) ?? "") as Record<string, unknown>
    };
  } finally {
    console.log = originalLog;
  }
}

function controlErrorHint(receipt: Record<string, unknown>): string {
  const error = receipt.error;
  return typeof error === "object" && error !== null && "hint" in error
    ? String(error.hint)
    : "";
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
