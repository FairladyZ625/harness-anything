// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-gate-manifest-invariants.mjs");

test("accepts a consistent deterministic gate on local, PR, and main-full surfaces", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      deterministic: true,
      surfaceClasses: ["local", "pr", "main-full"],
      pullRequestJobs: ["boundaries"]
    });

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Gate manifest invariants passed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("positive control rejects a deterministic gate without the PR execution surface", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      deterministic: true,
      surfaceClasses: ["local", "main-full"],
      pullRequestJobs: []
    });

    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /example-gate is deterministic but executionSurfaces\.classes omits pr/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects manifest workflow execution surfaces that drift from the actual job steps", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      deterministic: true,
      surfaceClasses: ["local", "pr", "main-full"],
      pullRequestJobs: ["boundaries"],
      workflowRun: "echo manifest runner was removed"
    });

    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /example-gate declares PR workflow job boundaries, but its command is absent from that job/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an actual PR gate job that is absent from the manifest workflow inventory", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      deterministic: true,
      surfaceClasses: ["local", "pr", "main-full"],
      pullRequestJobs: ["boundaries"],
      workflowExtra: [
        "  extra-gate:",
        "    if: github.event_name == 'pull_request'",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm run harness:extra-gate"
      ]
    });

    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /workflow PR gate jobs contains unmanifested job extra-gate/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a main-full declaration when the full-check aggregate step drifts", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      deterministic: true,
      surfaceClasses: ["local", "pr", "main-full"],
      pullRequestJobs: ["boundaries"],
      fullCheckRun: "echo full check was removed"
    });

    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /example-gate declares non-PR workflow job full-check, but its command is absent from that job/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects canonical PR surface labels without a declared PR workflow job", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      deterministic: false,
      surfaceClasses: ["local", "pr", "main-full"],
      pullRequestJobs: []
    });

    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /example-gate executionSurfaces\.classes pr does not match its PR workflow jobs/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an unmanifested command added to an existing PR gate job", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      deterministic: true,
      surfaceClasses: ["local", "pr", "main-full"],
      pullRequestJobs: ["boundaries"],
      workflowRun: "npm run harness:unmanifested"
    });

    const result = runChecker(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /workflow job boundaries runs unmanifested command "npm run harness:unmanifested"/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gate-invariants-"));
  mkdirSync(path.join(root, "tools"), { recursive: true });
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  return root;
}

function writeFixture(root, {
  deterministic,
  surfaceClasses,
  pullRequestJobs,
  workflowRun = "node tools/run-manifest-gates.mjs --workflow-job boundaries",
  workflowExtra = [],
  fullCheckRun = "npm run check"
}) {
  const manifest = {
    schema: "harness-anything/gate-manifest/v2",
    surfaces: {
      localStop: { gateIds: ["example-gate"] },
      rewriteCi: {
        pullRequestGateJobs: ["boundaries"],
        helperJobsNotRegisteredAsGates: [],
        nonPullRequestGateJobs: ["full-check"]
      }
    },
    gates: [
      {
        id: "aggregate-full-check",
        aggregate: true,
        command: "npm run check",
        deterministic: false,
        positiveControl: {
          status: "not-applicable",
          evidence: ["Composite runner; leaf gates own positive controls."]
        },
        executionSurfaces: {
          classes: ["local", "main-full"],
          packageJson: { check: true, checkPr: false, script: "check" },
          rewriteCi: { pullRequestJobs: [], nonPullRequestJobs: ["full-check"] },
          branchProtection: { required: false, contexts: [] }
        }
      },
      {
        id: "example-gate",
        command: "npm run harness:example-gate",
        category: "boundary",
        tier: "pr-required",
        deterministic,
        positiveControl: {
          status: "covered",
          evidence: ["tools/example-gate.test.mjs"]
        },
        executionSurfaces: {
          classes: surfaceClasses,
          packageJson: { check: true, checkPr: true, script: "harness:example-gate" },
          rewriteCi: { pullRequestJobs, nonPullRequestJobs: ["full-check"] },
          branchProtection: { required: true, contexts: ["boundaries"] }
        }
      }
    ]
  };
  const workflow = [
    "name: rewrite-ci",
    "on: [pull_request, push]",
    "jobs:",
    "  full-check:",
    "    if: github.event_name != 'pull_request'",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - run: ${fullCheckRun}`,
    "  boundaries:",
    "    if: github.event_name == 'pull_request'",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - run: ${workflowRun}`,
    ...workflowExtra,
    ""
  ].join("\n");

  writeFileSync(path.join(root, "tools/gate-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(path.join(root, ".github/workflows/rewrite-ci.yml"), workflow, "utf8");
}

function runChecker(root) {
  return spawnSync(process.execPath, [checkerPath, "--root", root], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });
}
