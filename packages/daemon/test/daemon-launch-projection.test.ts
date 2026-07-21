// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { DaemonActiveControlStatus, DaemonStatusResultV2 } from "../../application/src/index.ts";
import { createDaemonControlService, type DaemonLaunchConfiguration } from "../src/index.ts";

const launchConfiguration: DaemonLaunchConfiguration = {
  execPath: "/current/node",
  execArgv: ["--enable-source-maps"],
  entrypoint: "/current/ha.js",
  args: ["daemon", "serve"],
  machineId: "machine-installation-a",
  daemonGeneration: 5
};

test("control producer keeps legacy launch configuration bytes and gates generation axes", async () => {
  const legacy = await control().requestControl("restart", {
    reason: "legacy client",
    drainTimeoutMs: 5_000
  });
  assert.equal(legacy.ok, true);
  if (!legacy.ok) return;
  const legacyBefore = legacy.accepted.before as unknown as Record<string, unknown>;
  const actual = Buffer.from(JSON.stringify(legacyBefore.launchConfiguration));
  const expected = Buffer.from(JSON.stringify({
    execPath: launchConfiguration.execPath,
    execArgv: launchConfiguration.execArgv,
    entrypoint: launchConfiguration.entrypoint,
    args: launchConfiguration.args
  }));
  assert.equal(actual.equals(expected), true, "legacy control producer leaked launch generation axes");
  assert.equal("daemonGeneration" in legacy.accepted, false);

  const capable = await control().requestControl("restart", {
    reason: "generation-aware client",
    drainTimeoutMs: 5_000,
    daemonGeneration: 5
  });
  assert.equal(capable.ok, true);
  if (!capable.ok) return;
  const capableBefore = capable.accepted.before as unknown as Record<string, unknown>;
  const capableLaunch = capableBefore.launchConfiguration as Record<string, unknown>;
  assert.equal(capable.accepted.daemonGeneration, 5);
  assert.equal(capableLaunch.machineId, "machine-installation-a");
  assert.equal(capableLaunch.daemonGeneration, 5);
});

test("explicit generation control fails closed for legacy platform startup and stale generation", async () => {
  const legacyControl = control({
    execPath: launchConfiguration.execPath,
    execArgv: launchConfiguration.execArgv,
    entrypoint: launchConfiguration.entrypoint,
    args: launchConfiguration.args
  });
  const unavailable = await legacyControl.requestControl("restart", {
    reason: "explicit generation on Windows legacy mode",
    drainTimeoutMs: 5_000,
    daemonGeneration: 5
  });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.code, "daemon_control_generation_mismatch");

  const stale = await control().requestControl("restart", {
    reason: "stale generation",
    drainTimeoutMs: 5_000,
    daemonGeneration: 4
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error.hint, /does not match current generation 5/u);
});

function control(configuration: DaemonLaunchConfiguration = launchConfiguration) {
  let active: DaemonActiveControlStatus | null = null;
  return createDaemonControlService({
    launchConfiguration: configuration,
    preflightReplacement: async () => undefined,
    status: statusFixture,
    activeControl: () => active,
    setActiveControl: (value) => { active = value; },
    setDrainTimeout: () => undefined,
    requestStop: () => undefined
  }, {
    present: (error) => ({ code: error.code, hint: error.code })
  });
}

function statusFixture(): DaemonStatusResultV2 {
  return {
    schema: "daemon-status/v2",
    daemonId: "daemon-a",
    pid: 41,
    started: true,
    rootDir: "/repo",
    repoId: "canonical",
    endpoint: "/tmp/daemon.sock",
    version: "0.1.0",
    protocolVersion: 1,
    queue: queue(),
    queueDepth: 0,
    connections: { active: 1, total: 1 },
    lastReconcileAt: null,
    lastReconcileError: null,
    lastRecovery: null,
    projectionGeneration: null,
    service: {
      daemonId: "daemon-a",
      pid: 41,
      endpoint: "/tmp/daemon.sock",
      userRoot: "/user",
      started: true,
      startedAt: "2026-07-21T00:00:00.000Z",
      uptimeMs: 1,
      build: {
        version: "0.1.0",
        loadedIdentity: "sha256:a",
        installedIdentity: "sha256:a",
        identitySource: "installed-artifact-set",
        stale: false
      },
      queue: queue(),
      connections: { active: 1, total: 1 },
      repoCount: 1,
      attachedCount: 1,
      unavailableCount: 0,
      lastReconcileAt: null,
      lastReconcileError: null,
      activeControl: null
    },
    requestedRepo: repo(),
    repos: [repo()]
  };
}

function queue() {
  return {
    interactive: 0,
    normal: 0,
    background: 0,
    maintenance: 0,
    running: false,
    depth: 0
  };
}

function repo() {
  return {
    repoId: "canonical",
    canonicalRoot: "/repo",
    state: "attached" as const,
    lock: { path: null, ownerToken: null },
    queue: queue(),
    lastRecovery: null,
    projectionGeneration: null,
    lastError: null,
    lastMaterializerError: null,
    lastReconcileError: null
  };
}
