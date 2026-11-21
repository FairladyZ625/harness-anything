// harness-test-tier: contract
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { parseGateWorkflow } from "../../gate-workflow-parser.mjs";
import {
  DEFAULT_DEADLINE_MS,
  evaluateLinuxArm64Smoke,
  isConfirmedDaemonGone,
  runBoundedCommandAsync,
  verifyDaemonStoppedAndCleanup,
  verifyHostArchitecture,
  verifyInstalledPackageBins,
  verifyNodePty,
  verifyNodeSqlite,
} from "../linux-arm64-smoke.mjs";
import { makeRepo } from "./helpers.mjs";

const rootDir = path.resolve(import.meta.dirname, "../../..");
const workflowText = readFileSync(path.join(rootDir, ".github/workflows/rewrite-ci.yml"), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const workflow = parseGateWorkflow(workflowText);
const workflowYaml = parse(workflowText);
const manifest = JSON.parse(readFileSync(path.join(rootDir, "tools/gate-manifest.json"), "utf8"));

function createFakeInstalledConsumer(consumerDir, { includeHaShim = true, includeHaMapping = true } = {}) {
  const cliDir = path.join(consumerDir, "node_modules/@harness-anything/cli");
  const daemonDir = path.join(consumerDir, "node_modules/@harness-anything/daemon");
  const binDir = path.join(consumerDir, "node_modules/.bin");
  mkdirSync(path.join(cliDir, "dist/cli/src"), { recursive: true });
  mkdirSync(path.join(daemonDir, "dist"), { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const cliBin = includeHaMapping
    ? { "harness-anything": "dist/cli/src/index.js", ha: "dist/cli/src/index.js" }
    : { "harness-anything": "dist/cli/src/index.js" };
  writeFileSync(
    path.join(cliDir, "package.json"),
    JSON.stringify({ name: "@harness-anything/cli", type: "module", bin: cliBin }),
  );
  writeFileSync(path.join(cliDir, "dist/cli/src/index.js"), "#!/usr/bin/env node\nconsole.log('ok');\n");
  writeFileSync(
    path.join(daemonDir, "package.json"),
    JSON.stringify({
      name: "@harness-anything/daemon",
      type: "module",
      bin: { "harness-anything-daemon": "dist/index.js" },
    }),
  );
  writeFileSync(path.join(daemonDir, "dist/index.js"), "#!/usr/bin/env node\nexport const ready = true;\n");

  const shims = ["harness-anything", "harness-anything-daemon", ...(includeHaShim ? ["ha"] : [])];
  for (const shim of shims) {
    const shimPath = path.join(binDir, shim);
    writeFileSync(shimPath, "#!/usr/bin/env sh\nexit 0\n");
    chmodSync(shimPath, 0o755);
  }
}

test("verifyHostArchitecture enforces Node >= 24 and optional linux-arm64 lock", () => {
  assert.equal(
    verifyHostArchitecture({ platform: "linux", arch: "arm64", nodeVersion: "24.13.0", requireLinuxArm64: true }).ok,
    true,
  );
  assert.equal(
    verifyHostArchitecture({ platform: "linux", arch: "x64", nodeVersion: "24.13.0", requireLinuxArm64: false }).ok,
    true,
  );

  const wrongArch = verifyHostArchitecture({
    platform: "linux",
    arch: "x64",
    nodeVersion: "24.13.0",
    requireLinuxArm64: true,
  });
  assert.equal(wrongArch.ok, false);
  assert.match(wrongArch.errors.join("\n"), /expected linux-arm64 runner, got linux-x64/u);

  const oldNode = verifyHostArchitecture({
    platform: "linux",
    arch: "arm64",
    nodeVersion: "22.12.0",
    requireLinuxArm64: true,
  });
  assert.equal(oldNode.ok, false);
  assert.match(oldNode.errors.join("\n"), /Node >= 24 is required/u);
});

test("verifyInstalledPackageBins verifies ha, harness-anything, and daemon bins and fails closed when ha is missing", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-installed-bins-"));
  try {
    const okDir = path.join(tempDir, "ok");
    createFakeInstalledConsumer(okDir);
    const okResult = await verifyInstalledPackageBins(okDir);
    assert.equal(okResult.ok, true, okResult.errors.join("\n"));
    assert.ok(okResult.cliBins?.ha.file.endsWith(path.join("node_modules", ".bin", "ha")));
    assert.ok(okResult.cliBins?.harnessAnything.file.endsWith(path.join("node_modules", ".bin", "harness-anything")));
    assert.ok(okResult.daemonBin?.file.endsWith(path.join("node_modules", ".bin", "harness-anything-daemon")));

    // Negative control: dist/ exists and harness-anything exists, but installed ha shim is deleted.
    const missingShimDir = path.join(tempDir, "missing-ha-shim");
    createFakeInstalledConsumer(missingShimDir, { includeHaShim: false });
    const missingShim = await verifyInstalledPackageBins(missingShimDir);
    assert.equal(missingShim.ok, false);
    assert.match(missingShim.errors.join("\n"), /installed public bin "ha" is missing/u);
    assert.equal(missingShim.cliBins, null);

    // Negative control: ha mapping removed from installed package.json bin even though dist/ exists.
    const missingMappingDir = path.join(tempDir, "missing-ha-mapping");
    createFakeInstalledConsumer(missingMappingDir, { includeHaMapping: false });
    const missingMapping = await verifyInstalledPackageBins(missingMappingDir);
    assert.equal(missingMapping.ok, false);
    assert.match(missingMapping.errors.join("\n"), /missing bin mapping "ha"/u);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyNodeSqlite and verifyNodePty enforce prebuilds and bounded PTY timeout", async () => {
  const sqlite = verifyNodeSqlite();
  assert.equal(sqlite.ok, true, sqlite.errors.join("\n"));

  const ptyOk = await verifyNodePty({ runLivePty: false });
  assert.equal(ptyOk.ok, true, ptyOk.errors.join("\n"));

  const emptyRoot = mkdtempSync(path.join(tmpdir(), "ha-empty-node-pty-"));
  try {
    const ptyMissing = await verifyNodePty({ packageRoot: emptyRoot, runLivePty: false });
    assert.equal(ptyMissing.ok, false);
    assert.match(ptyMissing.errors.join("\n"), /prebuilds\/linux-arm64\/pty\.node is missing/u);
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }

  let killed = false;
  const timedOut = await verifyNodePty({
    platform: "linux",
    arch: "arm64",
    runLivePty: true,
    timeoutMs: 20,
    spawnPty: () => ({
      onData() {},
      onExit() {},
      kill() {
        killed = true;
      },
    }),
  });
  assert.equal(timedOut.ok, false);
  assert.equal(killed, true, "hung PTY probe must be killed on timeout");
  assert.match(timedOut.errors.join("\n"), /timed out after 20ms/u);
});

test("F7 negative control: slow daemon build from clean no-dist (and pre-existing dist) consumes the single budget and times out", async () => {
  const slowDaemonScript = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`;
  const cleanRepo = makeRepo({
    "package.json": JSON.stringify({
      name: "arm64-f7-fixture",
      private: true,
      workspaces: ["packages/*"],
    }),
    "packages/cli/package.json": JSON.stringify({
      name: "@harness-anything/cli",
      version: "0.1.0",
      type: "module",
      dependencies: { "@harness-anything/daemon": "0.1.0" },
      scripts: { build: `${JSON.stringify(process.execPath)} -e "process.exit(0)"` },
    }),
    "packages/daemon/package.json": JSON.stringify({
      name: "@harness-anything/daemon",
      version: "0.1.0",
      type: "module",
      scripts: { build: slowDaemonScript },
    }),
  });

  assert.equal(existsSync(path.join(cleanRepo.rootDir, "packages/daemon/dist")), false);
  const cleanTimedOut = await evaluateLinuxArm64Smoke(cleanRepo.rootDir, {
    requireLinuxArm64: true,
    platform: "linux",
    arch: "arm64",
    nodeVersion: "24.13.0",
    deadlineMs: 600,
    runLivePty: false,
    runContractTests: false,
  });
  assert.equal(cleanTimedOut.ok, false);
  assert.equal(cleanTimedOut.stages.find((stage) => stage.name === "build-and-pack")?.ok, false);
  assert.match(cleanTimedOut.errors.join("\n"), /build @harness-anything\/daemon timed out|exceeded 600ms/u);

  // Pre-existing dist/index.js and dist/build-id.txt must never bypass daemon build timing.
  const prebuiltRepo = makeRepo({
    "package.json": JSON.stringify({
      name: "arm64-f7-prebuilt-fixture",
      private: true,
      workspaces: ["packages/*"],
    }),
    "packages/cli/package.json": JSON.stringify({
      name: "@harness-anything/cli",
      version: "0.1.0",
      type: "module",
      dependencies: { "@harness-anything/daemon": "0.1.0" },
      scripts: { build: `${JSON.stringify(process.execPath)} -e "process.exit(0)"` },
    }),
    "packages/daemon/package.json": JSON.stringify({
      name: "@harness-anything/daemon",
      version: "0.1.0",
      type: "module",
      scripts: { build: slowDaemonScript },
    }),
    "packages/daemon/dist/index.js": "export const stale = true;\n",
    "packages/daemon/dist/build-id.txt": "stale-commit\n",
  });
  const prebuiltTimedOut = await evaluateLinuxArm64Smoke(prebuiltRepo.rootDir, {
    requireLinuxArm64: true,
    platform: "linux",
    arch: "arm64",
    nodeVersion: "24.13.0",
    deadlineMs: 600,
    runLivePty: false,
    runContractTests: false,
  });
  assert.equal(prebuiltTimedOut.ok, false);
  assert.equal(
    existsSync(path.join(prebuiltRepo.rootDir, "packages/daemon/dist/build-id.txt")),
    false,
    "pre-existing daemon dist must be cleared before timed compilation",
  );
  assert.match(prebuiltTimedOut.errors.join("\n"), /build @harness-anything\/daemon timed out|exceeded 600ms/u);
});

test("F8 negative controls: runBoundedCommandAsync reaps hung process trees and cleanup failures are never dropped", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-f8-reap-"));
  const pidFile = path.join(tempDir, "pids.json");
  try {
    // Spawn a child that ignores SIGTERM and launches a sleeping grandchild in the same process group.
    const script = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      'process.on("SIGTERM", () => {});',
      'const grand = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grand: grand.pid }));`,
      "setInterval(() => {}, 1000);",
    ].join(" ");

    const timedOut = await runBoundedCommandAsync(process.execPath, ["-e", script], {
      cwd: tempDir,
      env: process.env,
      timeoutMs: 350,
      graceMs: 120,
      cleanupTimeoutMs: 3_000,
      label: "hung process tree probe",
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.terminatedCleanly, true, timedOut.errorMessage ?? "");
    assert.match(timedOut.errorMessage ?? "", /hung process tree probe timed out after 350ms/u);

    if (existsSync(pidFile)) {
      const { child: childPid, grand: grandPid } = JSON.parse(readFileSync(pidFile, "utf8"));
      for (const pid of [childPid, grandPid]) {
        assert.throws(
          () => process.kill(pid, 0),
          (error) => error?.code === "ESRCH",
          `pid ${pid} must not survive process-group timeout termination`,
        );
      }
    }

    // Strict gone-status check must reject arbitrary non-zero exits (e.g. crash/timeout) and accept only canonical gone codes.
    assert.equal(isConfirmedDaemonGone({ status: 1, timedOut: false, receipt: { code: "daemon_unavailable" } }), true);
    assert.equal(
      isConfirmedDaemonGone({ status: 1, timedOut: false, receipt: { code: "daemon_stopped_by_operator" } }),
      true,
    );
    assert.equal(isConfirmedDaemonGone({ status: 1, timedOut: false, receipt: { code: "daemon_stopping" } }), false);
    assert.equal(isConfirmedDaemonGone({ status: 1, timedOut: false, receipt: { code: "internal_error" } }), false);
    assert.equal(isConfirmedDaemonGone({ status: 1, timedOut: true, receipt: { code: "daemon_unavailable" } }), false);
    assert.equal(isConfirmedDaemonGone({ status: 1, timedOut: false, receipt: null }), false);

    // Failed daemon stop receipt during cleanup must fail closed and never be silently discarded.
    const emptyUserRoot = path.join(tempDir, "empty-user");
    mkdirSync(emptyUserRoot, { recursive: true });
    const cleanupFailed = await verifyDaemonStoppedAndCleanup({
      label: "edge",
      userRoot: emptyUserRoot,
      started: true,
      alreadyStopped: false,
      stopDaemon: async () => ({
        ok: false,
        status: 1,
        timedOut: false,
        stdout: "",
        stderr: "permission denied stopping daemon",
        receipt: { ok: false, code: "daemon_stop_refused" },
      }),
    });
    assert.equal(cleanupFailed.ok, false);
    assert.match(cleanupFailed.errors.join("\n"), /edge cleanup daemon stop failed.*daemon_stop_refused/u);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("evaluateLinuxArm64Smoke aggregates pack/install, cold CLI, daemon+edge smoke, cleanup errors, and per-stage timings", async () => {
  const repo = makeRepo({ "README.md": "ok\n" });
  const fakeBins = (tempRoot) => ({
    ha: { file: path.join(tempRoot, "node_modules/.bin/ha"), argsPrefix: [] },
    harnessAnything: { file: path.join(tempRoot, "node_modules/.bin/harness-anything"), argsPrefix: [] },
  });
  const ok = await evaluateLinuxArm64Smoke(repo.rootDir, {
    requireLinuxArm64: true,
    platform: "linux",
    arch: "arm64",
    nodeVersion: "24.13.0",
    runLivePty: false,
    runContractTests: false,
    runPackInstall: (_root, { tempRoot }) => ({
      ok: true,
      errors: [],
      checks: ["@harness-anything/cli: tarball verified"],
      consumerDir: tempRoot,
      cliBins: fakeBins(tempRoot),
      daemonBin: { file: path.join(tempRoot, "node_modules/.bin/harness-anything-daemon"), argsPrefix: [] },
    }),
    runColdSmoke: () => ({ ok: true, errors: [], checks: ["installed ha and harness-anything cold stub passed"] }),
    runDaemonEdgeSmoke: async () => ({
      ok: true,
      errors: [],
      checks: ["edge discriminating readback reflects live center delta"],
    }),
  });
  assert.equal(ok.ok, true, ok.errors.join("\n"));
  assert.equal(ok.deadlineMs, DEFAULT_DEADLINE_MS);
  assert.deepEqual(
    ok.stages.map((stage) => stage.name),
    ["host-arch", "native-modules", "build-and-pack", "packaged-cli-cold", "daemon-and-edge-smoke"],
  );
  assert.ok(ok.stages.every((stage) => stage.ok && stage.durationMs >= 0));
  assert.ok(ok.checks.some((line) => line.includes("edge discriminating readback")));

  // Negative control: cleanup callback failure must flip ok to false even when all stages passed.
  const cleanupErr = await evaluateLinuxArm64Smoke(repo.rootDir, {
    requireLinuxArm64: true,
    platform: "linux",
    arch: "arm64",
    nodeVersion: "24.13.0",
    runLivePty: false,
    runContractTests: false,
    runPackInstall: (_root, { tempRoot }) => ({
      ok: true,
      errors: [],
      checks: [],
      consumerDir: tempRoot,
      cliBins: fakeBins(tempRoot),
      daemonBin: null,
    }),
    runColdSmoke: () => ({ ok: true, errors: [], checks: [] }),
    runDaemonEdgeSmoke: async () => ({ ok: true, errors: [], checks: [] }),
    onCleanup: () => ({ ok: false, errors: ["orphan daemon refused stop"] }),
  });
  assert.equal(cleanupErr.ok, false);
  assert.match(cleanupErr.errors.join("\n"), /orphan daemon refused stop/u);

  // Negative control: edge smoke failure must fail the overall gate even when center & packaging pass.
  const edgeFailed = await evaluateLinuxArm64Smoke(repo.rootDir, {
    requireLinuxArm64: true,
    platform: "linux",
    arch: "arm64",
    nodeVersion: "24.13.0",
    runLivePty: false,
    runContractTests: false,
    runPackInstall: (_root, { tempRoot }) => ({
      ok: true,
      errors: [],
      checks: [],
      consumerDir: tempRoot,
      cliBins: fakeBins(tempRoot),
      daemonBin: null,
    }),
    runColdSmoke: () => ({ ok: true, errors: [], checks: [] }),
    runDaemonEdgeSmoke: async () => ({
      ok: false,
      errors: ["edge connects to local center over TLS and completes initial sync: exit 1"],
      checks: [],
    }),
  });
  assert.equal(edgeFailed.ok, false);
  assert.match(edgeFailed.errors.join("\n"), /edge connects to local center over TLS/u);
  assert.equal(edgeFailed.stages.find((stage) => stage.name === "daemon-and-edge-smoke")?.ok, false);

  // Negative control: tarball export failure must fail closed and skip executing broken consumer artifacts.
  let edgeCalledAfterPackFailure = false;
  const packFailed = await evaluateLinuxArm64Smoke(repo.rootDir, {
    requireLinuxArm64: true,
    platform: "linux",
    arch: "arm64",
    nodeVersion: "24.13.0",
    runLivePty: false,
    runContractTests: false,
    runPackInstall: () => ({
      ok: false,
      errors: ['@harness-anything/cli packed package.json is missing declared bin "ha"'],
      checks: [],
      consumerDir: null,
      cliBins: null,
      daemonBin: null,
    }),
    runColdSmoke: () => ({ ok: true, errors: [], checks: [] }),
    runDaemonEdgeSmoke: async () => {
      edgeCalledAfterPackFailure = true;
      return { ok: true, errors: [], checks: [] };
    },
  });
  assert.equal(packFailed.ok, false);
  assert.equal(edgeCalledAfterPackFailure, false);
  assert.match(packFailed.errors.join("\n"), /missing declared bin "ha"/u);
});

test("evaluateLinuxArm64Smoke enforces a single 180s end-to-end deadline and runs cleanup on overtime", async () => {
  const repo = makeRepo({ "README.md": "ok\n" });
  let clock = 1_000;
  let cleanedUp = false;
  const overtime = await evaluateLinuxArm64Smoke(repo.rootDir, {
    requireLinuxArm64: true,
    platform: "linux",
    arch: "arm64",
    nodeVersion: "24.13.0",
    deadlineMs: 180_000,
    now: () => clock,
    runLivePty: false,
    runContractTests: false,
    runPackInstall: (_root, { tempRoot }) => {
      clock += 181_000;
      return {
        ok: true,
        errors: [],
        checks: ["slow build"],
        consumerDir: tempRoot,
        cliBins: {
          ha: { file: path.join(tempRoot, "node_modules/.bin/ha"), argsPrefix: [] },
          harnessAnything: { file: path.join(tempRoot, "node_modules/.bin/harness-anything"), argsPrefix: [] },
        },
        daemonBin: null,
      };
    },
    runColdSmoke: () => ({ ok: true, errors: [], checks: [] }),
    runDaemonEdgeSmoke: async () => ({ ok: true, errors: [], checks: [] }),
    onCleanup: () => {
      cleanedUp = true;
    },
  });
  assert.equal(overtime.ok, false);
  assert.equal(cleanedUp, true, "cleanup must run when the end-to-end deadline is exceeded");
  assert.match(overtime.errors.join("\n"), /exceeded 180000ms end-to-end budget/u);
  assert.ok(overtime.stages.some((stage) => stage.name === "build-and-pack" && stage.durationMs === 181_000));
});

test("rewrite-ci and gate-manifest wire linux-arm64-smoke on ubuntu-24.04-arm with clean dist and outer cleanup headroom", () => {
  const job = workflow.get("linux-arm64-smoke");
  assert.ok(job, "rewrite-ci.yml must define linux-arm64-smoke");
  assert.equal(job.isPullRequestJob, true);
  assert.equal(job.isNonPullRequestJob, true);
  assert.deepEqual(job.nodeVersions, [24]);
  const rawJob = workflowYaml.jobs["linux-arm64-smoke"];
  assert.equal(rawJob["runs-on"], "ubuntu-24.04-arm");

  const installIndex = rawJob.steps.findIndex((step) => step.run === "npm ci");
  const gateIndex = rawJob.steps.findIndex(
    (step) => step.run === "node tools/run-manifest-gates.mjs --workflow-job linux-arm64-smoke",
  );
  assert.ok(installIndex >= 0, "linux-arm64-smoke must run its own arm64 npm ci");
  assert.ok(gateIndex > installIndex, "linux-arm64-smoke must run the manifest gate step after npm ci");

  const gateStep = rawJob.steps[gateIndex];
  const internalBudgetMinutes = DEFAULT_DEADLINE_MS / 60_000;
  assert.ok(
    gateStep["timeout-minutes"] > internalBudgetMinutes,
    "step timeout must exceed the internal 180s budget so internal timeout and cleanup finish before GitHub cancellation",
  );
  assert.ok(
    rawJob["timeout-minutes"] > gateStep["timeout-minutes"] && rawJob["timeout-minutes"] <= 8,
    "job timeout must exceed step timeout for npm ci + cleanup while remaining tighter than 10m",
  );
  assert.ok(job.runCommands.includes("npm ci"), "linux-arm64-smoke must run its own arm64 npm ci");
  assert.ok(job.blockingRunCommands.includes("node tools/run-manifest-gates.mjs --workflow-job linux-arm64-smoke"));

  const gate = manifest.gates.find((candidate) => candidate.id === "linux-arm64-smoke");
  assert.ok(gate, "gate-manifest.json must declare linux-arm64-smoke");
  assert.equal(gate.command, "node tools/gates/linux-arm64-smoke.mjs --require-linux-arm64");
  assert.equal(gate.category, "smoke");
  assert.equal(gate.tier, "pr-advisory");
  assert.deepEqual(gate.executionSurfaces.rewriteCi.pullRequestJobs, ["linux-arm64-smoke"]);
  assert.deepEqual(gate.executionSurfaces.rewriteCi.nonPullRequestJobs, ["linux-arm64-smoke"]);
  assert.equal(manifest.surfaces.branchProtection.requiredContexts.includes("linux-arm64-smoke"), false);
});
