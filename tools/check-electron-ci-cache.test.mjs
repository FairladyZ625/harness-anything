// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CACHE_ACTION_FILE, CACHE_ACTION_PATH, checkElectronCiCache } from "./check-electron-ci-cache.mjs";

const actionText = `name: Cache the Electron runtime
runs:
  using: composite
  steps:
    - name: Point Electron's installer at the shared cache directory
      shell: bash
      run: echo "electron_config_cache=$HOME/.cache/electron" >> "$GITHUB_ENV"
    - name: Resolve the locked Electron version
      id: electron-version
      shell: bash
      run: echo "version=$(node tools/ci/electron-runtime.mjs --version)" >> "$GITHUB_OUTPUT"
    - name: Restore the Electron download cache
      uses: actions/cache@v4
      with:
        path: ~/.cache/electron
        key: electron-\${{ runner.os }}-\${{ runner.arch }}-\${{ steps.electron-version.outputs.version }}
    - name: Download the Electron runtime once with bounded retries
      shell: bash
      run: node tools/ci/electron-runtime.mjs
`;

function cacheStep(indent = "      ") {
  return `${indent}- uses: ${CACHE_ACTION_PATH}\n`;
}

function workflow(jobBody) {
  return `name: rewrite-ci\non:\n  pull_request:\njobs:\n${jobBody}`;
}

function check(text, { action = actionText } = {}) {
  return checkElectronCiCache({
    workflows: [{ name: ".github/workflows/rewrite-ci.yml", text }],
    actionText: action,
    workflowNames: [],
  });
}

test("the repository workflow and cache action satisfy the gate", () => {
  const result = checkElectronCiCache();
  assert.deepEqual(result.findings, []);
});

test("a job that runs npm ci without the cache action is rejected", () => {
  const result = check(
    workflow(`  install:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.findings.join("\n"), /job install .*does not use/u);
});

test("a newly added Electron-importing test lane is covered by the command, not a job allowlist", () => {
  const result = check(
    workflow(`  new-suite:
    runs-on: ubuntu-latest
    steps:
      - run: node tools/run-manifest-gates.mjs --workflow-job integration-shard --shard 7
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.findings.join("\n"), /job new-suite .*integration/u);
});

test("the cache action must run before the command that needs it", () => {
  const result = check(
    workflow(`  fast-contract:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
${cacheStep()}- run: node tools/run-manifest-gates.mjs --workflow-job fast-contract
`),
  );
  assert.equal(result.ok, false);
  assert.match(result.findings.join("\n"), /places .* after the command that needs it/u);
});

test("a job that does not touch Electron needs no cache action", () => {
  const result = check(
    workflow(`  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
`),
  );
  assert.deepEqual(result.findings, []);
});

test("the cache action itself must keep the official path, version key and bounded retry", () => {
  const brokenAction = actionText
    .replace("path: ~/.cache/electron", "path: ~/.cache/somewhere-else")
    .replace("node tools/ci/electron-runtime.mjs\n", "echo skipped\n");
  const result = check(
    workflow(`  install:
    runs-on: ubuntu-latest
    steps:
${cacheStep()}- run: npm ci
`),
    { action: brokenAction },
  );
  assert.equal(result.ok, false);
  const findings = result.findings.join("\n");
  assert.match(
    findings,
    new RegExp(`${CACHE_ACTION_FILE.replaceAll(".", "\\.")} is missing the ~/.cache/electron path`, "u"),
  );
  assert.match(findings, /missing the node tools\/ci\/electron-runtime\.mjs bounded-retry step/u);
});

test("a missing cache action file is a finding", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "electron-cache-gate-"));
  try {
    const result = checkElectronCiCache({
      repoRoot,
      workflows: [
        {
          name: ".github/workflows/rewrite-ci.yml",
          text: workflow("  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n"),
        },
      ],
      workflowNames: [],
    });
    assert.equal(result.ok, false);
    assert.match(result.findings.join("\n"), /action\.yml is missing/u);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
