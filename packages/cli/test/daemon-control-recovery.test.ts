// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  runDaemonControl,
  type DaemonControlLifecycle
} from "../src/commands/daemon/control.ts";

const target = {
  repoId: "canonical",
  canonicalRoot: "/repo",
  userRoot: "/user-root",
  daemonId: "default",
  socketPath: "/user-root/daemon.sock",
  legacySocketPath: "/repo/legacy.sock",
  registered: true
} as const;

const launchConfiguration = {
  execPath: "/usr/bin/node",
  execArgv: ["--import", "tsx"],
  entrypoint: "/repo/packages/cli/src/index.ts",
  args: ["--root", "/repo", "daemon", "serve", "--repo", "canonical", "--socket", target.socketPath]
} as const;

test("restart restores service when the old owner exits just after the handoff deadline", async () => {
  let ownerChecks = 0;
  let replacementStarts = 0;
  const lifecycle = recoveryLifecycle({
    ownerIsAlive: () => {
      ownerChecks += 1;
      return ownerChecks <= 2;
    },
    startReplacement: async () => {
      replacementStarts += 1;
      return daemonStatus(84);
    }
  });

  await assert.rejects(
    runRestart(lifecycle, ["--timeout-ms", "100", "--replacement-timeout-ms", "100"]),
    (error: Error) => {
      assert.match(error.message, /old daemon owner did not exit after releasing its endpoint/u);
      assert.match(error.message, /service restored and reachable/u);
      return true;
    }
  );
  assert.equal(replacementStarts, 1);
});

test("restart restores service when the released endpoint replacement fails to start", async () => {
  let replacementStarts = 0;
  const lifecycle = recoveryLifecycle({
    ownerIsAlive: () => false,
    startReplacement: async () => {
      replacementStarts += 1;
      if (replacementStarts === 1) throw new Error("autostart failed");
      return daemonStatus(84);
    }
  });

  await assert.rejects(runRestart(lifecycle), (error: Error) => {
    assert.match(error.message, /DAEMON_RESTART_REPLACEMENT_FAILED_AFTER_HANDOFF: autostart failed/u);
    assert.match(error.message, /service restored and reachable/u);
    return true;
  });
  assert.equal(replacementStarts, 2);
});

function recoveryLifecycle(overrides: Pick<DaemonControlLifecycle, "ownerIsAlive" | "startReplacement">): DaemonControlLifecycle {
  return {
    target,
    probeStatus: async () => undefined,
    ...overrides,
    wait: async () => undefined
  };
}

async function runRestart(
  daemonControlLifecycle: DaemonControlLifecycle,
  extraArgs: ReadonlyArray<string> = []
): Promise<Record<string, unknown>> {
  return runDaemonControl({
    rootDir: "/repo",
    args: ["daemon", "restart", ...extraArgs],
    daemonEntryPath: () => launchConfiguration.entrypoint,
    requestDaemonControl: async () => ({
      schema: "daemon-control-accepted/v1",
      accepted: true,
      operationId: "control-restart",
      kind: "restart",
      before: {
        pid: 42,
        loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        launchConfiguration
      }
    }),
    daemonControlLifecycle
  }, "restart");
}

function daemonStatus(pid: number): Record<string, unknown> {
  const identity = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  return {
    schema: "daemon-status/v2",
    service: {
      started: true,
      pid,
      build: { loadedIdentity: identity, installedIdentity: identity },
      activeControl: null
    }
  };
}
