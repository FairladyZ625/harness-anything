// harness-test-tier: fast
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildManifestGatePlan, parseManifestGateArgs, shouldSkipTestQuarantine } from "./run-manifest-gates.mjs";

const runnerPath = path.resolve(import.meta.dirname, "run-manifest-gates.mjs");
const quarantineModulePath = path.resolve(import.meta.dirname, "test-quarantine.mjs");

test("manifest gate runner appends shard args only to shardable gates", () => {
  const manifest = {
    gates: [
      {
        id: "test-integration",
        command: "npm run test:integration",
        shardable: true,
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["integration-shard"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "integration-shard", "--shard", "3"]);

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "test-integration", command: "npm run test:integration -- --shard 3" },
  ]);
});

test("manifest gate runner executes gates declared for non-pull-request workflow jobs", () => {
  const manifest = {
    gates: [
      {
        id: "test-integration",
        command: "npm run test:integration",
        shardable: true,
        executionSurfaces: { rewriteCi: { pullRequestJobs: [], nonPullRequestJobs: ["windows-integration-shard"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "windows-integration-shard", "--shard", "4"]);

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "test-integration", command: "npm run test:integration -- --shard 4" },
  ]);
});

test("manifest gate runner rejects --shard for non-shardable gates", () => {
  const manifest = {
    gates: [
      {
        id: "check-example",
        command: "npm run harness:check-example",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--shard", "1"]);

  assert.throws(
    () => buildManifestGatePlan(manifest, options),
    /manifest gate check-example is not shardable but --shard was provided/u,
  );
});

test("manifest gate runner selects locally scoped gates for fully covered changed paths", () => {
  const manifest = selectionManifest();
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--changed", "origin/main"]);
  options.changedPaths = ["docs-release/contributing/en/guide.md"];

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "check-docs", command: "node check-docs.mjs" },
    { id: "check-release", command: "node check-release.mjs" },
  ]);
  assert.equal(options.changed, "origin/main");
});

test("manifest gate runner falls back to the full job when any changed path is unclassified", () => {
  const manifest = selectionManifest();
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--changed", "origin/main"]);
  options.changedPaths = ["docs-release/guide.md", "packages/kernel/src/index.ts"];

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "check-docs", command: "node check-docs.mjs" },
    { id: "check-release", command: "node check-release.mjs" },
    { id: "check-everything", command: "node check-everything.mjs" },
  ]);
});

test("manifest gate runner preserves the full CI plan when --changed is absent", () => {
  const options = parseManifestGateArgs(["--workflow-job", "boundaries"]);

  assert.deepEqual(buildManifestGatePlan(selectionManifest(), options), [
    { id: "check-docs", command: "node check-docs.mjs" },
    { id: "check-release", command: "node check-release.mjs" },
    { id: "check-everything", command: "node check-everything.mjs" },
  ]);
});

test("manifest gate runner resumes only the failed run and removes its checkpoint after success", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ha-manifest-resume-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "core.autocrlf", "true"]);
    writeRunnerFixture(root);
    git(root, ["add", "."]);
    git(root, ["-c", "user.name=Harness Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);

    const ciEnv = fixtureCiEnv(root);
    const first = runFixture(root, ciEnv);
    assert.equal(first.status, 1, first.stderr);
    assert.equal(readRuns(root), "one\n");
    assert.equal(existsSync(ciEnv.HARNESS_CI_GATE_RESULTS), true);

    const resumed = runFixture(root, { ...ciEnv, ALLOW_SECOND_GATE: "1" }, ["--resume"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /check-one \(already passed; resumed\)/u);
    assert.equal(readRuns(root), "one\nthree\n");

    const staleResume = runFixture(root, { ...ciEnv, ALLOW_SECOND_GATE: "1" }, ["--resume"]);
    assert.equal(staleResume.status, 2);
    assert.match(staleResume.stderr, /--resume requires a failed manifest gate run/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("test quarantine skips pull-request L0 jobs", () => {
  assert.equal(
    shouldSkipTestQuarantine("integration-shard", { GITHUB_EVENT_NAME: "pull_request", GITHUB_HEAD_REF: "feature/x" }),
    true,
  );
  assert.equal(shouldSkipTestQuarantine("integration-shard", { GITHUB_EVENT_NAME: "pull_request" }), true);
  assert.equal(shouldSkipTestQuarantine("integration-shard", { GITHUB_EVENT_NAME: "schedule" }), false);
  assert.equal(
    shouldSkipTestQuarantine("windows-integration-shard", {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "feature/x",
    }),
    false,
  );
});

function selectionManifest() {
  const executionSurfaces = { rewriteCi: { pullRequestJobs: ["boundaries"] } };
  return {
    gates: [
      {
        id: "check-docs",
        command: "node check-docs.mjs",
        localPathGlobs: ["README.md", "docs-release/**"],
        executionSurfaces,
      },
      {
        id: "check-release",
        command: "node check-release.mjs",
        localPathGlobs: ["docs-release/**"],
        executionSurfaces,
      },
      { id: "check-everything", command: "node check-everything.mjs", executionSurfaces },
    ],
  };
}

function writeRunnerFixture(root) {
  mkdirSync(path.join(root, "tools"), { recursive: true });
  copyFileSync(runnerPath, path.join(root, "tools/run-manifest-gates.mjs"));
  copyFileSync(quarantineModulePath, path.join(root, "tools/test-quarantine.mjs"));
  writeFileSync(
    path.join(root, "tools/gate-manifest.json"),
    `${JSON.stringify(
      {
        gates: [
          gate("check-one", "node gate-one.mjs"),
          gate("check-two", "node gate-two.mjs"),
          gate("check-three", "node gate-three.mjs"),
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(root, "tools/test-quarantine.json"), '{"schema":"harness-test-quarantine/v1","tests":[]}\n');
  writeFileSync(
    path.join(root, "gate-one.mjs"),
    'import { appendFileSync } from "node:fs";\nappendFileSync(".git/runs.log", "one\\n");\n',
  );
  writeFileSync(path.join(root, "gate-two.mjs"), "if (!process.env.ALLOW_SECOND_GATE) process.exit(1);\n");
  writeFileSync(
    path.join(root, "gate-three.mjs"),
    'import { appendFileSync } from "node:fs";\nappendFileSync(".git/runs.log", "three\\n");\n',
  );
}

function gate(id, command) {
  return { id, command, executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } } };
}

function fixtureCiEnv(root) {
  const observationRoot = path.join(root, "tmp/ci-observation");
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_JOB: "fast-contract",
    HARNESS_CI_NODE_TEST_RESULTS: path.join(observationRoot, "node-tests.json"),
    HARNESS_CI_VITEST_RESULTS: path.join(observationRoot, "vitest.json"),
    HARNESS_CI_GATE_RESULTS: path.join(observationRoot, "gates.json"),
    HARNESS_CI_OBSERVATION_OUTPUT: path.join(observationRoot, "observation.json"),
  };
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function runFixture(root, env, extraArgs = []) {
  return spawnSync(process.execPath, ["tools/run-manifest-gates.mjs", "--workflow-job", "boundaries", ...extraArgs], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function readRuns(root) {
  return spawnSync(
    process.execPath,
    ["-e", 'process.stdout.write(require("node:fs").readFileSync(".git/runs.log","utf8"))'],
    {
      cwd: root,
      encoding: "utf8",
    },
  ).stdout;
}
