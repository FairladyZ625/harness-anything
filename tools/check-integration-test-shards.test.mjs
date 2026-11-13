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
  validateIntegrationShardWorkflowMatrix,
} from "./check-integration-test-shards.mjs";
import {
  assignIntegrationTestShards,
  defaultIntegrationTestWeightMs,
  estimateIntegrationShardWallMs,
  integrationFileBudgetMs,
  integrationShardCount,
  integrationShardWallSpreadBudgetMs,
  integrationTestFileWeightsMs,
  integrationWeightOverruns,
  validateIntegrationTestShards,
} from "./integration-test-shards.mjs";
import { integrationWeightsFromLogs } from "./refresh-integration-test-weights.mjs";

test("integration shard declaration is non-overlapping and complete", () => {
  const result = checkIntegrationTestShards();
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.ok(result.currentCount > 0);
  assert.deepEqual(
    result.workflowShards,
    Array.from({ length: integrationShardCount }, (_, index) => index + 1),
  );
  assert.deepEqual(
    result.requiredContexts,
    Array.from({ length: integrationShardCount }, (_, index) => `integration-shard (${index + 1})`),
  );
  assert.equal(result.summaries.length, integrationShardCount);
  assert.ok(result.summaries.every((summary) => summary.files > 0));
});

test("integration shard estimated wall spread stays inside the balance budget", () => {
  const result = checkIntegrationTestShards();
  assert.equal(result.ok, true, result.errors.join("\n"));
  const estimatedWalls = result.summaries.map((summary) => summary.estimatedWallMs);
  const spread = Math.max(...estimatedWalls) - Math.min(...estimatedWalls);
  assert.ok(
    spread <= integrationShardWallSpreadBudgetMs,
    `estimated wall spread ${spread}ms exceeds ${integrationShardWallSpreadBudgetMs}ms: ${estimatedWalls.join(", ")}`,
  );
});

test("each shard hands files over heavy-first so a late large file cannot extend the tail", () => {
  const result = checkIntegrationTestShards();
  const shards = assignIntegrationTestShards(result.derivedFiles);
  for (const shard of shards) {
    const weights = shard.files.map((file) => integrationTestFileWeightsMs[file] ?? defaultIntegrationTestWeightMs);
    assert.deepEqual(
      weights,
      [...weights].sort((left, right) => right - left),
      `shard ${shard.id} must return the heaviest file first`,
    );
  }
});

test("the wall estimate follows hand-over order: heavy-first removes a late-file tail", () => {
  const weights = {
    "a1.test.mjs": 50_000,
    "a2.test.mjs": 50_000,
    "a3.test.mjs": 50_000,
    "a4.test.mjs": 50_000,
    "z-heavy.test.mjs": 100_000,
  };
  const alphabetical = ["a1.test.mjs", "a2.test.mjs", "a3.test.mjs", "a4.test.mjs", "z-heavy.test.mjs"];
  const heavyFirst = [...alphabetical].sort((left, right) => weights[right] - weights[left]);
  assert.equal(estimateIntegrationShardWallMs(alphabetical, weights), 150_000);
  assert.equal(estimateIntegrationShardWallMs(heavyFirst, weights), 100_000);
  assert.ok(
    estimateIntegrationShardWallMs(alphabetical, weights) - estimateIntegrationShardWallMs(heavyFirst, weights) >
      integrationShardWallSpreadBudgetMs,
  );
});

test("new integration tests are assigned without manifest or shard registration", () => {
  const files = ["tools/z.test.mjs", "tools/a.test.mjs", "tools/new.test.mjs"];
  const shards = assignIntegrationTestShards(
    files,
    {
      "tools/a.test.mjs": 10,
      "tools/z.test.mjs": 20,
    },
    2,
    5,
  );

  assert.deepEqual(shards, [
    { id: 1, files: ["tools/z.test.mjs"] },
    { id: 2, files: ["tools/a.test.mjs", "tools/new.test.mjs"] },
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
    writeShardPadding(testRoot);
    const result = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {},
      previousTestCount: 6 + integrationShardCount,
      deletionAllowlistText: deletionAllowlistText(),
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

test("integration shard validation rejects duplicate inputs and stale weight overrides", () => {
  const result = validateIntegrationTestShards(["tools/a.test.mjs", "tools/a.test.mjs"], {
    "tools/missing.test.mjs": 10,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "integration manifest contains duplicate files",
    "integration weight references non-integration file: tools/missing.test.mjs",
    "derived integration shard is empty",
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
    writeShardPadding(testRoot);
    writeDeletionAllowlist(root);

    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Harness Test"]);
    git(root, ["config", "user.email", "harness@example.test"]);
    git(root, ["add", "tools"]);
    git(root, ["commit", "-qm", "register integration tests"]);

    unlinkSync(path.join(testRoot, "fixture-7.test.mjs"));
    const after = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {},
    });
    assert.equal(after.ok, false);
    assert.equal(after.currentCount, 6 + integrationShardCount);
    assert.equal(after.previousCount, 7 + integrationShardCount);
    assert.equal(after.delta, -1);
    assert.match(
      after.errors.join("\n"),
      new RegExp(
        `integration test count decreased without path confirmation: current=${6 + integrationShardCount} previous=${7 + integrationShardCount} delta=-1`,
        "u",
      ),
    );
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
    writeShardPadding(testRoot);
    writeDeletionAllowlist(root);

    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Harness Test"]);
    git(root, ["config", "user.email", "harness@example.test"]);
    git(root, ["add", "tools"]);
    git(root, ["commit", "-qm", "register integration tests"]);

    unlinkSync(path.join(testRoot, "fixture-7.test.mjs"));
    writeDeletionAllowlist(root, [
      {
        value: "tools/fixture-7.test.mjs",
        ref: "task_01KX815CJ22WY13QCR0Q3HX4F9",
        reason: "The fixture models an explicitly reviewed removal.",
      },
    ]);
    const after = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {},
    });

    assert.equal(after.ok, true, after.errors.join("\n"));
    assert.equal(after.delta, -1);
    assert.deepEqual(after.deletedFiles, ["tools/fixture-7.test.mjs"]);
    assert.deepEqual(after.confirmedDeletions, ["tools/fixture-7.test.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration deletion confirmations require exact real task ids", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-integration-task-ref-"));
  try {
    const testRoot = path.join(root, "tools");
    mkdirSync(testRoot, { recursive: true });
    for (let index = 1; index <= 7; index += 1) {
      writeFileSync(path.join(testRoot, `fixture-${index}.test.mjs`), "// harness-test-tier: integration\n", "utf8");
    }
    writeShardPadding(testRoot);
    writeDeletionAllowlist(root);
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Harness Test"]);
    git(root, ["config", "user.email", "harness@example.test"]);
    git(root, ["add", "tools"]);
    git(root, ["commit", "-qm", "register integration tests"]);
    unlinkSync(path.join(testRoot, "fixture-7.test.mjs"));

    for (const ref of [
      "task_P4_INT",
      "task_2301",
      "task_0123456789abcdef012345678",
      "task_01KX815CJ22WY13QCR0Q3HX4F9",
      "task_f7cc215a54a194898ad733c20a",
    ]) {
      writeDeletionAllowlist(root, [
        {
          value: "tools/fixture-7.test.mjs",
          ref,
          reason: "The fixture models an explicitly reviewed removal.",
        },
      ]);
      const result = checkIntegrationTestShards({ repoRoot: root, weightOverrides: {} });
      const expectedValid = ["task_01KX815CJ22WY13QCR0Q3HX4F9", "task_f7cc215a54a194898ad733c20a"].includes(ref);
      assert.equal(result.ok, expectedValid, `${ref}: ${result.errors.join("\n")}`);
    }
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
    writeShardPadding(testRoot);
    writeDeletionAllowlist(root, [
      {
        value: "tools/fixture-7.test.mjs",
        ref: "task_P4_INT",
        reason: "The prior change intentionally removed this fixture.",
      },
    ]);

    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Harness Test"]);
    git(root, ["config", "user.email", "harness@example.test"]);
    git(root, ["add", "tools"]);
    git(root, ["commit", "-qm", "baseline after intentional deletion"]);

    writeDeletionAllowlist(root, [
      {
        value: "tools/fixture-7.test.mjs",
        ref: "task_01KX815CJ22WY13QCR0Q3HX4F9",
        reason: "The prior change intentionally removed this fixture.",
      },
    ]);
    writeFileSync(path.join(root, "tools/unrelated.txt"), "later change\n", "utf8");
    const result = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {},
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
    writeShardPadding(testRoot);
    writeDeletionAllowlist(root, [
      {
        value: "tools/fixture-7.test.mjs",
        ref: "task_01KX815CJ22WY13QCR0Q3HX4F9",
        reason: "The prior change intentionally removed this fixture.",
      },
    ]);

    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Harness Test"]);
    git(root, ["config", "user.email", "harness@example.test"]);
    git(root, ["add", "tools"]);
    git(root, ["commit", "-qm", "baseline after intentional deletion"]);

    writeFileSync(path.join(testRoot, "fixture-7.test.mjs"), "// harness-test-tier: integration\n", "utf8");
    const result = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {},
    });
    assert.equal(result.ok, false);
    assert.match(
      result.errors.join("\n"),
      /intentional test deletion path exists on disk: tools\/fixture-7\.test\.mjs/u,
    );
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
      writeFileSync(
        path.join(root, "tools", `fixture-${index}.test.mjs`),
        "// harness-test-tier: integration\n",
        "utf8",
      );
    }
    const result = checkIntegrationTestShards({
      repoRoot: root,
      weightOverrides: {},
      deletionAllowlistText: deletionAllowlistText(),
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /unable to resolve previous integration test count from Git baseline/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeDeletionAllowlist(root, entries = []) {
  const allowlistRoot = path.join(root, "tools/gate-allowlists");
  mkdirSync(allowlistRoot, { recursive: true });
  writeFileSync(path.join(allowlistRoot, "check-integration-test-shards.json"), deletionAllowlistText(entries), "utf8");
}

function deletionAllowlistText(entries = []) {
  return JSON.stringify({
    schema: "harness-anything/gate-allowlist/v1",
    gateId: "check-integration-test-shards",
    entries: { intentionalTestDeletions: entries },
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
    "    needs: [integration-shard]",
  ].join("\n");

  assert.deepEqual(validateIntegrationShardWorkflowMatrix(workflow, 6), {
    shards: [1, 2, 3, 4],
    errors: ["integration-shard workflow matrix mismatch: expected [1, 2, 3, 4, 5, 6], got [1, 2, 3, 4]"],
  });
});

test("integration shard checker requires exact workflow matrix ordering", () => {
  const workflow = [
    "jobs:",
    "  integration-shard:",
    "    strategy:",
    "      matrix:",
    "        shard: [1, 3, 2, 4, 5, 6]",
  ].join("\n");

  assert.deepEqual(validateIntegrationShardWorkflowMatrix(workflow, 6).errors, [
    "integration-shard workflow matrix mismatch: expected [1, 2, 3, 4, 5, 6], got [1, 3, 2, 4, 5, 6]",
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
            "integration-shard (5)",
          ],
        },
        executionSurfaces: {
          branchProtection: {
            contexts: [
              "integration-shard (1)",
              "integration-shard (2)",
              "integration-shard (3)",
              "integration-shard (4)",
              "integration-shard (5)",
            ],
          },
        },
      },
    ],
  });

  assert.deepEqual(validateIntegrationShardRequiredContexts(gateManifest, 6), {
    contexts: [
      "integration-shard (1)",
      "integration-shard (2)",
      "integration-shard (3)",
      "integration-shard (4)",
      "integration-shard (5)",
    ],
    errors: [
      "test-integration githubContext.requiredContexts mismatch: expected [integration-shard (1), integration-shard (2), integration-shard (3), integration-shard (4), integration-shard (5), integration-shard (6)], got [integration-shard (1), integration-shard (2), integration-shard (3), integration-shard (4), integration-shard (5)]",
      "test-integration executionSurfaces.branchProtection.contexts mismatch: expected [integration-shard (1), integration-shard (2), integration-shard (3), integration-shard (4), integration-shard (5), integration-shard (6)], got [integration-shard (1), integration-shard (2), integration-shard (3), integration-shard (4), integration-shard (5)]",
    ],
  });
});

test("a shard whose declared file weights exceed the budget fails the shard check", () => {
  const files = Array.from(
    { length: integrationShardCount },
    (_, index) => `tools/${String.fromCharCode(97 + index)}.test.mjs`,
  );
  const weights = Object.fromEntries(files.map((file) => [file, 100_000]));
  assert.equal(validateIntegrationTestShards(files, weights, { shardBudgetMs: 100_000 }).ok, true);
  const over = validateIntegrationTestShards(
    files,
    { ...weights, "tools/a.test.mjs": 100_001 },
    { shardBudgetMs: 100_000 },
  );
  assert.equal(over.ok, false);
  assert.match(over.errors.join("\n"), /integration shard \d is over budget: 100001ms/u);
});

test("a file over the per-file budget needs a recorded exception, and a stale exception fails", () => {
  const files = Array.from(
    { length: integrationShardCount },
    (_, index) => `tools/${String.fromCharCode(97 + index)}.test.mjs`,
  );
  const weights = { "tools/a.test.mjs": integrationFileBudgetMs + 100 };
  // One 180s file and one 10s file per shard is inherently unbalanced; this test is about the
  // per-file exception, so it lifts the balance ceiling and leaves it to the dedicated spread test.
  const unbalancedFixture = { wallSpreadBudgetMs: Number.MAX_SAFE_INTEGER };
  const unexplained = validateIntegrationTestShards(files, weights, unbalancedFixture);
  assert.match(unexplained.errors.join("\n"), /over the \d+ms per-file budget .*tools\/a\.test\.mjs/u);
  assert.equal(
    validateIntegrationTestShards(files, weights, {
      ...unbalancedFixture,
      overBudgetFiles: ["tools/a.test.mjs"],
    }).ok,
    true,
  );
  const stale = validateIntegrationTestShards(files, weights, {
    ...unbalancedFixture,
    overBudgetFiles: ["tools/a.test.mjs", "tools/b.test.mjs"],
  });
  assert.deepEqual(stale.errors, [
    "integration file budget exception is stale (the file is within budget or gone): tools/b.test.mjs",
  ]);
});

test("a measured file far beyond its declared weight is an overrun; runner noise is not", () => {
  const weights = { "tools/a.test.mjs": 40_000 };
  const measured = new Map([
    ["tools/a.test.mjs", 40_000 * 2 + 60_000],
    ["tools/new-small.test.mjs", defaultIntegrationTestWeightMs * 2 + 60_000],
    ["tools/new-large.test.mjs", defaultIntegrationTestWeightMs * 2 + 60_001],
  ]);
  assert.deepEqual(integrationWeightOverruns(measured, weights), [
    { file: "tools/new-large.test.mjs", durationMs: 80_001, declaredMs: defaultIntegrationTestWeightMs },
  ]);
  measured.set("tools/a.test.mjs", 140_001);
  assert.deepEqual(
    integrationWeightOverruns(measured, weights).map((overrun) => overrun.file),
    ["tools/a.test.mjs", "tools/new-large.test.mjs"],
  );
});

test("weights refresh from runner duration lines takes each file's median across runs", () => {
  const log = (a, b) =>
    [
      `integration-shard (1)\tRun node\t2026-11-08T01:00:00.0Z [node-test-duration] ${a} tools/a.test.mjs`,
      `2026-11-08T01:00:00.0Z [node-test-duration] ${b} tools/b.test.mjs`,
      "2026-11-08T01:00:00.0Z [node-test-duration] 5000 tools/not-integration.test.mjs",
    ].join("\n");
  const weights = integrationWeightsFromLogs(
    [log(10_000, 40), log(30_040, 60), log(20_000, 80)],
    ["tools/a.test.mjs", "tools/b.test.mjs", "tools/unmeasured.test.mjs"],
  );
  assert.deepEqual(weights, { "tools/a.test.mjs": 20_000, "tools/b.test.mjs": 100 });
  // An even sample count takes the mean of the middle two, so neither run alone sets the weight.
  assert.deepEqual(integrationWeightsFromLogs([log(10_000, 40), log(20_000, 60)], ["tools/a.test.mjs"]), {
    "tools/a.test.mjs": 15_000,
  });
});

test("the repository vocabulary scan weight refuses the pre-fix 84s regression", () => {
  // Jobs 129066961834, 129102988704, 129094030222, 129114323428, and 129119533868 failed the
  // shard budget because the scan covered every package at 76–86s. Sharing one re-export parse
  // and rescanning only the overridden fixture modules brought it back to about a second, so the
  // declared weight is the new measurement and the old durations must fail the overrun check
  // instead of being grandfathered as the 400ms-scope declaration did.
  const file = "tools/check-status-vocabulary.test.mjs";
  for (const durationMs of [84_855, 76_915, 86_014, 83_729, 76_175]) {
    assert.deepEqual(
      integrationWeightOverruns(new Map([[file, durationMs]])).map((entry) => entry.file),
      [file],
      `${durationMs}ms is the pre-fix regression and must exceed the declared weight`,
    );
  }
});

test("the submit risk manifest weight covers its measured historical recovery scope", () => {
  // Jobs 131271222267, 131298370421, 131308412429, 131310504878, and 131295823595 had no
  // assertion failures. Historical submission recovery expanded the scope while its weight
  // remained unregistered. The declaration uses the runner's rounded median of these five samples.
  const file = "packages/daemon/test/submit-risk-manifest.integration.test.ts";
  for (const durationMs of [69_192, 76_929, 81_469, 93_663, 105_104]) {
    assert.deepEqual(integrationWeightOverruns(new Map([[file, durationMs]])), []);
  }
});

test("baseline git source scan handles >16MiB total test sources without ENOBUFS", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "shard-git-16mib-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
    const testRoot = path.join(repoRoot, "packages", "sample", "test");
    writeShardPadding(testRoot);
    const filler = "// " + "x".repeat(120 * 1024) + "\n";
    for (let i = 0; i < 150; i += 1) {
      writeFileSync(
        path.join(testRoot, `large-${i}.integration.test.mjs`),
        `// harness-test-tier: integration\n${filler}`,
        "utf8",
      );
    }
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: repoRoot });
    const result = checkIntegrationTestShards({
      repoRoot,
      weightOverrides: {},
      baselineRef: "HEAD",
      deletionAllowlistText: deletionAllowlistText(),
    });
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(result.previousCount, 150 + integrationShardCount);
    assert.equal(result.currentCount, 150 + integrationShardCount);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Every derived shard must hold a file, so a fixture tree needs at least one file per shard
// beside the files a test is about.
function writeShardPadding(testRoot) {
  mkdirSync(path.join(testRoot, "padding"), { recursive: true });
  for (let index = 1; index <= integrationShardCount; index += 1)
    writeFileSync(
      path.join(testRoot, "padding", `pad-${index}.test.mjs`),
      "// harness-test-tier: integration\n",
      "utf8",
    );
}
