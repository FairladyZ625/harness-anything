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
                  queueDepth: 0
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
          startReplacement: async (target) => {
            assert.equal(released, true);
            assert.equal(target.userRoot, controlTarget.userRoot);
            replacementStarts += 1;
            return v2DaemonStatus(84);
          },
          wait: async () => undefined
        }
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

test("daemon control retains v1 top-level status compatibility for supervisor replacement", async () => {
  let replacementStarts = 0;
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => ({ schema: "daemon-status/v1", started: true, pid: 84 }),
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
  assert.equal((receipt.replacement as Record<string, unknown>).pid, 84);
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
  assert.match(controlErrorHint(receipt), /replacement did not become reachable: autostart failed/u);
});

test("daemon control fails when the replacement PID does not change", async () => {
  const lifecycle = {
    target: controlTarget,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    startReplacement: async () => v2DaemonStatus(42),
    wait: async () => undefined
  } satisfies DaemonControlLifecycle;

  const { exitCode, receipt } = await runCapturedControl(lifecycle);

  assert.equal(exitCode, 1);
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
  extraArgs: ReadonlyArray<string> = []
): Promise<{ readonly exitCode: number; readonly receipt: Record<string, unknown> }> {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => output.push(String(message));
  try {
    const exitCode = await runDaemonProductCommand({
      rootDir: "/repo",
      json: true,
      args: ["daemon", "restart", ...extraArgs],
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
      daemonControlLifecycle
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

function v2DaemonStatus(pid: number): Record<string, unknown> {
  return {
    schema: "daemon-status/v2",
    service: {
      started: true,
      pid,
      build: { loadedIdentity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      activeControl: null
    }
  };
}
