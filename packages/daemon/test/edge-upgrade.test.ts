// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo } from "@harness-anything/storage";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import {
  checkEdgeUpgradeStatus,
  commitsMatch,
  parseCenterBuildCommitFromText,
  readEdgeUpgradeState,
  resolveEdgeInstallRoot,
  runEdgeUpgrade,
  writeEdgeUpgradeState,
  type EdgeUpgradeInstallerInvocation,
  type EdgeUpgradeProgress,
} from "../src/daemon-host/client/edge-upgrade.ts";
import { writeFleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import type { JsonObject } from "../src/daemon-host/protocol/json-rpc-types.ts";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);

function createCheckoutFixture(t: test.TestContext): {
  readonly root: string;
  readonly installRoot: string;
  readonly userRoot: string;
  readonly repoRoot: string;
  readonly repoId: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-upgrade-contract-"));
  t.after(() => removeTempRepository(root));
  const installRoot = path.join(root, "install");
  const userRoot = path.join(root, "user");
  const repoRoot = path.join(root, "edge-repo");
  const repoId = "demo-edge";
  mkdirSync(path.join(installRoot, ".git"), { recursive: true });
  mkdirSync(path.join(installRoot, "scripts"), { recursive: true });
  writeFileSync(path.join(installRoot, "scripts", "install-source.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(installRoot, "scripts", "install-source.ps1"), "exit 0\n");
  mkdirSync(path.join(repoRoot, "harness"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  writeFileSync(
    path.join(repoRoot, "harness", "harness.yaml"),
    `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  registerDaemonRepo({ canonicalRoot: repoRoot, repoId, userRoot, mode: "remote-edge" });
  const caPath = path.join(userRoot, "fleet", "edge", repoId, "fleet-center-ca.pem");
  mkdirSync(path.dirname(caPath), { recursive: true });
  writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n");
  writeFleetEdgeConfig(userRoot, repoId, {
    repoId,
    host: "127.0.0.1",
    port: 7545,
    caPath,
    nodeId: "edge-node-1",
    credential: "machine-cred-1",
    viewRoot: path.join(userRoot, "views"),
    quotaBytes: 1024 * 1024,
  });
  return { root, installRoot, userRoot, repoRoot, repoId };
}

test("parseCenterBuildCommitFromText extracts commit from structured and error messages", () => {
  assert.equal(
    parseCenterBuildCommitFromText(
      `Fleet protocol 1 is incompatible; node n1 build=${COMMIT_A}, center build=${COMMIT_B}.`,
    ),
    COMMIT_B,
  );
  assert.equal(
    parseCenterBuildCommitFromText("Edge must upgrade to center build deadbee before applying task event shape 2."),
    "deadbee",
  );
  assert.equal(
    parseCenterBuildCommitFromText("Fleet build differs (center=123456789abc, edge=abcdef123456); upgrade."),
    "123456789abc",
  );
  assert.equal(parseCenterBuildCommitFromText("no commit here"), null);
  assert.equal(commitsMatch(COMMIT_A, COMMIT_A.slice(0, 12)), true);
  assert.equal(commitsMatch(COMMIT_A, COMMIT_B), false);
});

test("resolveEdgeInstallRoot honors explicit installRoot and HARNESS_INSTALL_ROOT and rejects invalid dirs", (t) => {
  const fixture = createCheckoutFixture(t);
  assert.equal(resolveEdgeInstallRoot({ installRoot: fixture.installRoot }), fixture.installRoot);
  assert.equal(resolveEdgeInstallRoot({ env: { HARNESS_INSTALL_ROOT: fixture.installRoot } }), fixture.installRoot);
  assert.equal(resolveEdgeInstallRoot({ installRoot: fixture.repoRoot }), null);
});

test("runEdgeUpgrade discovers center commit, delegates to install-source, waits for handoff, and confirms sync", async (t) => {
  const fixture = createCheckoutFixture(t);
  let head = COMMIT_A;
  let daemonBuild = COMMIT_A;
  let daemonPid = 1001;
  let drifted = false;
  const installerCalls: EdgeUpgradeInstallerInvocation[] = [];
  const syncedPayloads: JsonObject[] = [];
  const stages: string[] = [];

  const receipt = await runEdgeUpgrade({
    installRoot: fixture.installRoot,
    userRoot: fixture.userRoot,
    daemonId: "test-daemon",
    rootDir: fixture.repoRoot,
    env: {},
    pollIntervalMs: 5,
    handoffTimeoutMs: 2_000,
    onProgress: (p: EdgeUpgradeProgress) => stages.push(p.stage),
    readDiskBuildId: () => head,
    runGit: async (_root, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${head}\n`, stderr: "" };
      if (args[0] === "symbolic-ref") return { stdout: "main\n", stderr: "" };
      if (args[0] === "status") return { stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        const ref = args.at(-1)!.replace(/\^\{commit\}$/u, "");
        if (ref === COMMIT_A || ref === COMMIT_B || ref === "main")
          return { stdout: `${ref === "main" ? COMMIT_A : ref}\n`, stderr: "" };
        throw new Error("not found");
      }
      return { stdout: "", stderr: "" };
    },
    runInstaller: async (invocation) => {
      installerCalls.push(invocation);
      head = invocation.ref;
      drifted = true;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    requestDaemonRpc: async (_socket, method, params) => {
      if (method === "daemon.status") {
        if (drifted) {
          // Simulate build_superseded handoff completing on the next status poll.
          drifted = false;
          daemonBuild = head;
          daemonPid = 2002;
          return {
            ok: true,
            pid: 1001,
            build: { commit: COMMIT_A, loadedBuildId: COMMIT_A, diskBuildId: head, drifted: true },
          };
        }
        return {
          ok: true,
          pid: daemonPid,
          build: { commit: daemonBuild, loadedBuildId: daemonBuild, diskBuildId: head, drifted: false },
        };
      }
      if (method === "repo.fleet.overview.read") {
        return {
          ok: true,
          center: { commitSha: COMMIT_B },
          versionWarning: {
            centerBuildCommit: COMMIT_B,
            localBuildCommit: COMMIT_A,
            upgradeCommand: "ha edge upgrade",
          },
        };
      }
      if (method === "daemon.fleet.edge.sync") {
        syncedPayloads.push(params);
        return { ok: true, ackCut: 42, lagRevisions: 0, mirrorOutcome: "materialized" };
      }
      throw new Error(`unexpected RPC ${method}`);
    },
  });

  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.outcome, "upgraded");
  assert.equal(receipt.fromCommit, COMMIT_A);
  assert.equal(receipt.toCommit, COMMIT_B);
  assert.equal(receipt.daemonPid, 2002);
  assert.equal(receipt.daemonBuildId, COMMIT_B);
  assert.equal(receipt.daemonRestarted, true);
  assert.equal(receipt.guiRestartRequired, true);
  assert.deepEqual(receipt.syncedRepos, [
    { repoId: fixture.repoId, revision: 42, lagRevisions: 0, mirrorOutcome: "materialized" },
  ]);
  assert.equal(installerCalls.length, 1);
  assert.equal(installerCalls[0]!.ref, COMMIT_B);
  assert.equal(installerCalls[0]!.offline, false);
  assert.equal(syncedPayloads.length, 1);
  assert.deepEqual(stages, ["preflight", "installing", "handing_off", "syncing", "completed"]);
  const saved = readEdgeUpgradeState(fixture.userRoot);
  assert.equal(saved?.previousCommit, COMMIT_A);
  assert.equal(saved?.targetCommit, COMMIT_B);
  assert.equal(saved?.outcome, "upgraded");
});

test("runEdgeUpgrade returns already_current idempotently without re-running installer", async (t) => {
  const fixture = createCheckoutFixture(t);
  let installerCalled = 0;

  const receipt = await runEdgeUpgrade({
    installRoot: fixture.installRoot,
    userRoot: fixture.userRoot,
    daemonId: "test-daemon",
    rootDir: fixture.repoRoot,
    env: {},
    readDiskBuildId: () => COMMIT_A,
    runGit: async (_root, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${COMMIT_A}\n`, stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        const ref = args.at(-1)!.replace(/\^\{commit\}$/u, "");
        return { stdout: `${ref}\n`, stderr: "" };
      }
      if (args[0] === "symbolic-ref") return { stdout: "main\n", stderr: "" };
      if (args[0] === "status") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    },
    runInstaller: async () => {
      installerCalled += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    requestDaemonRpc: async (_socket, method) => {
      if (method === "daemon.status") {
        return {
          ok: true,
          pid: 1001,
          build: { commit: COMMIT_A, loadedBuildId: COMMIT_A, diskBuildId: COMMIT_A, drifted: false },
        };
      }
      if (method === "repo.fleet.overview.read") return { ok: true, center: { commitSha: COMMIT_A } };
      if (method === "daemon.fleet.edge.sync") return { ok: true, ackCut: 10, lagRevisions: 0, mirrorOutcome: "clean" };
      throw new Error(`unexpected ${method}`);
    },
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.outcome, "already_current");
  assert.equal(installerCalled, 0);
  assert.equal(receipt.guiRestartRequired, false);

  const failedSync = await runEdgeUpgrade({
    installRoot: fixture.installRoot,
    userRoot: fixture.userRoot,
    daemonId: "test-daemon",
    rootDir: fixture.repoRoot,
    env: {},
    readDiskBuildId: () => COMMIT_A,
    runGit: async (_root, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${COMMIT_A}\n`, stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        const ref = args.at(-1)!.replace(/\^\{commit\}$/u, "");
        return { stdout: `${ref}\n`, stderr: "" };
      }
      if (args[0] === "symbolic-ref") return { stdout: "main\n", stderr: "" };
      if (args[0] === "status") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    },
    runInstaller: async () => {
      installerCalled += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    requestDaemonRpc: async (_socket, method) => {
      if (method === "daemon.status") {
        return {
          ok: true,
          pid: 1001,
          build: { commit: COMMIT_A, loadedBuildId: COMMIT_A, diskBuildId: COMMIT_A, drifted: false },
        };
      }
      if (method === "repo.fleet.overview.read") return { ok: true, center: { commitSha: COMMIT_A } };
      if (method === "daemon.fleet.edge.sync") {
        return { ok: false, code: "fleet_unreachable", error: { code: "fleet_unreachable", hint: "center offline" } };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  assert.equal(failedSync.ok, false);
  assert.equal(failedSync.outcome, "failed");
  assert.equal(failedSync.code, "edge_upgrade_sync_failed");
  assert.equal(installerCalled, 0);
});

test("runEdgeUpgrade refuses dirty checkouts and task-bound runtime sessions before modifying anything", async (t) => {
  const fixture = createCheckoutFixture(t);
  const runtimeBlocked = await runEdgeUpgrade({
    installRoot: fixture.installRoot,
    userRoot: fixture.userRoot,
    env: { HARNESS_ACTOR: "agent:runtime-session:rt_1" },
  });
  assert.equal(runtimeBlocked.ok, false);
  assert.equal(runtimeBlocked.code, "daemon_start_runtime_forbidden");

  const dirty = await runEdgeUpgrade({
    installRoot: fixture.installRoot,
    userRoot: fixture.userRoot,
    env: {},
    toRef: COMMIT_B,
    runGit: async (_root, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${COMMIT_A}\n`, stderr: "" };
      if (args[0] === "status") return { stdout: " M packages/cli/src/index.ts\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.code, "edge_checkout_dirty");
});

test("runEdgeUpgrade automatically rolls back when first sync fails on the new build", async (t) => {
  const fixture = createCheckoutFixture(t);
  let head = COMMIT_A;
  let daemonBuild = COMMIT_A;
  let syncCalls = 0;
  const installerCalls: EdgeUpgradeInstallerInvocation[] = [];
  const gitCheckouts: string[] = [];

  const receipt = await runEdgeUpgrade({
    installRoot: fixture.installRoot,
    userRoot: fixture.userRoot,
    daemonId: "test-daemon",
    rootDir: fixture.repoRoot,
    toRef: COMMIT_B,
    env: {},
    pollIntervalMs: 5,
    handoffTimeoutMs: 2_000,
    readDiskBuildId: () => head,
    runGit: async (_root, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${head}\n`, stderr: "" };
      if (args[0] === "symbolic-ref") return { stdout: "main\n", stderr: "" };
      if (args[0] === "status") return { stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        const ref = args.at(-1)!.replace(/\^\{commit\}$/u, "");
        return { stdout: `${ref === "main" ? COMMIT_A : ref}\n`, stderr: "" };
      }
      if (args[0] === "checkout") {
        const target = args.at(-1)!;
        gitCheckouts.push(target);
        head = target === "main" ? COMMIT_A : target;
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    runInstaller: async (invocation) => {
      installerCalls.push(invocation);
      head = invocation.ref;
      daemonBuild = invocation.ref;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    requestDaemonRpc: async (_socket, method) => {
      if (method === "daemon.status") {
        return {
          ok: true,
          pid: 3003,
          build: { commit: daemonBuild, loadedBuildId: daemonBuild, diskBuildId: head, drifted: false },
        };
      }
      if (method === "daemon.fleet.edge.sync") {
        syncCalls += 1;
        if (syncCalls === 1) {
          return {
            ok: false,
            code: "edge_upgrade_required",
            error: { code: "edge_upgrade_required", hint: "incompatible shape on target commit" },
          };
        }
        return { ok: true, ackCut: 15, lagRevisions: 0, mirrorOutcome: "clean" };
      }
      throw new Error(`unexpected ${method}`);
    },
  });

  assert.equal(receipt.ok, false);
  assert.equal(receipt.outcome, "rolled_back");
  assert.equal(receipt.rolledBack, true);
  assert.equal(receipt.rollbackSyncOk, true);
  assert.equal(receipt.code, "edge_upgrade_required");
  assert.equal(receipt.toCommit, COMMIT_A);
  assert.equal(head, COMMIT_A);
  assert.equal(installerCalls.length, 2);
  assert.equal(installerCalls[0]!.ref, COMMIT_B);
  assert.equal(installerCalls[0]!.offline, false);
  assert.equal(installerCalls[1]!.ref, COMMIT_A);
  assert.equal(installerCalls[1]!.offline, true);
  assert.ok(gitCheckouts.includes(COMMIT_A));
});

test("runEdgeUpgrade automatically rolls back when installer fails or handoff times out", async (t) => {
  const fixture = createCheckoutFixture(t);
  let head = COMMIT_A;
  let attempt = 0;

  const receipt = await runEdgeUpgrade({
    installRoot: fixture.installRoot,
    userRoot: fixture.userRoot,
    daemonId: "test-daemon",
    rootDir: fixture.repoRoot,
    toRef: COMMIT_C,
    env: {},
    pollIntervalMs: 5,
    handoffTimeoutMs: 2_000,
    readDiskBuildId: () => head,
    runGit: async (_root, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${head}\n`, stderr: "" };
      if (args[0] === "symbolic-ref") return { stdout: "", stderr: "" };
      if (args[0] === "status") return { stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        const ref = args.at(-1)!.replace(/\^\{commit\}$/u, "");
        return { stdout: `${ref}\n`, stderr: "" };
      }
      if (args[0] === "checkout") {
        head = args.at(-1)!;
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    runInstaller: async (invocation) => {
      attempt += 1;
      if (attempt === 1) {
        head = COMMIT_C;
        return { exitCode: 1, stdout: "", stderr: "tsc failed on target commit" };
      }
      head = invocation.ref;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    requestDaemonRpc: async (_socket, method) => {
      if (method === "daemon.status") {
        return {
          ok: true,
          pid: 1001,
          build: { commit: COMMIT_A, loadedBuildId: COMMIT_A, diskBuildId: head, drifted: false },
        };
      }
      if (method === "daemon.fleet.edge.sync") return { ok: true, ackCut: 5, lagRevisions: 0, mirrorOutcome: "clean" };
      throw new Error(`unexpected ${method}`);
    },
  });

  assert.equal(receipt.ok, false);
  assert.equal(receipt.outcome, "rolled_back");
  assert.equal(receipt.code, "edge_upgrade_install_failed");
  assert.equal(receipt.rolledBack, true);
  assert.equal(head, COMMIT_A);
});

test("explicit --rollback restores previousCommit recorded in edge-upgrade-state.json", async (t) => {
  const fixture = createCheckoutFixture(t);
  writeEdgeUpgradeState(fixture.userRoot, {
    schema: "edge-upgrade-state/v1",
    installRoot: fixture.installRoot,
    previousCommit: COMMIT_A,
    previousBranch: "main",
    targetCommit: COMMIT_B,
    repoId: fixture.repoId,
    updatedAt: new Date().toISOString(),
    outcome: "upgraded",
  });
  let head = COMMIT_B;
  let daemonBuild = COMMIT_B;
  const installerCalls: EdgeUpgradeInstallerInvocation[] = [];

  const receipt = await runEdgeUpgrade({
    rollback: true,
    userRoot: fixture.userRoot,
    daemonId: "test-daemon",
    rootDir: fixture.repoRoot,
    env: {},
    pollIntervalMs: 5,
    handoffTimeoutMs: 2_000,
    readDiskBuildId: () => head,
    runGit: async (_root, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${head}\n`, stderr: "" };
      if (args[0] === "symbolic-ref") return { stdout: "", stderr: "" };
      if (args[0] === "status") return { stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        const ref = args.at(-1)!.replace(/\^\{commit\}$/u, "");
        return { stdout: `${ref}\n`, stderr: "" };
      }
      if (args[0] === "checkout") {
        head = args.at(-1)!;
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    runInstaller: async (invocation) => {
      installerCalls.push(invocation);
      head = invocation.ref;
      daemonBuild = invocation.ref;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    requestDaemonRpc: async (_socket, method) => {
      if (method === "daemon.status") {
        return {
          ok: true,
          pid: 4004,
          build: { commit: daemonBuild, loadedBuildId: daemonBuild, diskBuildId: head, drifted: false },
        };
      }
      if (method === "daemon.fleet.edge.sync") return { ok: true, ackCut: 11, lagRevisions: 0, mirrorOutcome: "clean" };
      throw new Error(`unexpected ${method}`);
    },
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.outcome, "rolled_back");
  assert.equal(receipt.fromCommit, COMMIT_B);
  assert.equal(receipt.toCommit, COMMIT_A);
  assert.equal(installerCalls.length, 1);
  assert.equal(installerCalls[0]!.offline, true);
  assert.equal(installerCalls[0]!.ref, COMMIT_A);
});

test("checkEdgeUpgradeStatus detects center commit from protocol_version_unsupported failure text", async (t) => {
  const fixture = createCheckoutFixture(t);
  const status = await checkEdgeUpgradeStatus({
    installRoot: fixture.installRoot,
    userRoot: fixture.userRoot,
    daemonId: "test-daemon",
    rootDir: fixture.repoRoot,
    env: {},
    runGit: async () => ({ stdout: `${COMMIT_A}\n`, stderr: "" }),
    requestDaemonRpc: async (_socket, method) => {
      if (method === "daemon.status") {
        return {
          ok: true,
          pid: 1001,
          build: { commit: COMMIT_A, loadedBuildId: COMMIT_A, diskBuildId: COMMIT_A, drifted: false },
        };
      }
      if (method === "repo.fleet.overview.read") {
        return {
          ok: false,
          code: "protocol_version_unsupported",
          rejectionExplanation: `Fleet protocol 1 is incompatible; node edge-1 build=${COMMIT_A}, center build=${COMMIT_B}. Run ha edge upgrade.`,
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  });

  assert.equal(status.ok, true);
  assert.equal(status.channel, "source");
  assert.equal(status.localCommit, COMMIT_A);
  assert.equal(status.centerCommit, COMMIT_B);
  assert.equal(status.updateAvailable, true);
});
