// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonAutostartTimeoutError } from "@harness-anything/daemon";
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

test("restart adopts a live replacement that becomes ready after the normal startup budget", async () => {
  const progress: string[] = [];
  let probes = 0;
  let replacementStarts = 0;
  const lifecycle: DaemonControlLifecycle = {
    target,
    probeStatus: async () => {
      probes += 1;
      return probes === 1 ? undefined : daemonStatus(84);
    },
    probeEndpointOwner: () => ({ pid: 84, alive: true }),
    ownerIsAlive: (pid) => pid === 84,
    isReadinessTimeout: (error) => error instanceof DaemonAutostartTimeoutError,
    readinessTimeoutPid: (error) => error instanceof DaemonAutostartTimeoutError ? error.spawnedPid : undefined,
    reportProgress: (message) => progress.push(message),
    startReplacement: async () => {
      replacementStarts += 1;
      throw new DaemonAutostartTimeoutError(100, new Error("not ready"), 84);
    },
    wait: async () => undefined
  };

  const result = await runRestart(lifecycle, [
    "--replacement-timeout-ms", "100",
    "--replacement-settle-timeout-ms", "100"
  ]);

  const replacement = result.replacement as { readonly service?: { readonly pid?: unknown } };
  assert.equal(replacement.service?.pid, 84);
  assert.equal(replacementStarts, 1);
  assert.equal(progress.length, 1);
  assert.match(progress[0]!, /pid 84.*owns the endpoint.*still starting/iu);
});

test("restart stops a live unreachable replacement at the settling cap before restoring service", async () => {
  let replacementAlive = true;
  let replacementStarts = 0;
  const stoppedPids: number[] = [];
  const lifecycle: DaemonControlLifecycle = {
    target,
    probeStatus: async () => undefined,
    probeEndpointOwner: () => replacementAlive ? { pid: 84, alive: true } : undefined,
    ownerIsAlive: (pid) => pid === 84 && replacementAlive,
    isReadinessTimeout: (error) => error instanceof DaemonAutostartTimeoutError,
    readinessTimeoutPid: (error) => error instanceof DaemonAutostartTimeoutError ? error.spawnedPid : undefined,
    startReplacement: async () => {
      replacementStarts += 1;
      if (replacementStarts === 1) {
        throw new DaemonAutostartTimeoutError(100, new Error("not ready"), 84);
      }
      return daemonStatus(85);
    },
    stopReplacement: async (_target, pid) => {
      stoppedPids.push(pid);
      replacementAlive = false;
    },
    wait: async () => undefined
  };

  await assert.rejects(
    runRestart(lifecycle, [
      "--replacement-timeout-ms", "100",
      "--replacement-settle-timeout-ms", "100"
    ]),
    (error: Error) => {
      assert.match(error.message, /exceeded the additional 100ms settling limit/u);
      assert.match(error.message, /service restored and reachable/u);
      return true;
    }
  );
  assert.deepEqual(stoppedPids, [84]);
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
