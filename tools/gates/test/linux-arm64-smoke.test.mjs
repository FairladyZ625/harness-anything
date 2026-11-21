// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { parseGateWorkflow } from "../../gate-workflow-parser.mjs";
import {
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

test("verifyNodeSqlite and verifyNodePty pass on the current environment and reject missing prebuilds", async () => {
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
});

test("evaluateLinuxArm64Smoke aggregates host, native, daemon, CLI, and warm-run checks", async () => {
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
    runPlatformSmoke: () => ({ ok: true, errors: [], checks: ["platform-smoke stub passed"] }),
    runFirstRun: async () => ({ ok: true, errors: [], checks: ["first-run stub passed"] }),
  });
  assert.equal(ok.ok, true, ok.errors.join("\n"));
  assert.ok(ok.checks.some((line) => line.includes("linux-arm64")));
  assert.ok(ok.checks.some((line) => line.includes("dist/index.js: parseable")));

  const failed = await evaluateLinuxArm64Smoke(repo.rootDir, {
    requireLinuxArm64: true,
    platform: "linux",
    arch: "x64",
    nodeVersion: "24.13.0",
    runLivePty: false,
    runContractTests: false,
    runPlatformSmoke: () => ({ ok: false, errors: ["cli smoke failed"], checks: [] }),
    runFirstRun: async () => ({ ok: true, errors: [], checks: [] }),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.errors.join("\n"), /expected linux-arm64 runner/u);
  assert.match(failed.errors.join("\n"), /cli smoke failed/u);
});

test("rewrite-ci and gate-manifest wire linux-arm64-smoke on ubuntu-24.04-arm without touching branch protection", () => {
  const job = workflow.get("linux-arm64-smoke");
  assert.ok(job, "rewrite-ci.yml must define linux-arm64-smoke");
  assert.equal(job.isPullRequestJob, true);
  assert.equal(job.isNonPullRequestJob, true);
  assert.deepEqual(job.nodeVersions, [24]);
  assert.equal(workflowYaml.jobs["linux-arm64-smoke"]["runs-on"], "ubuntu-24.04-arm");
  assert.ok(job.runCommands.includes("npm ci"), "linux-arm64-smoke must run its own arm64 npm ci");
  assert.ok(job.runCommands.includes("npm run build -w @harness-anything/cli"));
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
