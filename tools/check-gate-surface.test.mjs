import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-gate-surface.mjs");

test("gate surface check accepts a consistent minimal manifest", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root);

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Gate surface check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate surface check rejects package aggregate commands missing from the manifest", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      packageJson(packageJson) {
        packageJson.scripts.check = `${packageJson.scripts.check} && npm run harness:unregistered-gate`;
        packageJson.scripts["harness:unregistered-gate"] = "node tools/unregistered-gate.mjs";
      }
    });

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scripts\.check contains "npm run harness:unregistered-gate"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate surface check rejects a PR workflow lane that no longer runs a required manifest gate", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      workflow(workflow) {
        return workflow.replace("      - run: npm run harness:check-gate-surface\n", "");
      }
    });

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /check-gate-surface expects boundaries to run "npm run harness:check-gate-surface"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate surface check accepts a GUI E2E manifest runner wrapped by xvfb and tee", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      manifest(manifest) {
        manifest.surfaces.rewriteCi.pullRequestGateJobs.push("gui-e2e");
        manifest.surfaces.branchProtection.requiredContexts.push("gui-e2e");
        manifest.gates.push({
          id: "test-gui-e2e",
          command: "npm run test:gui:e2e",
          category: "smoke",
          tier: "pr-required",
          authoritySource: ["packages/gui/e2e/electron-smoke.e2e.mjs"],
          consumerScope: ["Electron shell smoke through Playwright for Electron"],
          githubContext: {
            requiredContexts: ["gui-e2e"],
            workflowJobs: ["gui-e2e"],
            nodeVersions: [24]
          },
          allowlistPolicy: { allowed: false },
          bypassFixtureRequired: false,
          executionSurfaces: {
            packageJson: { check: false, checkPr: false, script: null },
            rewriteCi: { pullRequestJobs: ["gui-e2e"], nonPullRequestJobs: [] },
            branchProtection: { required: true, contexts: ["gui-e2e"] }
          }
        });
      },
      workflow(workflow) {
        return workflow.replace(
          "  boundaries:\n",
          [
            "  gui-e2e:",
            "    if: github.event_name == 'pull_request'",
            "    runs-on: ubuntu-latest",
            "    steps:",
            "      - run: npm ci",
            "      - run: mkdir -p artifacts/gui-e2e",
            "      - run: xvfb-run --auto-servernum node tools/run-manifest-gates.mjs --workflow-job gui-e2e --exclude mergify-queue-metadata-edit-noop 2>&1 | tee artifacts/gui-e2e/gui-e2e.log",
            "  boundaries:",
            ""
          ].join("\n")
        );
      },
      branchProtection(branchProtection) {
        return branchProtection.replace("- boundaries\n", "- boundaries\n- gui-e2e\n");
      }
    });

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Gate surface check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate surface check rejects branch-protection document drift from required contexts", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      branchProtection(branchProtection) {
        return branchProtection.replace("- boundaries\n", "");
      }
    });

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required contexts is missing manifest entry boundaries/);
    assert.match(result.stderr, /check-gate-surface requires context boundaries/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate surface check rejects non-PR gates without a tier reason", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      manifest(manifest) {
        manifest.gates.find((gate) => gate.id === "aggregate-full-check").tierReason = "";
      }
    });

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /aggregate-full-check is main-only but has an empty tierReason/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate surface check includes a bypass fixture for missing boundary bypass coverage", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      manifest(manifest) {
        manifest.gates.find((gate) => gate.id === "check-import-boundaries").bypassFixtureRequired = false;
      }
    });

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /check-import-boundaries is boundary but bypassFixtureRequired is not true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gate-surface-"));
  mkdirSync(path.join(root, "tools"), { recursive: true });
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  return root;
}

function writeFixture(root, overrides = {}) {
  const manifest = makeManifest();
  const packageJson = makePackageJson();
  let workflow = makeWorkflow();
  let branchProtection = makeBranchProtection();

  overrides.manifest?.(manifest);
  overrides.packageJson?.(packageJson);
  workflow = overrides.workflow?.(workflow) ?? workflow;
  branchProtection = overrides.branchProtection?.(branchProtection) ?? branchProtection;

  writeFileSync(path.join(root, "tools/gate-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  writeFileSync(path.join(root, ".github/workflows/rewrite-ci.yml"), workflow, "utf8");
  writeFileSync(path.join(root, ".github/branch-protection.md"), branchProtection, "utf8");
}

function makeManifest() {
  return {
    schema: "harness-anything/gate-manifest/v1",
    surfaces: {
      packageJson: {
        check: ["typecheck", "check-gate-surface", "check-import-boundaries"],
        checkPr: ["typecheck", "check-gate-surface", "check-import-boundaries"]
      },
      rewriteCi: {
        pullRequestGateJobs: ["typecheck", "boundaries"],
        helperJobsNotRegisteredAsGates: [],
        nonPullRequestGateJobs: ["full-check"]
      },
      branchProtection: {
        requiredContexts: ["typecheck (24)", "boundaries"],
        enforceAdmins: false
      }
    },
    gates: [
      {
        id: "aggregate-full-check",
        aggregate: true,
        command: "npm run check",
        category: "meta-governance",
        tier: "main-only",
        tierReason: "Full aggregate check runs outside pull_request.",
        authoritySource: ["package.json:scripts.check"],
        consumerScope: ["full gate suite"],
        githubContext: {
          requiredContexts: [],
          workflowJobs: ["full-check"],
          nodeVersions: [24]
        },
        allowlistPolicy: { allowed: false },
        bypassFixtureRequired: false,
        executionSurfaces: {
          packageJson: { check: false, checkPr: false, script: "check" },
          rewriteCi: { pullRequestJobs: [], nonPullRequestJobs: ["full-check"] },
          branchProtection: { required: false, contexts: [] }
        }
      },
      {
        id: "typecheck",
        command: "npm run typecheck",
        category: "local-consistency",
        tier: "pr-required",
        authoritySource: ["tsconfig.json"],
        consumerScope: ["TypeScript project references"],
        githubContext: {
          requiredContexts: ["typecheck (24)"],
          workflowJobs: ["typecheck"],
          nodeVersions: [24]
        },
        allowlistPolicy: { allowed: false },
        bypassFixtureRequired: false,
        executionSurfaces: {
          packageJson: { check: true, checkPr: true, script: "typecheck" },
          rewriteCi: { pullRequestJobs: ["typecheck"], nonPullRequestJobs: [] },
          branchProtection: { required: true, contexts: ["typecheck (24)"] }
        }
      },
      {
        id: "check-gate-surface",
        command: "npm run harness:check-gate-surface",
        category: "meta-governance",
        tier: "pr-required",
        authoritySource: ["tools/gate-manifest.json"],
        consumerScope: ["gate execution surfaces"],
        githubContext: {
          requiredContexts: ["boundaries"],
          workflowJobs: ["boundaries"],
          nodeVersions: [24]
        },
        allowlistPolicy: { allowed: false },
        bypassFixtureRequired: false,
        executionSurfaces: {
          packageJson: { check: true, checkPr: true, script: "harness:check-gate-surface" },
          rewriteCi: { pullRequestJobs: ["boundaries"], nonPullRequestJobs: [] },
          branchProtection: { required: true, contexts: ["boundaries"] }
        }
      },
      {
        id: "check-import-boundaries",
        command: "npm run harness:check-import-boundaries",
        category: "boundary",
        tier: "pr-required",
        authoritySource: ["package.json:workspaces"],
        consumerScope: ["cross-package import graph"],
        githubContext: {
          requiredContexts: ["boundaries"],
          workflowJobs: ["boundaries"],
          nodeVersions: [24]
        },
        allowlistPolicy: { allowed: false },
        bypassFixtureRequired: true,
        executionSurfaces: {
          packageJson: { check: true, checkPr: true, script: "harness:check-import-boundaries" },
          rewriteCi: { pullRequestJobs: ["boundaries"], nonPullRequestJobs: [] },
          branchProtection: { required: true, contexts: ["boundaries"] }
        }
      }
    ]
  };
}

function makePackageJson() {
  return {
    type: "module",
    scripts: {
      check: "npm run typecheck && npm run harness:check-gate-surface && npm run harness:check-import-boundaries",
      "check:pr": "npm run typecheck && npm run harness:check-gate-surface && npm run harness:check-import-boundaries",
      typecheck: "tsc -b --pretty false",
      "harness:check-gate-surface": "node tools/check-gate-surface.mjs",
      "harness:check-import-boundaries": "node tools/check-import-boundaries.mjs"
    }
  };
}

function makeWorkflow() {
  return [
    "name: rewrite-ci",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches:",
    "      - main",
    "jobs:",
    "  full-check:",
    "    if: github.event_name != 'pull_request'",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm ci",
    "      - run: git diff --check",
    "      - run: npm run check",
    "  typecheck:",
    "    if: github.event_name == 'pull_request'",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm ci",
    "      - run: npm run typecheck",
    "  boundaries:",
    "    if: github.event_name == 'pull_request'",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm ci",
    "      - run: npm run harness:check-gate-surface",
    "      - run: npm run harness:check-import-boundaries",
    ""
  ].join("\n");
}

function makeBranchProtection() {
  return [
    "# Branch Protection Policy",
    "",
    "The current GitHub branch-protection configuration for `main` has administrator",
    "enforcement disabled and requires these status contexts:",
    "",
    "- typecheck (24)",
    "- boundaries",
    "",
    "## Admin Bypass",
    "",
    "Bypass must be recorded.",
    ""
  ].join("\n");
}

function runChecker(cwd) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd,
    encoding: "utf8"
  });
}
