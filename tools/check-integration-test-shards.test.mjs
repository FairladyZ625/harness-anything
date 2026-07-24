// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkIntegrationTestShards,
  validateIntegrationShardRequiredContexts,
  validateIntegrationShardWorkflowMatrix
} from "./check-integration-test-shards.mjs";
import { assignIntegrationTestShards, validateIntegrationTestShards } from "./integration-test-shards.mjs";

test("integration shard declaration is non-overlapping and complete", () => {
  const result = checkIntegrationTestShards();
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.ok(result.currentCount > 0);
  assert.deepEqual(result.workflowShards, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(result.requiredContexts, [
    "integration-shard (1)",
    "integration-shard (2)",
    "integration-shard (3)",
    "integration-shard (4)",
    "integration-shard (5)",
    "integration-shard (6)"
  ]);
  assert.equal(result.summaries.length, 6);
  assert.ok(result.summaries.every((summary) => summary.files > 0));
});

test("new integration tests are assigned without manifest or shard registration", () => {
  const files = ["tools/z.test.mjs", "tools/a.test.mjs", "tools/new.test.mjs"];
  const shards = assignIntegrationTestShards(files, {
    "tools/a.test.mjs": 10,
    "tools/z.test.mjs": 20
  }, 2, 5);

  assert.deepEqual(shards, [
    { id: 1, files: ["tools/z.test.mjs"] },
    { id: 2, files: ["tools/a.test.mjs", "tools/new.test.mjs"] }
  ]);
});

test("a new inline-declared integration test is discovered without central registration", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integration-discovery-"));
  try {
    const testRoot = path.join(root, "tools");
    mkdirSync(testRoot, { recursive: true });
    for (let index = 1; index <= 7; index += 1) {
      writeFileSync(path.join(testRoot, `fixture-${index}.test.mjs`), "// harness-test-tier: integration\n", "utf8");
    }
    const result = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {},
      previousTestCount: 6,
      deletionAllowlistText: deletionAllowlistText()
    });
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(result.delta, 1);
    assert.deepEqual(result.derivedFiles, result.executionFiles);
    assert.ok(result.derivedFiles.includes("tools/fixture-7.test.mjs"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default shard assignment is deterministic across discovery order", () => {
  const files = ["tools/c.test.mjs", "tools/a.test.mjs", "tools/b.test.mjs", "tools/d.test.mjs"];
  const forward = assignIntegrationTestShards(files, {}, 2, 10);
  const reverse = assignIntegrationTestShards([...files].reverse(), {}, 2, 10);
  assert.deepEqual(forward, reverse);
});

test("moving an integration test to nightly does not count as deleting coverage", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integration-to-nightly-"));
  try {
    const testRoot = path.join(root, "tools");
    mkdirSync(testRoot, { recursive: true });
    for (let index = 1; index <= 7; index += 1) {
      writeFileSync(path.join(testRoot, `fixture-${index}.test.mjs`), "// harness-test-tier: integration\n", "utf8");
    }
    writeDeletionAllowlist(root);
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Harness Test"]);
    git(root, ["config", "user.email", "harness@example.test"]);
    git(root, ["add", "tools"]);
    git(root, ["commit", "-qm", "register integration tests"]);

    writeFileSync(path.join(testRoot, "fixture-7.test.mjs"), "// harness-test-tier: nightly\n", "utf8");
    const unapproved = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {},
      nightlyWeightOverrides: {},
      deletionAllowlistText: deletionAllowlistText()
    });
    assert.equal(unapproved.ok, false);
    assert.match(unapproved.errors.join("\n"), /moved to nightly without a decision reference/u);

    writeFileSync(path.join(testRoot, "fixture-7.test.mjs"), [
      "// harness-test-tier: nightly",
      "// harness-test-tier-decision: dec_TEST_NIGHTLY_MOVE",
      ""
    ].join("\n"), "utf8");
    const after = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {},
      nightlyWeightOverrides: {},
      deletionAllowlistText: deletionAllowlistText()
    });
    assert.equal(after.ok, true, after.errors.join("\n"));
    assert.equal(after.currentCount, 6);
    assert.deepEqual(after.deletedFiles, []);
    assert.deepEqual(after.movedToNightlyFiles, ["tools/fixture-7.test.mjs"]);
    assert.deepEqual(after.nightlyFiles, ["tools/fixture-7.test.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration shard validation rejects duplicate inputs and stale weight overrides", () => {
  const result = validateIntegrationTestShards(
    ["tools/a.test.mjs", "tools/a.test.mjs"],
    { "tools/missing.test.mjs": 10 }
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "integration manifest contains duplicate files",
    "integration weight references non-integration file: tools/missing.test.mjs",
    "derived integration shard is empty"
  ]);
});

test("integration count ratchet rejects a real deleted test file from disk", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integration-ratchet-"));
  try {
    const testRoot = path.join(root, "tools");
    mkdirSync(testRoot, { recursive: true });
    for (let index = 1; index <= 7; index += 1) {
      writeFileSync(path.join(testRoot, `fixture-${index}.test.mjs`), "// harness-test-tier: integration\n", "utf8");
    }
    writeDeletionAllowlist(root);

    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Harness Test"]);
    git(root, ["config", "user.email", "harness@example.test"]);
    git(root, ["add", "tools"]);
    git(root, ["commit", "-qm", "register integration tests"]);

    unlinkSync(path.join(testRoot, "fixture-7.test.mjs"));
    const after = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {}
    });
    assert.equal(after.ok, false);
    assert.equal(after.currentCount, 6);
    assert.equal(after.previousCount, 7);
    assert.equal(after.delta, -1);
    assert.match(after.errors.join("\n"), /integration test count decreased without path confirmation: current=6 previous=7 delta=-1/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration count ratchet accepts an intentional deletion with a new exact-path confirmation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integration-confirmed-deletion-"));
  try {
    const testRoot = path.join(root, "tools");
    mkdirSync(testRoot, { recursive: true });
    for (let index = 1; index <= 7; index += 1) {
      writeFileSync(path.join(testRoot, `fixture-${index}.test.mjs`), "// harness-test-tier: integration\n", "utf8");
    }
    writeDeletionAllowlist(root);

    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Harness Test"]);
    git(root, ["config", "user.email", "harness@example.test"]);
    git(root, ["add", "tools"]);
    git(root, ["commit", "-qm", "register integration tests"]);

    unlinkSync(path.join(testRoot, "fixture-7.test.mjs"));
    writeDeletionAllowlist(root, [{
      value: "tools/fixture-7.test.mjs",
      ref: "task_01KX815CJ22WY13QCR0Q3HX4F9",
      reason: "The fixture models an explicitly reviewed removal."
    }]);
    const after = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {}
    });

    assert.equal(after.ok, true, after.errors.join("\n"));
    assert.equal(after.delta, -1);
    assert.deepEqual(after.deletedFiles, ["tools/fixture-7.test.mjs"]);
    assert.deepEqual(after.confirmedDeletions, ["tools/fixture-7.test.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an already-merged deletion confirmation does not burden an unrelated later change", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integration-persisted-confirmation-"));
  try {
    const testRoot = path.join(root, "tools");
    mkdirSync(testRoot, { recursive: true });
    for (let index = 1; index <= 6; index += 1) {
      writeFileSync(path.join(testRoot, `fixture-${index}.test.mjs`), "// harness-test-tier: integration\n", "utf8");
    }
    writeDeletionAllowlist(root, [{
      value: "tools/fixture-7.test.mjs",
      ref: "task_01KX815CJ22WY13QCR0Q3HX4F9",
      reason: "The prior change intentionally removed this fixture."
    }]);

    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Harness Test"]);
    git(root, ["config", "user.email", "harness@example.test"]);
    git(root, ["add", "tools"]);
    git(root, ["commit", "-qm", "baseline after intentional deletion"]);

    writeFileSync(path.join(root, "tools/unrelated.txt"), "later change\n", "utf8");
    const result = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {}
    });
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(result.delta, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a persisted deletion confirmation is rejected if its path reappears", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integration-reappeared-confirmation-"));
  try {
    const testRoot = path.join(root, "tools");
    mkdirSync(testRoot, { recursive: true });
    for (let index = 1; index <= 6; index += 1) {
      writeFileSync(path.join(testRoot, `fixture-${index}.test.mjs`), "// harness-test-tier: integration\n", "utf8");
    }
    writeDeletionAllowlist(root, [{
      value: "tools/fixture-7.test.mjs",
      ref: "task_01KX815CJ22WY13QCR0Q3HX4F9",
      reason: "The prior change intentionally removed this fixture."
    }]);

    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Harness Test"]);
    git(root, ["config", "user.email", "harness@example.test"]);
    git(root, ["add", "tools"]);
    git(root, ["commit", "-qm", "baseline after intentional deletion"]);

    writeFileSync(path.join(testRoot, "fixture-7.test.mjs"), "// harness-test-tier: integration\n", "utf8");
    const result = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {}
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /intentional test deletion path exists on disk: tools\/fixture-7\.test\.mjs/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

test("integration count ratchet fails closed when the Git baseline is unavailable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integration-no-git-"));
  try {
    mkdirSync(path.join(root, "tools"), { recursive: true });
    for (let index = 1; index <= 6; index += 1) {
      writeFileSync(path.join(root, "tools", `fixture-${index}.test.mjs`), "// harness-test-tier: integration\n", "utf8");
    }
    const result = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {},
      deletionAllowlistText: deletionAllowlistText()
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /unable to resolve previous integration test count from Git baseline/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration count ratchet excludes hidden-directory fixtures from the Git baseline", () => {
  // A hidden-directory fixture (e.g. tools/test-fixtures/.runner-stall/*.test.mjs)
  // is intentionally undiscoverable: current discovery's `walk` skips dot-directories
  // so it is never a counted test. The baseline resolver reads the tree with
  // `git ls-tree`, which lists every tracked file including those under
  // dot-directories; it must apply the same exclusion, or the unmarked fixture
  // poisons marker resolution and the ratchet fails closed with
  // "unable to resolve previous integration test count".
  const root = mkdtempSync(path.join(tmpdir(), "ha-integration-hidden-fixture-"));
  try {
    const testRoot = path.join(root, "tools");
    mkdirSync(testRoot, { recursive: true });
    for (let index = 1; index <= 6; index += 1) {
      writeFileSync(path.join(testRoot, `fixture-${index}.test.mjs`), "// harness-test-tier: integration\n", "utf8");
    }
    const hiddenFixtureDir = path.join(testRoot, "test-fixtures/.runner-stall");
    mkdirSync(hiddenFixtureDir, { recursive: true });
    writeFileSync(path.join(hiddenFixtureDir, "wedge.test.mjs"), "// intentional wedge fixture, no tier marker\n", "utf8");
    writeDeletionAllowlist(root);

    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Harness Test"]);
    git(root, ["config", "user.email", "harness@example.test"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "register integration tests and a hidden fixture"]);

    // Dirty the worktree so resolveBaselineRef returns HEAD, forcing the ls-tree
    // baseline path against the commit that carries the hidden fixture.
    writeFileSync(path.join(testRoot, "unrelated.txt"), "later change\n", "utf8");
    const result = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {}
    });

    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(result.delta, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeDeletionAllowlist(root, entries = []) {
  const allowlistRoot = path.join(root, "tools/gate-allowlists");
  mkdirSync(allowlistRoot, { recursive: true });
  writeFileSync(
    path.join(allowlistRoot, "check-integration-test-shards.json"),
    deletionAllowlistText(entries),
    "utf8"
  );
}

function deletionAllowlistText(entries = []) {
  return JSON.stringify({
    schema: "harness-anything/gate-allowlist/v1",
    gateId: "check-integration-test-shards",
    entries: { intentionalTestDeletions: entries }
  });
}

test("integration shard checker rejects workflow matrix drift", () => {
  const workflow = [
    "jobs:",
    "  integration-shard:",
    "    strategy:",
    "      matrix:",
    "        shard: [1, 2, 3, 4]",
    "  integration:",
    "    needs: [integration-shard]"
  ].join("\n");

  assert.deepEqual(validateIntegrationShardWorkflowMatrix(workflow, 6), {
    shards: [1, 2, 3, 4],
    errors: ["integration-shard workflow matrix mismatch: expected [1, 2, 3, 4, 5, 6], got [1, 2, 3, 4]"]
  });
});

test("integration shard checker requires exact workflow matrix ordering", () => {
  const workflow = [
    "jobs:",
    "  integration-shard:",
    "    strategy:",
    "      matrix:",
    "        shard: [1, 3, 2, 4, 5, 6]"
  ].join("\n");

  assert.deepEqual(validateIntegrationShardWorkflowMatrix(workflow, 6).errors, [
    "integration-shard workflow matrix mismatch: expected [1, 2, 3, 4, 5, 6], got [1, 3, 2, 4, 5, 6]"
  ]);
});

test("integration shard checker rejects gate manifest required context drift", () => {
  const gateManifest = JSON.stringify({
    gates: [
      {
        id: "test-integration",
        githubContext: {
          requiredContexts: [
            "integration-shard (1)",
            "integration-shard (2)",
            "integration-shard (3)",
            "integration-shard (4)",
            "integration-shard (5)"
          ]
        },
        executionSurfaces: {
          branchProtection: {
            contexts: [
              "integration-shard (1)",
              "integration-shard (2)",
              "integration-shard (3)",
              "integration-shard (4)",
              "integration-shard (5)"
            ]
          }
        }
      }
    ]
  });

  assert.deepEqual(validateIntegrationShardRequiredContexts(gateManifest, 6), {
    contexts: [
      "integration-shard (1)",
      "integration-shard (2)",
      "integration-shard (3)",
      "integration-shard (4)",
      "integration-shard (5)"
    ],
    errors: [
      "test-integration githubContext.requiredContexts mismatch: expected [integration-shard (1), integration-shard (2), integration-shard (3), integration-shard (4), integration-shard (5), integration-shard (6)], got [integration-shard (1), integration-shard (2), integration-shard (3), integration-shard (4), integration-shard (5)]",
      "test-integration executionSurfaces.branchProtection.contexts mismatch: expected [integration-shard (1), integration-shard (2), integration-shard (3), integration-shard (4), integration-shard (5), integration-shard (6)], got [integration-shard (1), integration-shard (2), integration-shard (3), integration-shard (4), integration-shard (5)]"
    ]
  });
});
