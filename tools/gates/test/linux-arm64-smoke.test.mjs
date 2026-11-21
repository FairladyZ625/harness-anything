// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { smokeIdentity } from "../../fixtures/smoke-identity.mjs";
import { parseGateWorkflow } from "../../gate-workflow-parser.mjs";
import {
  DEFAULT_DEADLINE_MS,
  evaluateLinuxArm64Smoke,
  isConfirmedDaemonGone,
  packAndInstallArm64Packages,
  runBoundedCommandAsync,
  runNativeModulesProbeInSubprocess,
  runWithResourceCleanups,
  spawnOwnedDaemon,
  verifyDaemonStoppedAndCleanup,
  verifyHostArchitecture,
  verifyInstalledPackageBins,
  verifyNodePty,
  verifyNodeSqlite,
  waitForOwnedDaemonReady,
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
  const sqlite = await verifyNodeSqlite();
  assert.equal(sqlite.ok, true, sqlite.errors.join("\n"));

  const ptyOk = await verifyNodePty({ runLivePty: false });
  assert.equal(ptyOk.ok, true, ptyOk.errors.join("\n"));

  const subOk = await runNativeModulesProbeInSubprocess({
    rootDir,
    platform: "linux",
    arch: "arm64",
    runLivePty: false,
    timeoutMs: 15_000,
  });
  assert.equal(subOk.ok, true, subOk.errors.join("\n"));
  assert.ok(subOk.checks.some((line) => line.includes("node:sqlite DatabaseSync round-trip passed")));

  const smokeSource = readFileSync(path.join(rootDir, "tools/gates/linux-arm64-smoke.mjs"), "utf8");
  assert.doesNotMatch(
    smokeSource,
    /^import\s+.*from\s+["']node:sqlite["']/mu,
    "node:sqlite must not be loaded at module top-level before the 180s budget is initialized",
  );

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
    deadlineMs: 1_500,
    runLivePty: false,
    runContractTests: false,
  });
  assert.equal(cleanTimedOut.ok, false);
  assert.equal(cleanTimedOut.stages.find((stage) => stage.name === "build-and-pack")?.ok, false);
  assert.match(cleanTimedOut.errors.join("\n"), /build @harness-anything\/daemon timed out|exceeded 1500ms/u);

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
    deadlineMs: 1_500,
    runLivePty: false,
    runContractTests: false,
  });
  assert.equal(prebuiltTimedOut.ok, false);
  assert.equal(
    existsSync(path.join(prebuiltRepo.rootDir, "packages/daemon/dist/build-id.txt")),
    false,
    "pre-existing daemon dist must be cleared before timed compilation",
  );
  assert.match(prebuiltTimedOut.errors.join("\n"), /build @harness-anything\/daemon timed out|exceeded 1500ms/u);
});

test("F8/F12 negative controls: runBoundedCommandAsync reaps hung process trees including early-exiting group leaders", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-f12-reap-"));
  const bothPidFile = path.join(tempDir, "both-pids.json");
  const earlyLeaderPidFile = path.join(tempDir, "early-leader-pids.json");
  try {
    // Case 1: Both leader and grandchild ignore SIGTERM; grandchild writes both PIDs atomically
    // and emits a readiness marker after installing its SIGTERM handler.
    const bothGrandScript = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `const tmp = ${JSON.stringify(`${bothPidFile}.tmp`)};`,
      `fs.writeFileSync(tmp, JSON.stringify({ child: Number(process.env.PARENT_PID), grand: process.pid }));`,
      `fs.renameSync(tmp, ${JSON.stringify(bothPidFile)});`,
      'process.stdout.write("BOTH_READY\\n");',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const bothLeaderScript = [
      'const { spawn } = require("node:child_process");',
      'process.on("SIGTERM", () => {});',
      `spawn(process.execPath, ["-e", ${JSON.stringify(bothGrandScript)}], { stdio: "inherit", env: { ...process.env, PARENT_PID: String(process.pid) } });`,
      "setInterval(() => {}, 1000);",
    ].join(" ");

    // Case 2: Process-group leader exits 0 immediately after spawning a SIGTERM-ignoring grandchild
    // that inherits stdout/stderr and keeps pipes open past timeout.
    const orphanGrandScript = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `const tmp = ${JSON.stringify(`${earlyLeaderPidFile}.tmp`)};`,
      `fs.writeFileSync(tmp, JSON.stringify({ leader: Number(process.env.LEADER_PID), grand: process.pid }));`,
      `fs.renameSync(tmp, ${JSON.stringify(earlyLeaderPidFile)});`,
      'process.stdout.write("GRANDCHILD_SURVIVES_LEADER\\n");',
      'process.stderr.write("GRANDCHILD_STDERR\\n");',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const earlyLeaderScript = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(orphanGrandScript)}], { stdio: "inherit", env: { ...process.env, LEADER_PID: String(process.pid) } });`,
      "process.exit(0);",
    ].join(" ");

    const [bothTimedOut, earlyLeaderTimedOut] = await Promise.all([
      runBoundedCommandAsync(process.execPath, ["-e", bothLeaderScript], {
        cwd: tempDir,
        env: process.env,
        timeoutMs: 1_500,
        graceMs: 150,
        cleanupTimeoutMs: 3_000,
        label: "hung process tree probe",
      }),
      runBoundedCommandAsync(process.execPath, ["-e", earlyLeaderScript], {
        cwd: tempDir,
        env: process.env,
        timeoutMs: 1_500,
        graceMs: 150,
        cleanupTimeoutMs: 3_000,
        label: "early-exit leader probe",
      }),
    ]);

    assert.equal(bothTimedOut.ok, false);
    assert.equal(bothTimedOut.timedOut, true);
    assert.equal(bothTimedOut.terminatedCleanly, true, bothTimedOut.errorMessage ?? "");
    assert.match(bothTimedOut.errorMessage ?? "", /hung process tree probe timed out after 1500ms/u);
    assert.match(
      bothTimedOut.stdout,
      /BOTH_READY/u,
      "grandchild must start and install SIGTERM handler before timeout",
    );
    assert.equal(existsSync(bothPidFile), true, "both parent and grandchild PIDs must be written before timeout");
    const { child: childPid, grand: grandPid } = JSON.parse(readFileSync(bothPidFile, "utf8"));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.ok(Number.isInteger(grandPid) && grandPid > 0 && grandPid !== childPid);
    for (const pid of [childPid, grandPid]) {
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error?.code === "ESRCH",
        `pid ${pid} must not survive process-group timeout termination`,
      );
    }
    assert.throws(
      () => process.kill(-childPid, 0),
      (error) => error?.code === "ESRCH",
      `process group -${childPid} must not survive timeout termination`,
    );

    assert.equal(earlyLeaderTimedOut.ok, false);
    assert.equal(earlyLeaderTimedOut.timedOut, true);
    assert.equal(earlyLeaderTimedOut.status, 0, "process-group leader must exit 0 before timeout");
    assert.equal(earlyLeaderTimedOut.terminatedCleanly, true, earlyLeaderTimedOut.errorMessage ?? "");
    assert.match(earlyLeaderTimedOut.stdout, /GRANDCHILD_SURVIVES_LEADER/u);
    assert.match(earlyLeaderTimedOut.stderr, /GRANDCHILD_STDERR/u);
    assert.equal(existsSync(earlyLeaderPidFile), true, "surviving grandchild must write PIDs before timeout");
    const { leader: leaderPid, grand: survivingGrandPid } = JSON.parse(readFileSync(earlyLeaderPidFile, "utf8"));
    assert.ok(Number.isInteger(leaderPid) && leaderPid > 0);
    assert.ok(Number.isInteger(survivingGrandPid) && survivingGrandPid > 0 && survivingGrandPid !== leaderPid);
    for (const pid of [leaderPid, survivingGrandPid]) {
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error?.code === "ESRCH",
        `pid ${pid} must be reaped via -pgid even when group leader exited early`,
      );
    }
    assert.throws(
      () => process.kill(-leaderPid, 0),
      (error) => error?.code === "ESRCH",
      `process group -${leaderPid} must be gone after early-leader cleanup`,
    );

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

test("F13 negative controls: smoke-identity init failure closes HTTPS worker, throwing edge cleanup never skips center/identity or drops errors, and parallel pack settles siblings", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-f13-cleanup-"));
  try {
    // (a) smoke-identity passwordFile write failure after HTTPS worker starts must terminate the worker cleanly.
    const tlsKey = path.join(tempDir, "localhost.key");
    const tlsCert = path.join(tempDir, "localhost.crt");
    const certGen = await runBoundedCommandAsync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        tlsKey,
        "-out",
        tlsCert,
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
      ],
      { cwd: tempDir, env: process.env, timeoutMs: 15_000, label: "f13 test tls cert" },
    );
    assert.equal(certGen.ok, true, certGen.errorMessage ?? "");
    const tls = { key: readFileSync(tlsKey, "utf8"), cert: readFileSync(tlsCert, "utf8") };

    const blockedRoot = path.join(tempDir, "not-a-directory");
    writeFileSync(blockedRoot, "file-blocks-password-write\n");
    const workersBefore = process.getActiveResourcesInfo().filter((name) => name === "Worker").length;
    await assert.rejects(
      () => smokeIdentity(blockedRoot, "arm64-f13-init-fail", { tls, timeoutMs: 10_000 }),
      /ENOTDIR|ENOENT/u,
    );
    const workersAfterInitFail = process.getActiveResourcesInfo().filter((name) => name === "Worker").length;
    assert.equal(
      workersAfterInitFail,
      workersBefore,
      "HTTPS smokeIdentity worker thread must be terminated when passwordFile write fails",
    );

    // (b) Throwing stopDaemon during verifyDaemonStoppedAndCleanup must still record the error without throwing,
    // and Edge cleanup throwing during main smoke failure must still run Center + identity worker cleanup AND preserve both errors.
    const edgeThrowUser = path.join(tempDir, "edge-throw-user");
    mkdirSync(edgeThrowUser, { recursive: true });
    const stopThrew = await verifyDaemonStoppedAndCleanup({
      label: "edge",
      userRoot: edgeThrowUser,
      started: true,
      alreadyStopped: false,
      stopDaemon: async () => {
        throw new Error("edge stop transport failed");
      },
    });
    assert.equal(stopThrew.ok, false);
    assert.match(stopThrew.errors.join("\n"), /edge cleanup daemon stop failed: edge stop transport failed/u);

    const identityDir = path.join(tempDir, "live-identity");
    mkdirSync(identityDir, { recursive: true });
    const liveIdentity = await smokeIdentity(identityDir, "arm64-f13-smoke-fail", { tls, timeoutMs: 10_000 });
    let centerCleaned = false;
    let identityClosed = false;
    const repo = makeRepo({ "README.md": "ok\n" });
    const fakeBins = (root) => ({
      ha: { file: path.join(root, "node_modules/.bin/ha"), argsPrefix: [] },
      harnessAnything: { file: path.join(root, "node_modules/.bin/harness-anything"), argsPrefix: [] },
    });
    const smokeWithCleanupThrow = await evaluateLinuxArm64Smoke(repo.rootDir, {
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
      runDaemonEdgeSmoke: () =>
        runWithResourceCleanups(async () => {
          throw new Error("edge join TLS handshake failed");
        }, [
          {
            label: "edge daemon cleanup",
            run: async () => {
              throw new Error("edge stop exploded");
            },
          },
          {
            label: "center daemon cleanup",
            run: async () => {
              centerCleaned = true;
              return { ok: true, errors: [] };
            },
          },
          {
            label: "identity worker close",
            run: async () => {
              await liveIdentity.close();
              identityClosed = true;
            },
          },
        ]),
    });
    assert.equal(centerCleaned, true, "Center cleanup must still run after Edge cleanup throws");
    assert.equal(identityClosed, true, "Identity worker close must still run after Edge cleanup throws");
    assert.equal(
      process.getActiveResourcesInfo().filter((name) => name === "Worker").length,
      workersBefore,
      "Live HTTPS identity worker must be terminated after throwing Edge cleanup",
    );
    assert.equal(smokeWithCleanupThrow.ok, false);
    assert.match(smokeWithCleanupThrow.errors.join("\n"), /edge join TLS handshake failed/u);
    assert.match(smokeWithCleanupThrow.errors.join("\n"), /edge daemon cleanup failed: edge stop exploded/u);

    // (c) Parallel pack settles sibling branches before rejecting so outer finally never tears down staging early.
    const parallelRepo = makeRepo({
      "package.json": JSON.stringify({ name: "arm64-f13-pack-fixture", private: true, workspaces: ["packages/*"] }),
      "packages/cli/package.json": JSON.stringify({
        name: "@harness-anything/cli",
        version: "0.1.0",
        type: "module",
        files: ["dist"],
        publishConfig: { exports: { ".": "./dist/index.js" } },
        dependencies: { "@harness-anything/daemon": "0.1.0" },
        scripts: {
          build: `${JSON.stringify(process.execPath)} -e "const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/index.js','export const ok = true;\\n');"`,
        },
      }),
      "packages/daemon/package.json": JSON.stringify({
        name: "@harness-anything/daemon",
        version: "0.1.0",
        type: "module",
        files: ["missing-nonexistent-dir"],
        scripts: {
          build: `${JSON.stringify(process.execPath)} -e "const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/index.js',''); fs.writeFileSync('dist/build-id.txt','ok');"`,
        },
      }),
    });
    const siblingPackRoot = path.join(tempDir, "parallel-pack-temp");
    mkdirSync(siblingPackRoot, { recursive: true });
    let cliSiblingVerified = false;
    const budget = {
      remainingMs: () => 20_000,
    };
    await assert.rejects(
      () =>
        packAndInstallArm64Packages(parallelRepo.rootDir, {
          tempRoot: siblingPackRoot,
          budget,
          verifyTarball: (_tarballPath, manifestObj) => {
            if (manifestObj.name === "@harness-anything/cli") {
              cliSiblingVerified = true;
            }
            return [];
          },
        }),
      /ENOENT/u,
    );
    assert.equal(
      cliSiblingVerified,
      true,
      "sibling pack branch must settle completely before packAndInstallArm64Packages rejects",
    );
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

test("F15 negative control: standalone top-level-await entry keeps event loop alive through SIGKILL process-group exit poll, receipt emission, and tempRoot cleanup", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-f15-standalone-"));
  const pidFile = path.join(tempDir, "f15-pids.json");
  const repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  try {
    const smokeModuleUrl = pathToFileURL(path.join(rootDir, "tools/gates/linux-arm64-smoke.mjs")).href;
    const orphanGrandScript = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `const tmp = ${JSON.stringify(`${pidFile}.tmp`)};`,
      `fs.writeFileSync(tmp, JSON.stringify({ leader: Number(process.env.LEADER_PID), grand: process.pid }));`,
      `fs.renameSync(tmp, ${JSON.stringify(pidFile)});`,
      'process.stdout.write("F15_GRANDCHILD_READY\\n");',
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const earlyLeaderScript = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(orphanGrandScript)}], { stdio: "inherit", env: { ...process.env, LEADER_PID: String(process.pid) } });`,
      "process.exit(0);",
    ].join(" ");
    const standaloneScript = `
      import { evaluateLinuxArm64Smoke, runBoundedCommandAsync } from ${JSON.stringify(smokeModuleUrl)};
      let observedTempRoot = null;
      let timedOutReceipt = null;
      const result = await evaluateLinuxArm64Smoke(${JSON.stringify(repoDir)}, {
        requireLinuxArm64: true,
        platform: "linux",
        arch: "arm64",
        nodeVersion: "24.13.0",
        runLivePty: false,
        runContractTests: false,
        runNativeModules: () => ({ ok: true, checks: [], errors: [] }),
        runPackInstall: async (_root, { tempRoot }) => {
          observedTempRoot = tempRoot;
          timedOutReceipt = await runBoundedCommandAsync(process.execPath, ["-e", ${JSON.stringify(earlyLeaderScript)}], {
            cwd: ${JSON.stringify(tempDir)},
            env: process.env,
            timeoutMs: 800,
            graceMs: 150,
            cleanupTimeoutMs: 3000,
            label: "f15 standalone early-leader probe",
          });
          return {
            ok: false,
            errors: [timedOutReceipt.errorMessage ?? "expected timeout"],
            checks: [],
            consumerDir: null,
            cliBins: null,
            daemonBin: null,
          };
        },
      });
      process.stdout.write("__F15_RECEIPT__=" + JSON.stringify({
        ok: result.ok,
        errors: result.errors,
        stages: result.stages,
        observedTempRoot,
        timedOut: timedOutReceipt?.timedOut,
        terminatedCleanly: timedOutReceipt?.terminatedCleanly,
        status: timedOutReceipt?.status,
      }) + "\\n");
    `;
    const run = await runBoundedCommandAsync(process.execPath, ["--input-type=module", "-e", standaloneScript], {
      cwd: tempDir,
      env: process.env,
      timeoutMs: 15_000,
      label: "F15 standalone entry",
    });
    assert.equal(run.timedOut, false, run.errorMessage ?? "");
    assert.equal(run.status, 0, `standalone process must settle top-level await cleanly; stderr=${run.stderr}`);
    assert.doesNotMatch(run.stderr, /Detected unsettled top-level await/iu);
    const line = run.stdout
      .split(/\r?\n/u)
      .reverse()
      .find((entry) => entry.startsWith("__F15_RECEIPT__="));
    assert.ok(line, `standalone entry must emit receipt after cleanup; stdout=${run.stdout} stderr=${run.stderr}`);
    const payload = JSON.parse(line.slice("__F15_RECEIPT__=".length));
    assert.equal(payload.ok, false);
    assert.equal(payload.timedOut, true);
    assert.equal(payload.status, 0, "group leader must have exited 0 before timeout");
    assert.equal(payload.terminatedCleanly, true, "process group must be confirmed reaped before receipt emission");
    assert.match(payload.errors.join("\n"), /f15 standalone early-leader probe timed out after 800ms/u);
    assert.ok(typeof payload.observedTempRoot === "string" && payload.observedTempRoot.length > 0);
    assert.equal(existsSync(payload.observedTempRoot), false, "outer finally must remove tempRoot after SIGKILL poll");
    assert.equal(existsSync(pidFile), true, "grandchild must write both PIDs before timeout");
    const { leader: leaderPid, grand: grandPid } = JSON.parse(readFileSync(pidFile, "utf8"));
    for (const pid of [leaderPid, grandPid]) {
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error?.code === "ESRCH",
        `pid ${pid} must be gone after standalone cleanup`,
      );
    }
    assert.throws(
      () => process.kill(-leaderPid, 0),
      (error) => error?.code === "ESRCH",
      `process group -${leaderPid} must be gone after standalone cleanup`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("F16 negative controls: paused daemon before pidfile publication is reaped by owned process group on timeout and unowned surviving pids fail closed without blind kill", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-f16-daemon-ownership-"));
  const probePidFile = path.join(tempDir, "paused-daemon-pid.json");
  const fakeDaemonScript = path.join(tempDir, "paused-daemon.mjs");
  let foreignSleeper = null;
  try {
    writeFileSync(
      fakeDaemonScript,
      [
        "#!/usr/bin/env node",
        'import { renameSync, writeFileSync } from "node:fs";',
        'process.on("SIGTERM", () => {});',
        `const tmp = ${JSON.stringify(`${probePidFile}.tmp`)};`,
        `writeFileSync(tmp, JSON.stringify({ pid: process.pid }));`,
        `renameSync(tmp, ${JSON.stringify(probePidFile)});`,
        "// Intentionally pause before singleton lock or daemon-default.pid publication.",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    chmodSync(fakeDaemonScript, 0o755);

    const repo = makeRepo({ "README.md": "ok\n" });
    let capturedTempRoot = null;
    let pidExistedAtCleanup = null;
    let lockExistedAtCleanup = null;
    const timedOut = await evaluateLinuxArm64Smoke(repo.rootDir, {
      requireLinuxArm64: true,
      platform: "linux",
      arch: "arm64",
      nodeVersion: "24.13.0",
      deadlineMs: 1_500,
      runLivePty: false,
      runContractTests: false,
      runNativeModules: () => ({ ok: true, checks: [], errors: [] }),
      runPackInstall: (_root, { tempRoot }) => {
        capturedTempRoot = tempRoot;
        return {
          ok: true,
          errors: [],
          checks: [],
          consumerDir: tempRoot,
          cliBins: {
            ha: { file: path.join(tempRoot, "node_modules/.bin/ha"), argsPrefix: [] },
            harnessAnything: { file: path.join(tempRoot, "node_modules/.bin/harness-anything"), argsPrefix: [] },
          },
          daemonBin: { file: process.execPath, argsPrefix: [fakeDaemonScript] },
        };
      },
      runColdSmoke: () => ({ ok: true, errors: [], checks: [] }),
      runDaemonEdgeSmoke: async ({ daemonBin, tempRoot, budget }) => {
        const userRoot = path.join(tempRoot, "paused-center-user");
        mkdirSync(userRoot, { recursive: true });
        let ownedDaemon = null;
        try {
          const { bodyResult, cleanupErrors } = await runWithResourceCleanups(async () => {
            ownedDaemon = spawnOwnedDaemon({
              label: "center",
              daemonBin,
              repo: tempRoot,
              userRoot,
              env: process.env,
            });
            const ready = await waitForOwnedDaemonReady({
              label: "center",
              ownedDaemon,
              checkStatus: async () => ({
                ok: false,
                status: 1,
                timedOut: false,
                stdout: "",
                stderr: "",
                receipt: { ok: false, code: "daemon_unavailable" },
              }),
              budget,
              pollIntervalMs: 50,
            });
            return { ok: ready.ok, errors: ready.errorMessage ? [ready.errorMessage] : [], checks: [] };
          }, [
            {
              label: "center daemon cleanup",
              run: () => {
                pidExistedAtCleanup = existsSync(path.join(userRoot, "daemon-default.pid"));
                lockExistedAtCleanup = existsSync(path.join(userRoot, "daemon-default.singleton.lock"));
                return verifyDaemonStoppedAndCleanup({
                  label: "center",
                  userRoot,
                  ownedDaemon,
                  started: ownedDaemon?.ready === true,
                  alreadyStopped: false,
                  stopDaemon: async () => ({
                    ok: false,
                    status: 1,
                    timedOut: false,
                    stdout: "",
                    stderr: "",
                    receipt: { ok: false, code: "daemon_unavailable" },
                  }),
                });
              },
            },
          ]);
          return {
            ok: cleanupErrors.length === 0 && bodyResult?.ok !== false,
            errors: [...(bodyResult?.errors ?? []), ...cleanupErrors],
            checks: [],
          };
        } catch (error) {
          return { ok: false, errors: [error instanceof Error ? error.message : String(error)], checks: [] };
        }
      },
    });

    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.stages.find((stage) => stage.name === "daemon-and-edge-smoke")?.ok, false);
    assert.match(timedOut.errors.join("\n"), /exceeded 1500ms|readiness timed out/u);
    assert.equal(pidExistedAtCleanup, false, "paused daemon must not have written daemon-default.pid before timeout");
    assert.equal(
      lockExistedAtCleanup,
      false,
      "paused daemon must not have written daemon-default.singleton.lock before timeout",
    );
    assert.equal(existsSync(probePidFile), true, "paused daemon must have started and written its probe PID");
    const { pid: pausedPid } = JSON.parse(readFileSync(probePidFile, "utf8"));
    assert.ok(Number.isInteger(pausedPid) && pausedPid > 0);
    assert.throws(
      () => process.kill(pausedPid, 0),
      (error) => error?.code === "ESRCH",
      `paused daemon pid ${pausedPid} must be reaped even without a pidfile`,
    );
    assert.throws(
      () => process.kill(-pausedPid, 0),
      (error) => error?.code === "ESRCH",
      `paused daemon process group -${pausedPid} must be reaped`,
    );
    assert.ok(capturedTempRoot);
    assert.equal(existsSync(capturedTempRoot), false, "tempRoot must be removed after owned daemon cleanup");

    // Ownership guard: verifyDaemonStoppedAndCleanup must never blindly signal an unowned PID in daemon-default.pid.
    const unownedUserRoot = path.join(tempDir, "unowned-user");
    mkdirSync(unownedUserRoot, { recursive: true });
    foreignSleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
      windowsHide: true,
    });
    assert.ok(Number.isInteger(foreignSleeper.pid) && foreignSleeper.pid > 0);
    writeFileSync(path.join(unownedUserRoot, "daemon-default.pid"), `${foreignSleeper.pid}\n`);
    const unownedResult = await verifyDaemonStoppedAndCleanup({
      label: "center",
      userRoot: unownedUserRoot,
      ownedDaemon: null,
      started: false,
      alreadyStopped: false,
      stopDaemon: async () => ({
        ok: false,
        status: 1,
        timedOut: false,
        stdout: "",
        stderr: "",
        receipt: { ok: false, code: "daemon_replaced" },
      }),
    });
    assert.equal(unownedResult.ok, false);
    assert.match(
      unownedResult.errors.join("\n"),
      new RegExp(`observed surviving daemon pid ${foreignSleeper.pid}`, "u"),
    );
    // The unrelated foreign process must still be alive because cleanup refused blind kill.
    assert.doesNotThrow(() => process.kill(foreignSleeper.pid, 0));
  } finally {
    if (foreignSleeper && foreignSleeper.exitCode === null && foreignSleeper.signalCode === null) {
      foreignSleeper.kill("SIGKILL");
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("F17 negative control: native-modules probe blocking synchronously before PTY event listeners is killed within internal budget and tempRoot is cleaned up", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-f17-native-block-"));
  const blockerPath = path.join(tempDir, "block-before-pty.mjs");
  const probePidFile = path.join(tempDir, "native-probe-pid.json");
  try {
    writeFileSync(
      blockerPath,
      [
        'import { renameSync, writeFileSync } from "node:fs";',
        `const tmp = ${JSON.stringify(`${probePidFile}.tmp`)};`,
        `writeFileSync(tmp, JSON.stringify({ pid: process.pid }));`,
        `renameSync(tmp, ${JSON.stringify(probePidFile)});`,
        "// Synchronously block the native probe thread before node-pty/node:sqlite or any JS event/timer can run.",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
      ].join("\n"),
    );

    const repo = makeRepo({ "README.md": "ok\n" });
    let capturedTempRoot = null;
    let cleanupCalled = false;
    const blocked = await evaluateLinuxArm64Smoke(repo.rootDir, {
      requireLinuxArm64: true,
      platform: "linux",
      arch: "arm64",
      nodeVersion: "24.13.0",
      deadlineMs: 1_200,
      runLivePty: true,
      runContractTests: false,
      nativeProbeNodeArgs: ["--import", pathToFileURL(blockerPath).href],
      onCleanup: ({ tempRoot }) => {
        cleanupCalled = true;
        capturedTempRoot = tempRoot;
      },
    });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.stages.find((stage) => stage.name === "native-modules")?.ok, false);
    assert.match(blocked.errors.join("\n"), /native-modules probe timed out/u);
    assert.equal(cleanupCalled, true, "cleanup callback must run after native-modules timeout");
    assert.ok(capturedTempRoot);
    assert.equal(existsSync(capturedTempRoot), false, "tempRoot must be removed after native-modules timeout");
    assert.equal(existsSync(probePidFile), true, "native-modules child must have entered synchronous block");
    const { pid: probePid } = JSON.parse(readFileSync(probePidFile, "utf8"));
    assert.ok(Number.isInteger(probePid) && probePid > 0);
    assert.throws(
      () => process.kill(probePid, 0),
      (error) => error?.code === "ESRCH",
      `blocked native-modules probe pid ${probePid} must be reaped`,
    );
    assert.throws(
      () => process.kill(-probePid, 0),
      (error) => error?.code === "ESRCH",
      `blocked native-modules probe process group -${probePid} must be reaped`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
