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
  hasProcessLayerFailure,
  isCliCommandSuccess,
  isConfirmedDaemonGone,
  localDaemonSocketEndpoint,
  packAndInstallArm64Packages,
  readPidFileStrict,
  requestOwnedDaemonCooperativeStop,
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
    const refusedOwned = spawnOwnedDaemon({
      label: "edge",
      daemonBin: { file: process.execPath, argsPrefix: ["-e", "setInterval(() => {}, 1000);", "--"] },
      repo: tempDir,
      userRoot: emptyUserRoot,
      env: process.env,
    });
    const cleanupFailed = await verifyDaemonStoppedAndCleanup({
      label: "edge",
      userRoot: emptyUserRoot,
      ownedDaemon: refusedOwned,
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
    assert.throws(
      () => process.kill(-refusedOwned.pgid, 0),
      (error) => error?.code === "ESRCH",
      "owned process group must still be reaped after cooperative stop refusal",
    );
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
    const throwingOwned = spawnOwnedDaemon({
      label: "edge",
      daemonBin: { file: process.execPath, argsPrefix: ["-e", "setInterval(() => {}, 1000);", "--"] },
      repo: tempDir,
      userRoot: edgeThrowUser,
      env: process.env,
    });
    const stopThrew = await verifyDaemonStoppedAndCleanup({
      label: "edge",
      userRoot: edgeThrowUser,
      ownedDaemon: throwingOwned,
      alreadyStopped: false,
      stopDaemon: async () => {
        throw new Error("edge stop transport failed");
      },
    });
    assert.equal(stopThrew.ok, false);
    assert.match(stopThrew.errors.join("\n"), /edge cleanup daemon stop failed: edge stop transport failed/u);
    assert.throws(
      () => process.kill(-throwingOwned.pgid, 0),
      (error) => error?.code === "ESRCH",
      "owned process group must still be reaped when cooperative stop throws",
    );

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
                  alreadyStopped: false,
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

    // Ownership guard: verifyDaemonStoppedAndCleanup (using its real default RPC-only stop path)
    // must never invoke cooperative stop or blindly signal an unowned PID in daemon-default.pid.
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
      alreadyStopped: false,
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

function forceKillDetachedGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

test("F19 negative control: real RPC-only cooperative stop rejects identity mismatch over Unix socket and never falls back to pidfile SIGTERM when RPC is unreachable", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-f19-"));
  const socketPath = path.join(tempDir, "d.sock");
  const serverReadyFile = path.join(tempDir, "srv-ready.json");
  const ownedReadyFile = path.join(tempDir, "owned-a1-ready.json");
  const ownedUnreachReadyFile = path.join(tempDir, "owned-b-ready.json");
  const stopReceivedFile = path.join(tempDir, "stop-called.txt");
  const sigtermFile = path.join(tempDir, "sigterm-hit.txt");
  const unreachableReadyFile = path.join(tempDir, "unreach-ready.json");
  let foreignRpcServer = null;
  let foreignUnreachable = null;
  try {
    // Verify deterministic localDaemonSocketEndpoint shape matches daemon runtime-relay-target convention.
    const computedEndpoint = localDaemonSocketEndpoint(path.join(tempDir, "sample-user"), "default", "linux");
    assert.match(computedEndpoint, /\/tmp\/harness-anything-\d+\/daemon-\d+-u-[a-f0-9]{16}\.sock$/u);

    // 1. Spawn a real controllable Unix-socket JSON-RPC peer representing a foreign daemon.
    const fakeRpcScript = [
      'const fs = require("node:fs");',
      'const net = require("node:net");',
      `const sockPath = ${JSON.stringify(socketPath)};`,
      `const readyFile = ${JSON.stringify(serverReadyFile)};`,
      `const stopFile = ${JSON.stringify(stopReceivedFile)};`,
      'process.on("SIGTERM", () => fs.writeFileSync(stopFile, "SIGTERM"));',
      "const server = net.createServer((conn) => {",
      '  conn.setEncoding("utf8");',
      '  let buf = "";',
      '  conn.on("data", (chunk) => {',
      "    buf += chunk;",
      '    let idx = buf.indexOf("\\n");',
      "    while (idx >= 0) {",
      "      const line = buf.slice(0, idx).trim();",
      "      buf = buf.slice(idx + 1);",
      '      idx = buf.indexOf("\\n");',
      "      if (!line) continue;",
      "      const req = JSON.parse(line);",
      '      if (req.method === "protocol.hello") {',
      '        conn.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true, protocolVersion: req.params.protocolVersion, methods: ["daemon.status", "daemon.stop"] } }) + "\\n");',
      '      } else if (req.method === "daemon.status") {',
      '        conn.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true, pid: process.pid } }) + "\\n");',
      '      } else if (req.method === "daemon.stop") {',
      '        fs.writeFileSync(stopFile, "RPC_STOP");',
      '        conn.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true, command: "daemon-stop", pid: process.pid } }) + "\\n");',
      "      }",
      "    }",
      "  });",
      "});",
      "server.listen(sockPath, () => {",
      '  const tmp = readyFile + ".tmp";',
      "  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid }));",
      "  fs.renameSync(tmp, readyFile);",
      "});",
    ].join("\n");
    foreignRpcServer = spawn(process.execPath, ["-e", fakeRpcScript], {
      cwd: tempDir,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    for (let attempt = 0; !existsSync(serverReadyFile) && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(serverReadyFile), true, "foreign RPC peer must bind its Unix socket");
    const { pid: foreignRpcPid } = JSON.parse(readFileSync(serverReadyFile, "utf8"));
    assert.equal(foreignRpcPid, foreignRpcServer.pid);

    // Branch A1: pidfile matches ownedDaemon.pgid so cooperative stop MUST connect over Unix socket,
    // observe daemon.status pid === foreignRpcPid !== ownedDaemon.pgid, and refuse BEFORE sending daemon.stop.
    const mismatchUserRoot = path.join(tempDir, "mismatch-user");
    mkdirSync(mismatchUserRoot, { recursive: true });
    const ownedSleeperScript = (readyPath) =>
      [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        `const tmp = ${JSON.stringify(`${readyPath}.tmp`)};`,
        "fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid }));",
        `fs.renameSync(tmp, ${JSON.stringify(readyPath)});`,
        "setInterval(() => {}, 1000);",
      ].join(" ");
    const ownedAlive = spawnOwnedDaemon({
      label: "center",
      daemonBin: { file: process.execPath, argsPrefix: ["-e", ownedSleeperScript(ownedReadyFile), "--"] },
      repo: tempDir,
      userRoot: mismatchUserRoot,
      env: process.env,
    });
    for (let attempt = 0; !existsSync(ownedReadyFile) && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(ownedReadyFile), true, "owned daemon A1 must be running before cleanup");
    ownedAlive.endpoint = socketPath;
    writeFileSync(path.join(mismatchUserRoot, "daemon-default.pid"), `${ownedAlive.pgid}\n`);

    const mismatchCleanup = await verifyDaemonStoppedAndCleanup({
      label: "center",
      userRoot: mismatchUserRoot,
      ownedDaemon: ownedAlive,
      alreadyStopped: false,
      graceMs: 150,
      cleanupTimeoutMs: 3_000,
    });
    assert.equal(mismatchCleanup.ok, false);
    assert.match(mismatchCleanup.errors.join("\n"), /daemon_identity_mismatch/u);
    assert.equal(
      existsSync(stopReceivedFile),
      false,
      "foreign RPC peer must NEVER receive daemon.stop or SIGTERM on identity mismatch",
    );
    assert.doesNotThrow(() => process.kill(foreignRpcPid, 0), "foreign RPC peer must remain alive");
    assert.throws(
      () => process.kill(-ownedAlive.pgid, 0),
      (error) => error?.code === "ESRCH",
      "owned daemon process group must still be reaped after RPC identity mismatch",
    );

    // Branch A2: waitForOwnedDaemonReady must also reject a readiness answer whose pid !== ownedDaemon.pgid.
    const readyOwned = spawnOwnedDaemon({
      label: "edge",
      daemonBin: { file: process.execPath, argsPrefix: ["-e", "setInterval(() => {}, 1000);", "--"] },
      repo: tempDir,
      userRoot: mismatchUserRoot,
      env: process.env,
    });
    try {
      const readyCheck = await waitForOwnedDaemonReady({
        label: "edge",
        ownedDaemon: readyOwned,
        checkStatus: async () => ({
          ok: true,
          status: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          receipt: { ok: true, pid: foreignRpcPid },
        }),
        budget: { deadlineMs: 2_000, isExpired: () => false, remainingMs: () => 2_000 },
        pollIntervalMs: 25,
      });
      assert.equal(readyCheck.ok, false);
      assert.equal(readyOwned.ready, false);
      assert.match(readyCheck.errorMessage ?? "", /identity mismatch/u);
    } finally {
      await verifyDaemonStoppedAndCleanup({
        label: "edge",
        userRoot: path.join(tempDir, "empty-cleanup"),
        ownedDaemon: readyOwned,
        alreadyStopped: true,
        graceMs: 100,
        cleanupTimeoutMs: 2_000,
      });
    }

    // Branch B: Unreachable RPC socket + live foreign PID in daemon-default.pid.
    // Neither direct requestOwnedDaemonCooperativeStop nor verifyDaemonStoppedAndCleanup may send SIGTERM to the pidfile PID.
    const unreachableUserRoot = path.join(tempDir, "unreach-user");
    mkdirSync(unreachableUserRoot, { recursive: true });
    const foreignUnreachScript = [
      'const fs = require("node:fs");',
      `process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(sigtermFile)}, "SIGTERM"));`,
      `const tmp = ${JSON.stringify(`${unreachableReadyFile}.tmp`)};`,
      "fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid }));",
      `fs.renameSync(tmp, ${JSON.stringify(unreachableReadyFile)});`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    foreignUnreachable = spawn(process.execPath, ["-e", foreignUnreachScript], {
      cwd: tempDir,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    for (let attempt = 0; !existsSync(unreachableReadyFile) && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(unreachableReadyFile), true);
    const foreignUnreachPid = foreignUnreachable.pid;
    writeFileSync(path.join(unreachableUserRoot, "daemon-default.pid"), `${foreignUnreachPid}\n`);

    // B1: Direct RPC stop against a missing socket when pidfile names a different live PID.
    const ownedForUnreach = spawnOwnedDaemon({
      label: "edge",
      daemonBin: { file: process.execPath, argsPrefix: ["-e", ownedSleeperScript(ownedUnreachReadyFile), "--"] },
      repo: tempDir,
      userRoot: unreachableUserRoot,
      env: process.env,
    });
    for (let attempt = 0; !existsSync(ownedUnreachReadyFile) && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(ownedUnreachReadyFile), true, "owned daemon B must be running before cleanup");
    ownedForUnreach.endpoint = path.join(tempDir, "missing.sock");
    const directStopMismatch = await requestOwnedDaemonCooperativeStop({
      label: "edge",
      userRoot: unreachableUserRoot,
      ownedDaemon: ownedForUnreach,
      timeoutMs: 2_000,
    });
    assert.equal(directStopMismatch.ok, false);
    assert.equal(directStopMismatch.receipt?.code, "daemon_identity_mismatch");
    assert.equal(existsSync(sigtermFile), false, "unowned pidfile PID must not receive SIGTERM");

    // B2: Direct RPC stop against a missing socket when pidfile is absent (pure unreachable transport -> daemon_unavailable, no signal).
    const emptyUnreachRoot = path.join(tempDir, "empty-unreach-user");
    mkdirSync(emptyUnreachRoot, { recursive: true });
    const directStopUnreachable = await requestOwnedDaemonCooperativeStop({
      label: "edge",
      userRoot: emptyUnreachRoot,
      ownedDaemon: ownedForUnreach,
      endpoint: path.join(tempDir, "missing.sock"),
      timeoutMs: 2_000,
    });
    assert.equal(directStopUnreachable.ok, false);
    assert.equal(directStopUnreachable.receipt?.code, "daemon_unavailable");
    assert.equal(existsSync(sigtermFile), false);

    // B3: Full cleanup with unreachable socket + foreign pidfile PID must reap owned group, leave foreign PID unsignalled, and fail closed.
    const unreachCleanup = await verifyDaemonStoppedAndCleanup({
      label: "edge",
      userRoot: unreachableUserRoot,
      ownedDaemon: ownedForUnreach,
      alreadyStopped: false,
      graceMs: 150,
      cleanupTimeoutMs: 3_000,
    });
    assert.equal(unreachCleanup.ok, false);
    assert.match(unreachCleanup.errors.join("\n"), /daemon_identity_mismatch/u);
    assert.match(
      unreachCleanup.errors.join("\n"),
      new RegExp(`observed surviving daemon pid ${foreignUnreachPid}`, "u"),
    );
    assert.equal(existsSync(sigtermFile), false, "foreign process must NEVER receive SIGTERM when RPC is unreachable");
    assert.doesNotThrow(() => process.kill(foreignUnreachPid, 0), "foreign process must remain alive");
    assert.throws(
      () => process.kill(-ownedForUnreach.pgid, 0),
      (error) => error?.code === "ESRCH",
      "owned daemon process group must still be reaped",
    );
  } finally {
    for (const proc of [foreignRpcServer, foreignUnreachable]) {
      if (proc?.pid) forceKillDetachedGroup(proc.pid);
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("F20 negative control: pidfile/singleton ENOENT is treated as absent and EISDIR read errors preserve errors without short-circuiting owned process-group reaping", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-f20-bookkeeping-"));
  const probePidFile = path.join(tempDir, "f20-owned-pid.json");
  try {
    // Concurrent unlink (ENOENT) must be treated as absent without throwing.
    const absent = readPidFileStrict(path.join(tempDir, "unlinked-daemon.pid"));
    assert.equal(absent.state, "absent");
    assert.equal(absent.pid, null);

    // Directory at daemon-default.pid and daemon-default.singleton.lock forces EISDIR on readFileSync.
    const userRoot = path.join(tempDir, "eisdir-user");
    mkdirSync(path.join(userRoot, "daemon-default.pid"), { recursive: true });
    mkdirSync(path.join(userRoot, "daemon-default.singleton.lock"), { recursive: true });

    const pidDirRead = readPidFileStrict(path.join(userRoot, "daemon-default.pid"));
    assert.equal(pidDirRead.state, "error");
    assert.equal(pidDirRead.code, "EISDIR");

    const sleeperScript = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `const tmp = ${JSON.stringify(`${probePidFile}.tmp`)};`,
      "fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid }));",
      `fs.renameSync(tmp, ${JSON.stringify(probePidFile)});`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const ownedDaemon = spawnOwnedDaemon({
      label: "center",
      daemonBin: { file: process.execPath, argsPrefix: ["-e", sleeperScript, "--"] },
      repo: tempDir,
      userRoot,
      env: process.env,
    });
    for (let attempt = 0; !existsSync(probePidFile) && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(probePidFile), true, "owned daemon must be running before cleanup");
    const { pid: ownedPid } = JSON.parse(readFileSync(probePidFile, "utf8"));
    assert.equal(ownedPid, ownedDaemon.pgid);

    const cleanupResult = await verifyDaemonStoppedAndCleanup({
      label: "center",
      userRoot,
      ownedDaemon,
      alreadyStopped: false,
      graceMs: 150,
      cleanupTimeoutMs: 3_000,
    });
    assert.equal(cleanupResult.ok, false);
    assert.match(cleanupResult.errors.join("\n"), /failed reading daemon pid file.*EISDIR/u);
    assert.match(cleanupResult.errors.join("\n"), /failed reading daemon singleton lock.*EISDIR/u);
    assert.throws(
      () => process.kill(ownedPid, 0),
      (error) => error?.code === "ESRCH",
      `owned daemon pid ${ownedPid} must be reaped despite EISDIR bookkeeping errors`,
    );
    assert.throws(
      () => process.kill(-ownedPid, 0),
      (error) => error?.code === "ESRCH",
      `owned daemon process group -${ownedPid} must be reaped despite EISDIR bookkeeping errors`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("F21 negative control: runBoundedCommandAsync detects and reaps a same-group descendant with detached stdio when leader exits 0", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-f21-close-group-"));
  const pidFile = path.join(tempDir, "f21-pids.json");
  try {
    // Grandchild stays in the leader's process group (detached: false) with completely independent stdio ("ignore"),
    // ignores SIGTERM, writes both PIDs atomically, and stays alive.
    // Leader waits until the grandchild is confirmed running, then exits 0 so stdout/stderr pipes close immediately.
    const detachedStdioGrandScript = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `const tmp = ${JSON.stringify(`${pidFile}.tmp`)};`,
      `fs.writeFileSync(tmp, JSON.stringify({ leader: Number(process.env.LEADER_PID), grand: process.pid }));`,
      `fs.renameSync(tmp, ${JSON.stringify(pidFile)});`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const leaderExitZeroScript = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(detachedStdioGrandScript)}], { stdio: "ignore", detached: false, env: { ...process.env, LEADER_PID: String(process.pid) } });`,
      `const waitReady = setInterval(() => { if (fs.existsSync(${JSON.stringify(pidFile)})) { clearInterval(waitReady); process.exit(0); } }, 15);`,
    ].join(" ");

    const result = await runBoundedCommandAsync(process.execPath, ["-e", leaderExitZeroScript], {
      cwd: tempDir,
      env: process.env,
      timeoutMs: 10_000,
      graceMs: 150,
      cleanupTimeoutMs: 3_000,
      label: "f21 detached-stdio descendant probe",
    });

    assert.equal(result.timedOut, false, "must settle via close branch rather than waiting for full command timeout");
    assert.equal(result.status, 0, "group leader exited 0");
    assert.equal(result.ok, false, "surviving same-group descendant after leader exit 0 must fail closed");
    assert.equal(result.survivingProcessGroup, true);
    assert.equal(result.terminatedCleanly, true, result.errorMessage ?? "");
    assert.match(result.errorMessage ?? "", /left surviving process group -\d+ after exit 0/u);

    assert.equal(existsSync(pidFile), true, "grandchild must have started and written PIDs before leader exited 0");
    const { leader: leaderPid, grand: grandPid } = JSON.parse(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(leaderPid) && leaderPid > 0);
    assert.ok(Number.isInteger(grandPid) && grandPid > 0 && grandPid !== leaderPid);
    for (const pid of [leaderPid, grandPid]) {
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error?.code === "ESRCH",
        `pid ${pid} must be reaped via -pgid on close when leader exited 0`,
      );
    }
    assert.throws(
      () => process.kill(-leaderPid, 0),
      (error) => error?.code === "ESRCH",
      `process group -${leaderPid} must be gone after close settlement`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("F22 negative controls: surviving process group with healthy business receipt and exit 0 propagates through native-modules, cold CLI, waitForOwnedDaemonReady, smoke-identity, and final gate verdict", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-f22-propagation-"));
  const nativePidFile = path.join(tempDir, "f22-native-pids.json");
  const coldPidFile = path.join(tempDir, "f22-cold-pids.json");
  const readyPidFile = path.join(tempDir, "f22-ready-pids.json");
  const identityPidFile = path.join(tempDir, "f22-identity-pids.json");
  const nativeHookPath = path.join(tempDir, "f22-native-hook.mjs");
  const fakeHaPath = path.join(tempDir, "fake-ha.mjs");
  let liveIdentity = null;
  try {
    // Contract predicates distinguish clean exit 0 / clean expected non-zero from process-layer failures.
    assert.equal(
      hasProcessLayerFailure({
        ok: true,
        status: 0,
        timedOut: false,
        terminatedCleanly: true,
        survivingProcessGroup: false,
      }),
      false,
    );
    assert.equal(
      isCliCommandSuccess({
        ok: true,
        status: 0,
        timedOut: false,
        terminatedCleanly: true,
        survivingProcessGroup: false,
      }),
      true,
    );
    assert.equal(
      hasProcessLayerFailure({
        ok: false,
        status: 1,
        timedOut: false,
        terminatedCleanly: true,
        survivingProcessGroup: false,
      }),
      false,
    );
    assert.equal(
      hasProcessLayerFailure({
        ok: false,
        status: 0,
        timedOut: false,
        terminatedCleanly: true,
        survivingProcessGroup: true,
      }),
      true,
    );
    assert.equal(
      isCliCommandSuccess({
        ok: false,
        status: 0,
        timedOut: false,
        terminatedCleanly: true,
        survivingProcessGroup: true,
      }),
      false,
    );
    assert.equal(
      isConfirmedDaemonGone({
        status: 1,
        timedOut: false,
        survivingProcessGroup: true,
        terminatedCleanly: true,
        receipt: { code: "daemon_unavailable" },
      }),
      false,
    );
    assert.equal(
      isConfirmedDaemonGone({
        status: 1,
        timedOut: false,
        survivingProcessGroup: false,
        terminatedCleanly: false,
        receipt: { code: "daemon_unavailable" },
      }),
      false,
    );

    const makeDetachedStdioGrandScript = (pidFilePath) =>
      [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        `const tmp = ${JSON.stringify(`${pidFilePath}.tmp`)};`,
        `fs.writeFileSync(tmp, JSON.stringify({ leader: Number(process.env.LEADER_PID), grand: process.pid }));`,
        `fs.renameSync(tmp, ${JSON.stringify(pidFilePath)});`,
        "setInterval(() => {}, 1000);",
      ].join(" ");

    // (1) Real F21 process group through production runNativeModulesProbeInSubprocess -> evaluateLinuxArm64Smoke -> final verdict.
    // The real native probe emits a healthy business marker with ok:true, errors:[] and exits 0, while its
    // same-group detached-stdio descendant stays alive and ignores SIGTERM.
    writeFileSync(
      nativeHookPath,
      [
        'import { spawn } from "node:child_process";',
        'import { existsSync } from "node:fs";',
        `const grand = spawn(process.execPath, ["-e", ${JSON.stringify(makeDetachedStdioGrandScript(nativePidFile))}], { stdio: "ignore", detached: false, env: { ...process.env, LEADER_PID: String(process.pid) } });`,
        "grand.unref();",
        `for (let i = 0; !existsSync(${JSON.stringify(nativePidFile)}) && i < 200; i += 1) {`,
        "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);",
        "}",
      ].join("\n"),
    );

    const repo = makeRepo({ "README.md": "ok\n" });
    const fakeBins = (root) => ({
      ha: { file: path.join(root, "node_modules/.bin/ha"), argsPrefix: [] },
      harnessAnything: { file: path.join(root, "node_modules/.bin/harness-anything"), argsPrefix: [] },
    });
    const nativeVerdict = await evaluateLinuxArm64Smoke(repo.rootDir, {
      requireLinuxArm64: true,
      platform: "linux",
      arch: "arm64",
      nodeVersion: "24.13.0",
      deadlineMs: 15_000,
      runLivePty: false,
      runContractTests: false,
      nativeProbeNodeArgs: ["--import", pathToFileURL(nativeHookPath).href],
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
    });

    assert.equal(
      nativeVerdict.ok,
      false,
      "final gate verdict must fail when native-modules probe leaves a surviving process group despite healthy business marker and exit 0",
    );
    assert.equal(nativeVerdict.stages.find((stage) => stage.name === "native-modules")?.ok, false);
    assert.ok(
      nativeVerdict.checks.some((line) => line.includes("node:sqlite DatabaseSync round-trip passed")),
      "business probe must actually run to healthy completion before leader exits 0",
    );
    assert.match(nativeVerdict.errors.join("\n"), /left surviving process group -\d+ after exit 0/u);
    assert.equal(existsSync(nativePidFile), true);
    const nativePids = JSON.parse(readFileSync(nativePidFile, "utf8"));
    for (const pid of [nativePids.leader, nativePids.grand]) {
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error?.code === "ESRCH",
      );
    }
    assert.throws(
      () => process.kill(-nativePids.leader, 0),
      (error) => error?.code === "ESRCH",
    );

    // (2) Real F21 process group through production runPackagedColdSmoke (expected non-zero daemon_unavailable) -> evaluateLinuxArm64Smoke.
    writeFileSync(
      fakeHaPath,
      [
        "#!/usr/bin/env node",
        'import { spawn } from "node:child_process";',
        'import { existsSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        'if (args.includes("--help")) {',
        '  process.stdout.write("ha daemon start --service\\n");',
        "  process.exit(0);",
        "}",
        `spawn(process.execPath, ["-e", ${JSON.stringify(makeDetachedStdioGrandScript(coldPidFile))}], { stdio: "ignore", detached: false, env: { ...process.env, LEADER_PID: String(process.pid) } });`,
        `for (let i = 0; !existsSync(${JSON.stringify(coldPidFile)}) && i < 200; i += 1) {`,
        "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);",
        "}",
        'process.stdout.write(JSON.stringify({ ok: false, code: "daemon_unavailable" }) + "\\n");',
        "process.exit(1);",
      ].join("\n"),
    );
    chmodSync(fakeHaPath, 0o755);

    const coldVerdict = await evaluateLinuxArm64Smoke(repo.rootDir, {
      requireLinuxArm64: true,
      platform: "linux",
      arch: "arm64",
      nodeVersion: "24.13.0",
      runLivePty: false,
      runContractTests: false,
      runNativeModules: () => ({ ok: true, errors: [], checks: [] }),
      runPackInstall: (_root, { tempRoot }) => ({
        ok: true,
        errors: [],
        checks: [],
        consumerDir: tempRoot,
        cliBins: {
          ha: { file: process.execPath, argsPrefix: [fakeHaPath] },
          harnessAnything: { file: process.execPath, argsPrefix: [fakeHaPath] },
        },
        daemonBin: null,
      }),
      runDaemonEdgeSmoke: async () => ({ ok: true, errors: [], checks: [] }),
    });
    assert.equal(
      coldVerdict.ok,
      false,
      "cold daemon status returning expected daemon_unavailable must still fail closed when leaving a surviving process group",
    );
    assert.equal(coldVerdict.stages.find((stage) => stage.name === "packaged-cli-cold")?.ok, false);
    assert.match(coldVerdict.errors.join("\n"), /survivingProcessGroup=true|left surviving process group/u);
    assert.equal(existsSync(coldPidFile), true);
    const coldPids = JSON.parse(readFileSync(coldPidFile, "utf8"));
    for (const pid of [coldPids.leader, coldPids.grand]) {
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error?.code === "ESRCH",
      );
    }
    assert.throws(
      () => process.kill(-coldPids.leader, 0),
      (error) => error?.code === "ESRCH",
    );

    // (3) Real F21 process group through production waitForOwnedDaemonReady: healthy receipt + matching pid + exit 0 must NOT accept readiness.
    const ownedDaemon = spawnOwnedDaemon({
      label: "center",
      daemonBin: { file: process.execPath, argsPrefix: ["-e", "setInterval(() => {}, 1000);", "--"] },
      repo: tempDir,
      userRoot: path.join(tempDir, "f22-ready-user"),
      env: process.env,
    });
    try {
      const readyLeaderScript = [
        'const fs = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        `spawn(process.execPath, ["-e", ${JSON.stringify(makeDetachedStdioGrandScript(readyPidFile))}], { stdio: "ignore", detached: false, env: { ...process.env, LEADER_PID: String(process.pid) } });`,
        `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(readyPidFile)})) { clearInterval(timer); process.stdout.write(JSON.stringify({ ok: true, pid: ${ownedDaemon.pgid} }) + "\\n"); process.exit(0); } }, 15);`,
      ].join(" ");
      const readyResult = await waitForOwnedDaemonReady({
        label: "center",
        ownedDaemon,
        checkStatus: async (timeoutMs) => {
          const run = await runBoundedCommandAsync(process.execPath, ["-e", readyLeaderScript], {
            cwd: tempDir,
            env: process.env,
            timeoutMs,
            graceMs: 150,
            cleanupTimeoutMs: 3_000,
            label: "f22 readiness status probe",
          });
          return { ...run, receipt: JSON.parse(run.stdout.trim()) };
        },
        budget: { deadlineMs: 5_000, isExpired: () => false, remainingMs: () => 5_000 },
        pollIntervalMs: 25,
      });
      assert.equal(
        readyResult.ok,
        false,
        "waitForOwnedDaemonReady must reject survivingProcessGroup despite exit 0 and matching PID",
      );
      assert.equal(ownedDaemon.ready, false);
      assert.match(readyResult.errorMessage ?? "", /survivingProcessGroup=true|left surviving process group/u);
      assert.equal(existsSync(readyPidFile), true);
      const readyPids = JSON.parse(readFileSync(readyPidFile, "utf8"));
      for (const pid of [readyPids.leader, readyPids.grand]) {
        assert.throws(
          () => process.kill(pid, 0),
          (error) => error?.code === "ESRCH",
        );
      }
      assert.throws(
        () => process.kill(-readyPids.leader, 0),
        (error) => error?.code === "ESRCH",
      );
    } finally {
      await verifyDaemonStoppedAndCleanup({
        label: "center",
        userRoot: path.join(tempDir, "f22-ready-empty"),
        ownedDaemon,
        alreadyStopped: true,
        graceMs: 100,
        cleanupTimeoutMs: 2_000,
      });
    }

    // (4) Real F21 process group through smokeIdentity.prepareAsync: healthy receipt + exit 0 with survivingProcessGroup must throw.
    const identityRoot = path.join(tempDir, "f22-identity-root");
    mkdirSync(identityRoot, { recursive: true });
    liveIdentity = await smokeIdentity(identityRoot, "arm64-f22-identity", { timeoutMs: 10_000 });
    const identityLeaderScript = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(makeDetachedStdioGrandScript(identityPidFile))}], { stdio: "ignore", detached: false, env: { ...process.env, LEADER_PID: String(process.pid) } });`,
      `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(identityPidFile)})) { clearInterval(timer); process.stdout.write(JSON.stringify({ ok: true }) + "\\n"); process.exit(0); } }, 15);`,
    ].join(" ");
    await assert.rejects(
      () =>
        liveIdentity.prepareAsync(async () => {
          const run = await runBoundedCommandAsync(process.execPath, ["-e", identityLeaderScript], {
            cwd: tempDir,
            env: process.env,
            timeoutMs: 10_000,
            graceMs: 150,
            cleanupTimeoutMs: 3_000,
            label: "f22 identity bootstrap probe",
          });
          return { ...run, receipt: JSON.parse(run.stdout.trim()) };
        }),
      /survivingProcessGroup.*true|identity bootstrap/u,
    );
    assert.equal(existsSync(identityPidFile), true);
    const identityPids = JSON.parse(readFileSync(identityPidFile, "utf8"));
    for (const pid of [identityPids.leader, identityPids.grand]) {
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error?.code === "ESRCH",
      );
    }
    assert.throws(
      () => process.kill(-identityPids.leader, 0),
      (error) => error?.code === "ESRCH",
    );

    // (5) Stage returning { ok: false, errors: [] } must still fail overall evaluateLinuxArm64Smoke verdict and emit diagnostic error.
    const silentStageFail = await evaluateLinuxArm64Smoke(repo.rootDir, {
      requireLinuxArm64: true,
      platform: "linux",
      arch: "arm64",
      nodeVersion: "24.13.0",
      runLivePty: false,
      runContractTests: false,
      runNativeModules: () => ({ ok: false, errors: [], checks: [] }),
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
    });
    assert.equal(silentStageFail.ok, false);
    assert.equal(silentStageFail.stages.find((stage) => stage.name === "native-modules")?.ok, false);
    assert.match(silentStageFail.errors.join("\n"), /stage native-modules returned ok: false/u);
  } finally {
    if (liveIdentity) await liveIdentity.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("F23 negative control: POSIX FIFO named pipes at pidfile and singleton lock fail non-blockingly without hanging owned process-group reaping or downstream cleanups", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mkfifo named pipe test applies to Linux/macOS");
    return;
  }
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-f23-fifo-"));
  const userRoot = path.join(tempDir, "fifo-user");
  const pidPath = path.join(userRoot, "daemon-default.pid");
  const lockPath = path.join(userRoot, "daemon-default.singleton.lock");
  const oversizedPidPath = path.join(tempDir, "oversized.pid");
  const probePidFile = path.join(tempDir, "f23-owned-pid.json");
  mkdirSync(userRoot, { recursive: true });
  try {
    const mkfifoResult = await runBoundedCommandAsync("mkfifo", [pidPath, lockPath], {
      cwd: tempDir,
      env: process.env,
      timeoutMs: 5_000,
      label: "f23 mkfifo",
    });
    assert.equal(mkfifoResult.ok, true, mkfifoResult.errorMessage ?? "");

    // Direct non-blocking read against a writerless FIFO must settle immediately with ENOTREG (never block event loop).
    const fifoPidRead = readPidFileStrict(pidPath);
    assert.equal(fifoPidRead.state, "error");
    assert.equal(fifoPidRead.code, "ENOTREG");
    assert.match(fifoPidRead.error ?? "", /FIFO/u);

    // Oversized regular pidfile must also fail closed with EFBIG.
    writeFileSync(oversizedPidPath, `${"9".repeat(2048)}\n`);
    const oversizedRead = readPidFileStrict(oversizedPidPath);
    assert.equal(oversizedRead.state, "error");
    assert.equal(oversizedRead.code, "EFBIG");

    // Live SIGTERM-ignoring owned daemon in userRoot with FIFOs at both bookkeeping paths.
    const sleeperScript = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `const tmp = ${JSON.stringify(`${probePidFile}.tmp`)};`,
      "fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid }));",
      `fs.renameSync(tmp, ${JSON.stringify(probePidFile)});`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const ownedDaemon = spawnOwnedDaemon({
      label: "center",
      daemonBin: { file: process.execPath, argsPrefix: ["-e", sleeperScript, "--"] },
      repo: tempDir,
      userRoot,
      env: process.env,
    });
    for (let attempt = 0; !existsSync(probePidFile) && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(probePidFile), true, "owned daemon must be running before FIFO cleanup");
    const { pid: ownedPid } = JSON.parse(readFileSync(probePidFile, "utf8"));
    assert.equal(ownedPid, ownedDaemon.pgid);

    let downstreamCleanupRan = false;
    const { cleanupErrors } = await runWithResourceCleanups(
      async () => ({ ok: true }),
      [
        {
          label: "center daemon cleanup",
          run: () =>
            verifyDaemonStoppedAndCleanup({
              label: "center",
              userRoot,
              ownedDaemon,
              alreadyStopped: false,
              graceMs: 150,
              cleanupTimeoutMs: 3_000,
            }),
        },
        {
          label: "downstream resource cleanup",
          run: async () => {
            downstreamCleanupRan = true;
            return { ok: true, errors: [] };
          },
        },
      ],
    );

    assert.equal(downstreamCleanupRan, true, "downstream cleanups must continue after FIFO bookkeeping read errors");
    assert.ok(cleanupErrors.length >= 2, `expected FIFO bookkeeping errors, got: ${JSON.stringify(cleanupErrors)}`);
    assert.match(cleanupErrors.join("\n"), /failed reading daemon pid file.*ENOTREG.*FIFO/u);
    assert.match(cleanupErrors.join("\n"), /failed reading daemon singleton lock.*ENOTREG.*FIFO/u);
    assert.throws(
      () => process.kill(ownedPid, 0),
      (error) => error?.code === "ESRCH",
      `owned daemon pid ${ownedPid} must be reaped despite writerless FIFO bookkeeping files`,
    );
    assert.throws(
      () => process.kill(-ownedPid, 0),
      (error) => error?.code === "ESRCH",
      `owned daemon process group -${ownedPid} must be reaped despite writerless FIFO bookkeeping files`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
