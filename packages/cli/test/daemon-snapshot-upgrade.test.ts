// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  runDaemonProductCommand,
  type DaemonControlLifecycle
} from "../src/commands/daemon/productization.ts";

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
  entrypoint: "/snapshots/release-1/dist/cli/src/index.js",
  args: ["--root", "/repo", "daemon", "serve", "--socket", "/user-root/daemon.sock"]
} as const;

test("daemon upgrade switches to the installed snapshot only after drain handoff", async () => {
  const starts: string[] = [];
  const snapshotEntrypoint = "/user-root/daemon-snapshots/release-2/dist/cli/src/index.js";
  const { exitCode, receipt } = await runCapturedUpgrade({
    target: controlTarget,
    prepareReplacement: async () => runningLaunchConfiguration,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    startReplacement: async (_target, _timeoutMs, launchConfiguration) => {
      starts.push(launchConfiguration.entrypoint);
      return v2DaemonStatus(84);
    },
    wait: async () => undefined
  }, snapshotEntrypoint);

  assert.equal(exitCode, 0, JSON.stringify(receipt));
  assert.deepEqual(starts, [snapshotEntrypoint]);
  const snapshot = receipt.snapshot as Record<string, unknown>;
  assert.equal(snapshot.entrypoint, snapshotEntrypoint);
  assert.equal(snapshot.installed, true);
});

test("daemon upgrade drain timeout leaves the old daemon serving and does not switch launch configuration", async () => {
  let replacementStarts = 0;
  let oldOwnerAlive = true;
  const { exitCode, receipt } = await runCapturedUpgrade({
    target: controlTarget,
    prepareReplacement: async () => runningLaunchConfiguration,
    probeStatus: async () => v2DaemonStatus(42, oldIdentity),
    ownerIsAlive: () => oldOwnerAlive,
    startReplacement: async () => {
      replacementStarts += 1;
      return v2DaemonStatus(84);
    },
    wait: async () => undefined
  }, "/snapshots/release-timeout/dist/cli/src/index.js", async () => {
    oldOwnerAlive = true;
    throw new Error("daemon_queue_drain_timeout: in-flight journal write retained");
  });

  assert.equal(exitCode, 1);
  assert.equal(replacementStarts, 0);
  assert.equal(oldOwnerAlive, true);
  assert.match(controlErrorHint(receipt), /daemon_queue_drain_timeout/u);
});

test("daemon upgrade rolls back to the previous snapshot when new snapshot health verification fails", async () => {
  const starts: string[] = [];
  const stoppedPids: number[] = [];
  const snapshotEntrypoint = "/snapshots/release-bad/dist/cli/src/index.js";
  let endpointProbe = 0;
  const { exitCode, receipt } = await runCapturedUpgrade({
    target: controlTarget,
    prepareReplacement: async () => runningLaunchConfiguration,
    probeStatus: async () => {
      endpointProbe += 1;
      return undefined;
    },
    ownerIsAlive: () => false,
    startReplacement: async (_target, _timeoutMs, launchConfiguration) => {
      starts.push(launchConfiguration.entrypoint);
      return launchConfiguration.entrypoint === snapshotEntrypoint
        ? v2DaemonStatus(84, oldIdentity)
        : v2DaemonStatus(85, oldIdentity);
    },
    stopReplacement: async (_target, pid) => { stoppedPids.push(pid); },
    wait: async () => undefined
  }, snapshotEntrypoint);

  assert.equal(exitCode, 1);
  assert.deepEqual(starts, [snapshotEntrypoint, runningLaunchConfiguration.entrypoint]);
  assert.deepEqual(stoppedPids, [84]);
  assert.ok(endpointProbe >= 2);
  assert.match(controlErrorHint(receipt), /previous snapshot restored and authority converged/u);
});

const oldIdentity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function runCapturedUpgrade(
  daemonControlLifecycle: DaemonControlLifecycle,
  snapshotEntrypoint: string,
  requestDaemonControl: () => Promise<Record<string, unknown>> = async () => ({
    schema: "daemon-control-accepted/v1",
    accepted: true,
    operationId: "control-refresh",
    kind: "refresh",
    before: { pid: 42, loadedIdentity: oldIdentity, launchConfiguration: runningLaunchConfiguration }
  })
): Promise<{ readonly exitCode: number; readonly receipt: Record<string, unknown> }> {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => output.push(String(message));
  try {
    const exitCode = await runDaemonProductCommand({
      rootDir: "/repo",
      json: true,
      args: ["daemon", "upgrade", "--timeout-ms", "100"],
      runServe: async () => undefined,
      requestDaemonControl,
      daemonControlLifecycle,
      installDaemonSnapshot: () => ({
        installed: true,
        snapshotDir: path.dirname(path.dirname(path.dirname(path.dirname(snapshotEntrypoint)))),
        entrypoint: snapshotEntrypoint,
        manifestPath: "/snapshots/manifest.json",
        manifest: {
          schema: "daemon-snapshot-manifest/v1",
          version: "test",
          sourceRef: "HEAD",
          sourceCommit: "a".repeat(40),
          sourceDirty: false,
          sourceFingerprint: "a".repeat(40),
          builtAt: "2026-07-22T00:00:00.000Z",
          entrypoint: "dist/cli/src/index.js",
          contentFingerprint: "sha256:" + "b".repeat(64),
          artifactFileCount: 1,
          runtimePackages: []
        }
      }),
      daemonSourceEntrypoint: () => "/repo/packages/cli/src/index.ts",
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

function v2DaemonStatus(pid: number, loadedIdentity = newIdentity): Record<string, unknown> {
  return {
    schema: "daemon-status/v2",
    service: {
      started: true,
      pid,
      build: { loadedIdentity, installedIdentity: loadedIdentity },
      activeControl: null
    }
  };
}

const newIdentity = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
