// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { parseGateWorkflow } from "../../gate-workflow-parser.mjs";
import {
  DEFAULT_DEADLINE_MS,
  daemonEntrypoints,
  evaluateLinuxArm64Smoke,
  verifyHostArchitecture,
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

test("daemonEntrypoints resolves built daemon bin and rejects missing or unnormalized targets", () => {
  const built = makeRepo({
    "packages/daemon/package.json": JSON.stringify({
      type: "module",
      bin: { "harness-anything-daemon": "dist/index.js" },
    }),
    "packages/daemon/dist/index.js": "export const ok = true;\n",
  });
  const okResult = daemonEntrypoints(built.rootDir);
  assert.deepEqual(okResult.errors, []);
  assert.equal(okResult.entries.length, 1);

  const missing = makeRepo({
    "packages/daemon/package.json": JSON.stringify({
      type: "module",
      bin: { "harness-anything-daemon": "dist/missing.js" },
    }),
  });
  const missingResult = daemonEntrypoints(missing.rootDir);
  assert.equal(missingResult.entries.length, 0);
  assert.match(missingResult.errors.join("\n"), /Daemon bin target is not built/u);
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

test("evaluateLinuxArm64Smoke aggregates pack/install, cold CLI, daemon+edge smoke, and per-stage timings", async () => {
  const repo = makeRepo({
    "packages/daemon/package.json": JSON.stringify({
      type: "module",
      bin: { "harness-anything-daemon": "dist/index.js" },
    }),
    "packages/daemon/dist/index.js": "export const ready = true;\n",
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
      cliEntry: path.join(tempRoot, "cli.js"),
      daemonEntry: path.join(tempRoot, "daemon.js"),
    }),
    runColdSmoke: () => ({ ok: true, errors: [], checks: ["packaged CLI cold stub passed"] }),
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
      cliEntry: path.join(tempRoot, "cli.js"),
      daemonEntry: path.join(tempRoot, "daemon.js"),
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
      errors: ["@harness-anything/cli bin target dist/cli/src/index.js is not in the npm pack tarball"],
      checks: [],
      consumerDir: null,
      cliEntry: null,
      daemonEntry: null,
    }),
    runColdSmoke: () => ({ ok: true, errors: [], checks: [] }),
    runDaemonEdgeSmoke: async () => {
      edgeCalledAfterPackFailure = true;
      return { ok: true, errors: [], checks: [] };
    },
  });
  assert.equal(packFailed.ok, false);
  assert.equal(edgeCalledAfterPackFailure, false);
  assert.match(packFailed.errors.join("\n"), /not in the npm pack tarball/u);
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
        cliEntry: path.join(tempRoot, "cli.js"),
        daemonEntry: path.join(tempRoot, "daemon.js"),
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

test("rewrite-ci and gate-manifest wire linux-arm64-smoke on ubuntu-24.04-arm with aligned 180s timeout", () => {
  const job = workflow.get("linux-arm64-smoke");
  assert.ok(job, "rewrite-ci.yml must define linux-arm64-smoke");
  assert.equal(job.isPullRequestJob, true);
  assert.equal(job.isNonPullRequestJob, true);
  assert.deepEqual(job.nodeVersions, [24]);
  const rawJob = workflowYaml.jobs["linux-arm64-smoke"];
  assert.equal(rawJob["runs-on"], "ubuntu-24.04-arm");
  assert.ok(rawJob["timeout-minutes"] <= 5, "linux-arm64-smoke job timeout must be tightened from 10m");
  const gateStep = rawJob.steps.find(
    (step) => step.run === "node tools/run-manifest-gates.mjs --workflow-job linux-arm64-smoke",
  );
  assert.ok(gateStep, "linux-arm64-smoke must run the manifest gate step");
  assert.equal(gateStep["timeout-minutes"], DEFAULT_DEADLINE_MS / 60_000);
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
