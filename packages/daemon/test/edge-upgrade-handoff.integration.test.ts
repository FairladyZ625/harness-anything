// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo } from "@harness-anything/storage";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { runEdgeUpgrade, type EdgeUpgradeInstallerInvocation } from "../src/daemon-host/client/edge-upgrade.ts";
import { writeFleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import { daemonProcessAlive } from "../src/daemon-host/daemon-singleton.ts";
import { startDaemon, type RunningDaemon } from "../src/daemon-host/runtime.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Edge Test",
      GIT_AUTHOR_EMAIL: "edge-test@example.invalid",
      GIT_COMMITTER_NAME: "Edge Test",
      GIT_COMMITTER_EMAIL: "edge-test@example.invalid",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  }).trim();
}

function createRealCheckout(root: string): {
  readonly installRoot: string;
  readonly runtimeFile: string;
  readonly buildIdPath: string;
  readonly commitA: string;
  readonly commitB: string;
} {
  const installRoot = path.join(root, "source-install");
  mkdirSync(path.join(installRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(installRoot, "packages", "daemon", "dist"), { recursive: true });
  writeFileSync(path.join(installRoot, "scripts", "install-source.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(installRoot, "scripts", "install-source.ps1"), "exit 0\n");
  writeFileSync(path.join(installRoot, "version.txt"), "v1\n");
  writeFileSync(path.join(installRoot, ".gitignore"), "packages/daemon/dist/\n");
  git(installRoot, ["init", "-b", "main"]);
  git(installRoot, ["add", "scripts/install-source.sh", "scripts/install-source.ps1", "version.txt", ".gitignore"]);
  git(installRoot, ["commit", "-m", "chore: edge commit A"]);
  const commitA = git(installRoot, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(installRoot, "version.txt"), "v2\n");
  git(installRoot, ["add", "version.txt"]);
  git(installRoot, ["commit", "-m", "chore: edge commit B"]);
  const commitB = git(installRoot, ["rev-parse", "HEAD"]);
  git(installRoot, ["checkout", "--detach", commitA]);
  const runtimeFile = path.join(installRoot, "packages", "daemon", "dist", "index.js");
  const buildIdPath = path.join(installRoot, "packages", "daemon", "dist", "build-id.txt");
  writeFileSync(runtimeFile, "// built daemon runtime marker\n");
  writeFileSync(buildIdPath, `${commitA}\n`);
  return { installRoot, runtimeFile, buildIdPath, commitA, commitB };
}

function spawnDetachedInFlightWorker(): ChildProcess {
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000);"], {
    detached: true,
    stdio: "ignore",
  });
  worker.unref();
  assert.ok(typeof worker.pid === "number" && worker.pid > 0, "detached worker must have a pid");
  return worker;
}

function terminateWorker(worker: ChildProcess | undefined): void {
  if (!worker?.pid) return;
  try {
    process.kill(worker.pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

function setupEdgeWorkspace(root: string, userRoot: string, repoId: string): string {
  const repoRoot = path.join(root, "edge-workspace");
  mkdirSync(path.join(repoRoot, "harness"), { recursive: true });
  git(repoRoot, ["init", "-b", "main"]);
  writeFileSync(
    path.join(repoRoot, "harness", "harness.yaml"),
    `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  writeFileSync(path.join(repoRoot, "README.md"), "edge workspace\n");
  git(repoRoot, ["add", "README.md", "harness/harness.yaml"]);
  git(repoRoot, ["commit", "-m", "init edge workspace"]);
  signInPolicyTestUser(userRoot, "operator", [repoId], "admin");
  registerDaemonRepo({ canonicalRoot: repoRoot, repoId, userRoot, mode: "remote-edge" });
  const caPath = path.join(userRoot, "fleet", "edge", repoId, "fleet-center-ca.pem");
  mkdirSync(path.dirname(caPath), { recursive: true });
  writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n");
  writeFleetEdgeConfig(userRoot, repoId, {
    repoId,
    host: "127.0.0.1",
    port: 7545,
    caPath,
    nodeId: "edge-vm-1",
    credential: "machine-cred-1",
    viewRoot: path.join(userRoot, "views"),
    quotaBytes: 4 * 1024 * 1024,
  });
  return repoRoot;
}

test(
  "runEdgeUpgrade performs real build_superseded daemon handoff, confirms sync, and preserves in-flight detached runtime",
  { timeout: 60_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-edge-upgrade-e2e-"));
    const userRoot = path.join(parent, "user");
    const repoId = "edge-handoff";
    const daemonId = "edge-handoff-daemon";
    const checkout = createRealCheckout(parent);
    const repoRoot = setupEdgeWorkspace(parent, userRoot, repoId);
    const worker = spawnDetachedInFlightWorker();
    const adoptedInGenerations: string[] = [];
    const syncCalls: string[] = [];
    let activeDaemon: RunningDaemon | undefined;
    let generation = 0;

    t.after(async () => {
      terminateWorker(worker);
      await activeDaemon?.stop();
      await removeTempRepository(parent);
    });

    const startGeneration = async (): Promise<RunningDaemon> => {
      const currentGen = ++generation;
      const diskBuild = readFileSync(checkout.buildIdPath, "utf8").trim();
      const started = await startDaemon({
        daemonId,
        userRoot,
        runtimeFile: checkout.runtimeFile,
        onSupersededExit: async () => {
          // Simulate supervised/unsupervised successor spawning on the new disk build.
          activeDaemon = await startGeneration();
        },
        openCell: async (input) => {
          // Verify detached worker is still alive and re-adopted on every replacement generation.
          if (worker.pid && daemonProcessAlive(worker.pid)) {
            adoptedInGenerations.push(`gen${currentGen}:${diskBuild.slice(0, 8)}:${worker.pid}`);
          }
          return openBootstrappedRepoCell(input);
        },
      });
      if (!("stop" in started)) {
        throw new Error(`generation ${currentGen} failed to start: ${JSON.stringify(started)}`);
      }
      activeDaemon = started;
      return started;
    };

    activeDaemon = await startGeneration();
    const installerInvocations: EdgeUpgradeInstallerInvocation[] = [];

    const receipt = await runEdgeUpgrade({
      installRoot: checkout.installRoot,
      userRoot,
      daemonId,
      rootDir: repoRoot,
      toRef: checkout.commitB,
      offline: true,
      env: {},
      pollIntervalMs: 40,
      handoffTimeoutMs: 15_000,
      runInstaller: async (invocation) => {
        installerInvocations.push(invocation);
        // Simulate scripts/install-source writing dist/build-id.txt for the checked-out commit.
        const head = git(invocation.installRoot, ["rev-parse", "HEAD"]);
        writeFileSync(checkout.buildIdPath, `${head}\n`);
        return { exitCode: 0, stdout: "built", stderr: "" };
      },
      requestDaemonRpc: async (socketPath, method, params, timeoutMs, responseTimeoutMs, reportStaleBuild) => {
        if (method === "daemon.fleet.edge.sync") {
          const currentBuild = readFileSync(checkout.buildIdPath, "utf8").trim();
          syncCalls.push(currentBuild);
          return { ok: true, ackCut: 108, lagRevisions: 0, mirrorOutcome: "materialized" };
        }
        const { requestDaemonJsonRpcAt } = await import("../src/daemon-host/client/local-json-rpc-client.ts");
        return requestDaemonJsonRpcAt(
          socketPath,
          method,
          params,
          timeoutMs,
          responseTimeoutMs,
          undefined,
          reportStaleBuild,
        );
      },
    });

    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.outcome, "upgraded");
    assert.equal(receipt.fromCommit, checkout.commitA);
    assert.equal(receipt.toCommit, checkout.commitB);
    assert.equal(receipt.daemonBuildId, checkout.commitB);
    assert.equal(git(checkout.installRoot, ["rev-parse", "HEAD"]), checkout.commitB);
    assert.equal(installerInvocations.length, 1);
    assert.equal(installerInvocations[0]!.ref, checkout.commitB);
    assert.deepEqual(syncCalls, [checkout.commitB]);
    assert.deepEqual(receipt.syncedRepos, [{ repoId, revision: 108, lagRevisions: 0, mirrorOutcome: "materialized" }]);
    assert.equal(generation, 2, "real build_superseded handoff must launch generation 2");
    assert.equal(daemonProcessAlive(worker.pid!), true, "in-flight detached worker must survive daemon handoff");
    assert.ok(
      adoptedInGenerations.some((entry) => entry.startsWith(`gen2:${checkout.commitB.slice(0, 8)}:${worker.pid}`)),
      `replacement daemon must re-adopt live worker; saw ${JSON.stringify(adoptedInGenerations)}`,
    );
  },
);

test(
  "runEdgeUpgrade automatically rolls back real git checkout and daemon via build_superseded when first sync fails",
  { timeout: 60_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-edge-upgrade-rollback-e2e-"));
    const userRoot = path.join(parent, "user");
    const repoId = "edge-rollback";
    const daemonId = "edge-rollback-daemon";
    const checkout = createRealCheckout(parent);
    const repoRoot = setupEdgeWorkspace(parent, userRoot, repoId);
    const worker = spawnDetachedInFlightWorker();
    let activeDaemon: RunningDaemon | undefined;
    let generation = 0;
    const syncAttempts: string[] = [];

    t.after(async () => {
      terminateWorker(worker);
      await activeDaemon?.stop();
      await removeTempRepository(parent);
    });

    const startGeneration = async (): Promise<RunningDaemon> => {
      generation += 1;
      const started = await startDaemon({
        daemonId,
        userRoot,
        runtimeFile: checkout.runtimeFile,
        onSupersededExit: async () => {
          activeDaemon = await startGeneration();
        },
        openCell: (input) => openBootstrappedRepoCell(input),
      });
      if (!("stop" in started)) {
        throw new Error(`rollback generation failed to start: ${JSON.stringify(started)}`);
      }
      activeDaemon = started;
      return started;
    };

    activeDaemon = await startGeneration();

    const receipt = await runEdgeUpgrade({
      installRoot: checkout.installRoot,
      userRoot,
      daemonId,
      rootDir: repoRoot,
      toRef: checkout.commitB,
      offline: true,
      env: {},
      pollIntervalMs: 40,
      handoffTimeoutMs: 15_000,
      runInstaller: async (invocation) => {
        const head = git(invocation.installRoot, ["rev-parse", "HEAD"]);
        writeFileSync(checkout.buildIdPath, `${head}\n`);
        return { exitCode: 0, stdout: "built", stderr: "" };
      },
      requestDaemonRpc: async (socketPath, method, params, timeoutMs, responseTimeoutMs, reportStaleBuild) => {
        if (method === "daemon.fleet.edge.sync") {
          const currentBuild = readFileSync(checkout.buildIdPath, "utf8").trim();
          syncAttempts.push(currentBuild);
          if (currentBuild === checkout.commitB) {
            return {
              ok: false,
              code: "edge_upgrade_required",
              error: { code: "edge_upgrade_required", hint: "target build rejected by center" },
            };
          }
          return { ok: true, ackCut: 55, lagRevisions: 0, mirrorOutcome: "clean" };
        }
        const { requestDaemonJsonRpcAt } = await import("../src/daemon-host/client/local-json-rpc-client.ts");
        return requestDaemonJsonRpcAt(
          socketPath,
          method,
          params,
          timeoutMs,
          responseTimeoutMs,
          undefined,
          reportStaleBuild,
        );
      },
    });

    assert.equal(receipt.ok, false);
    assert.equal(receipt.outcome, "rolled_back");
    assert.equal(receipt.rolledBack, true);
    assert.equal(receipt.rollbackSyncOk, true);
    assert.equal(receipt.code, "edge_upgrade_required");
    assert.equal(receipt.toCommit, checkout.commitA);
    assert.equal(receipt.daemonBuildId, checkout.commitA);
    assert.equal(git(checkout.installRoot, ["rev-parse", "HEAD"]), checkout.commitA);
    assert.deepEqual(syncAttempts, [checkout.commitB, checkout.commitA]);
    assert.equal(generation, 3, "failed sync on gen2 must trigger build_superseded rollback to gen3");
    assert.equal(daemonProcessAlive(worker.pid!), true, "in-flight worker must survive upgrade + rollback handoffs");
  },
);
