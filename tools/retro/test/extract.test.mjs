// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EXIT_CODES, runCli } from "../cli.mjs";
import {
  assignDeterministicSplit,
  matchNegativeControlsBySizeBucket,
  normalizeUnifiedDiff,
  runExtract,
} from "../extract.mjs";
import {
  SanitizeError,
  assertNoPrivateLeakage,
  findRetroPrivateLeakage,
  sanitizeRetroCase,
  sanitizeText,
} from "../lib/sanitize.mjs";
import {
  RETRO_CASES_SCHEMA,
  classifyDiffSizeBucket,
  collectHoldoutImmutabilityIssues,
  collectRetroCaseIssues,
  countEffectiveDiffLines,
  verifyFourStateCounts,
} from "../lib/schemas.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SEEDS_PATH = path.join(REPO_ROOT, "tools", "evals", "closeout-reviewer", "cases.json");
const TUNING_PATH = path.join(REPO_ROOT, "tools", "retro", "datasets", "tuning.json");
const HOLDOUT_PATH = path.join(REPO_ROOT, "tools", "retro", "datasets", "holdout.json");

function makeUnifiedDiff(filePath, addedLineCount) {
  const lines = Array.from({ length: addedLineCount }, (_, idx) => `+export const line_${idx + 1} = ${idx + 1};`);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${addedLineCount} @@`,
    ...lines,
    "",
  ].join("\n");
}

function makeHexSha(seedChar) {
  return seedChar.repeat(40);
}

function makeSyntheticSnapshot() {
  const rawTask1 = "task_" + "1".repeat(26);
  const rawTask2 = "task_" + "2".repeat(26);
  const rawTask3 = "task_" + "3".repeat(26);
  const rawTask4 = "task_" + "4".repeat(26);
  const rawTask5 = "task_" + "5".repeat(26);
  const rawTask6 = "task_" + "6".repeat(26);
  return {
    watermark: 42000,
    tasks: [
      {
        taskId: rawTask1,
        title: `Guard CAS write path for ${rawTask1} without silent overwrite`,
        status: "done",
        workKind: "fix",
        riskTier: "high",
        executions: [
          {
            executionId: "exe_" + "a".repeat(26),
            state: "changes_requested",
            iteration: 1,
            deliveryBaseline: { kind: "commit", commitSha: makeHexSha("1") },
            submission: { commitSha: makeHexSha("2"), completionClaim: "Updated CAS write guard" },
          },
        ],
        reviews: [
          {
            reviewId: "review-dispatch_" + "a".repeat(24),
            executionId: "exe_" + "a".repeat(26),
            verdict: "changes_requested",
            commitSha: makeHexSha("2"),
            reason: "Observer actor leaks into worker base recovery causing data loss.",
            findings: [
              {
                findingId: "F1",
                blocking: true,
                category: "data-loss",
                label: "Important",
                anchor: "src/cas-guard.ts:12",
                text: "cas-guard overwrites newer center revision when observer actor is treated as worker base provenance.",
              },
            ],
            diff: makeUnifiedDiff("src/cas-guard.ts", 10),
          },
        ],
      },
      {
        taskId: rawTask2,
        title: "Handle retry backoff ceiling on worker disconnect",
        status: "done",
        workKind: "fix",
        riskTier: "medium",
        executions: [
          {
            executionId: "exe_" + "b".repeat(26),
            state: "changes_requested",
            iteration: 1,
            deliveryBaseline: { kind: "commit", commitSha: makeHexSha("3") },
            submission: { commitSha: makeHexSha("4"), completionClaim: "Added retry backoff cap logic" },
            diff: makeUnifiedDiff("src/retry-cap.ts", 50),
          },
        ],
        reviews: [],
      },
      {
        taskId: rawTask3,
        title: "Clean xs control change",
        status: "done",
        workKind: "fix",
        riskTier: "low",
        executions: [
          {
            executionId: "exe_" + "c".repeat(26),
            state: "accepted",
            iteration: 0,
            deliveryBaseline: { kind: "commit", commitSha: makeHexSha("5") },
            submission: { commitSha: makeHexSha("6") },
            diff: makeUnifiedDiff("src/clean-xs.ts", 12),
          },
        ],
        reviews: [],
      },
      {
        taskId: rawTask4,
        title: "Clean s control change",
        status: "done",
        workKind: "feat",
        riskTier: "medium",
        executions: [
          {
            executionId: "exe_" + "d".repeat(26),
            state: "accepted",
            iteration: 0,
            deliveryBaseline: { kind: "commit", commitSha: makeHexSha("7") },
            submission: { commitSha: makeHexSha("8") },
            diff: makeUnifiedDiff("src/clean-s.ts", 55),
          },
        ],
        reviews: [],
      },
      {
        taskId: rawTask5,
        title: "Clean m control change",
        status: "done",
        workKind: "refactor",
        riskTier: "medium",
        executions: [
          {
            executionId: "exe_" + "e".repeat(26),
            state: "accepted",
            iteration: 0,
            deliveryBaseline: { kind: "commit", commitSha: makeHexSha("9") },
            submission: { commitSha: makeHexSha("a") },
            diff: makeUnifiedDiff("src/clean-m.ts", 160),
          },
        ],
        reviews: [],
      },
      {
        taskId: rawTask6,
        title: "Reverted commit must never be selected as clean control",
        status: "done",
        workKind: "fix",
        riskTier: "medium",
        executions: [
          {
            executionId: "exe_" + "f".repeat(26),
            state: "accepted",
            iteration: 0,
            deliveryBaseline: { kind: "commit", commitSha: makeHexSha("b") },
            submission: { commitSha: makeHexSha("c") },
            diff: makeUnifiedDiff("src/reverted-feature.ts", 150),
          },
        ],
        reviews: [],
      },
    ],
    reverts: [
      {
        revertCommitSha: makeHexSha("d"),
        revertedSha: makeHexSha("c"),
        baseSha: makeHexSha("b"),
        subject: 'Revert "feat: switch projection index ordering"',
        diff: makeUnifiedDiff("src/reverted-feature.ts", 150),
      },
    ],
    cleanControls: [],
  };
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

test("CLI enforces unified exit codes (0/1/2/3) and subcommand routing", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "retro-cli-"));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  const out = [];
  const err = [];
  const io = { stdout: (line) => out.push(line), stderr: (line) => err.push(line) };

  assert.equal(await runCli(["--help"], io), EXIT_CODES.OK);
  assert.equal(await runCli(["extract", "--help"], io), EXIT_CODES.OK);
  assert.equal(await runCli(["eval", "--help"], io), EXIT_CODES.OK);
  assert.equal(await runCli([], io), EXIT_CODES.INVALID_INPUT);
  assert.equal(await runCli(["unknown-cmd"], io), EXIT_CODES.INVALID_INPUT);
  assert.equal(await runCli(["eval"], io), EXIT_CODES.INVALID_INPUT);
  assert.equal(await runCli(["extract", "--holdout-ratio", "1.5"], io), EXIT_CODES.INVALID_INPUT);
  assert.equal(
    await runCli(["extract", "--snapshot-file", path.join(temp, "missing.json")], io),
    EXIT_CODES.INVALID_INPUT,
  );

  // Budget truncation exits with code 3 deterministically via injected clock on snapshot input.
  const snapPath = path.join(temp, "budget-snap.json");
  await writeFile(snapPath, JSON.stringify(makeSyntheticSnapshot(), null, 2), "utf8");
  let tick = 0;
  const budgetResult = runExtract({
    snapshotFile: snapPath,
    outDir: path.join(temp, "budget-out"),
    sourceMapPath: path.join(temp, "budget-map.json"),
    includeSeeds: true,
    dryRun: true,
    maxWallMs: 5,
    nowMs: () => {
      tick += 10;
      return tick;
    },
  });
  assert.equal(budgetResult.budgetTruncated, true);
  assert.equal(budgetResult.exitCode, EXIT_CODES.BUDGET_EXCEEDED);
});

test("sanitize gate detects .harness/ and C:\\Users\\ leaks and exits 1 (Evidence Protocol #3)", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "retro-sanitize-"));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  const dirtyHarnessPath = [".harness", "/cache/task.sqlite"].join("");
  const dirtyWinPath = ["C:", "Users", "alice", "workspace", "secret.ts"].join("\\");
  const dirtyPosixPath = ["", "Users", "alice", "workspace"].join("/");
  const dirtyTaskId = "task_" + "a".repeat(26);

  const leakScan = findRetroPrivateLeakage({
    note: `Read from ${dirtyHarnessPath} and ${dirtyWinPath} and ${dirtyPosixPath} for ${dirtyTaskId}`,
  });
  assert.equal(leakScan.ok, false);
  const rules = new Set(leakScan.hits.map((hit) => hit.rule));
  assert.ok(rules.has("ledger-private-path"), "must flag .harness/ path");
  assert.ok(rules.has("windows-abs-path"), "must flag Windows C:\\Users\\ path");
  assert.ok(rules.has("unix-user-path"), "must flag POSIX /Users/ path");
  assert.ok(rules.has("raw-internal-id"), "must flag raw task_<26> ID");

  // Regular expressions like /\s\S/ inside code diffs must NOT false-positive as UNC paths.
  const regexDiffScan = findRetroPrivateLeakage({ diff: "+const re = /\\s\\S/u;\n" });
  assert.equal(regexDiffScan.ok, true, `unexpected false positive: ${JSON.stringify(regexDiffScan.hits)}`);

  // Redaction cleans prose fields cleanly without leaving any leakage.
  const cleaned = sanitizeText(`Inspect ${dirtyHarnessPath} at ${dirtyWinPath} for ${dirtyTaskId}`);
  assert.equal(findRetroPrivateLeakage(cleaned).ok, true);
  assert.ok(!cleaned.includes(dirtyTaskId));

  // Inject dirty dataset with .harness/ and C:\Users\ and verify CLI exits 1.
  const dirtyDatasetPath = path.join(temp, "dirty-cases.json");
  const seedDoc = JSON.parse(readFileSync(SEEDS_PATH, "utf8"));
  const dirtyDoc = {
    schema: RETRO_CASES_SCHEMA,
    version: 1,
    split: "tuning",
    splitSalt: "retro-v1",
    cases: [
      {
        ...seedDoc.cases[0],
        title: `Leaked ${dirtyHarnessPath} and ${dirtyWinPath}`,
        origin: "seed",
        split: "tuning",
        diffLines: countEffectiveDiffLines(seedDoc.cases[0].diff),
        diffSizeBucket: classifyDiffSizeBucket(countEffectiveDiffLines(seedDoc.cases[0].diff)),
        replayRef: { baseSha: null, headSha: null },
      },
    ],
  };
  await writeFile(dirtyDatasetPath, JSON.stringify(dirtyDoc, null, 2), "utf8");

  const errors = [];
  const exitCode = await runCli(["extract", "--verify", dirtyDatasetPath], {
    stdout: () => {},
    stderr: (line) => errors.push(line),
  });
  assert.equal(exitCode, EXIT_CODES.GATE_FAILURE);
  assert.match(errors.join("\n"), /Private leakage detected/u);

  // Also ensure sanitizeRetroCase throws SanitizeError when diff itself embeds leakage.
  assert.throws(
    () =>
      sanitizeRetroCase({
        id: "dirty-diff",
        diff: `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = "${dirtyWinPath}";\n`,
      }),
    (err) => err instanceof SanitizeError,
  );
});

test("schemas validate retro-cases/v1, legacy closeout-reviewer cases, and four-state conservation", () => {
  const seedDoc = JSON.parse(readFileSync(SEEDS_PATH, "utf8"));
  assert.deepEqual(collectRetroCaseIssues(seedDoc), []);

  // Four-state conservation reused from closeout-reviewer/run-eval.mjs.
  assert.deepEqual(verifyFourStateCounts({ passed: 8, failed: 2, timedOut: 1, unexecuted: 4 }, 15), {
    passed: 8,
    failed: 2,
    timedOut: 1,
    unexecuted: 4,
  });
  assert.throws(
    () => verifyFourStateCounts({ passed: 8, failed: 2, timedOut: 1, unexecuted: 4 }, 10),
    /four-state accounting mismatch/u,
  );

  // Diff size stratification boundaries.
  assert.equal(classifyDiffSizeBucket(1), "xs");
  assert.equal(classifyDiffSizeBucket(30), "xs");
  assert.equal(classifyDiffSizeBucket(31), "s");
  assert.equal(classifyDiffSizeBucket(120), "s");
  assert.equal(classifyDiffSizeBucket(121), "m");
  assert.equal(classifyDiffSizeBucket(400), "m");
  assert.equal(classifyDiffSizeBucket(401), "l");

  // Unknown ReviewFindingLabel is rejected.
  const badLabel = {
    schema: RETRO_CASES_SCHEMA,
    version: 1,
    split: "tuning",
    splitSalt: "retro-v1",
    cases: [
      {
        ...seedDoc.cases[0],
        origin: "seed",
        split: "tuning",
        diffLines: countEffectiveDiffLines(seedDoc.cases[0].diff),
        diffSizeBucket: classifyDiffSizeBucket(countEffectiveDiffLines(seedDoc.cases[0].diff)),
        replayRef: { baseSha: null, headSha: null },
        metadata: { findingLabels: ["InventedLabel"] },
      },
    ],
  };
  assert.ok(collectRetroCaseIssues(badLabel).some((msg) => msg.includes("ReviewFindingLabel")));
});

test("extract builds 3 positive origins, 1:1 bucket-matched controls, and byte-identical holdout SHA-256 (Evidence Protocol #1)", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "retro-extract-det-"));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  const snapshotPath = path.join(temp, "snapshot.json");
  await writeFile(snapshotPath, JSON.stringify(makeSyntheticSnapshot(), null, 2), "utf8");

  const outDirA = path.join(temp, "out-a");
  const outDirB = path.join(temp, "out-b");
  const mapA = path.join(temp, "local-a", "source-map.json");
  const mapB = path.join(temp, "local-b", "source-map.json");

  const run1 = runExtract({
    snapshotFile: snapshotPath,
    outDir: outDirA,
    sourceMapPath: mapA,
    includeSeeds: true,
    splitSalt: "retro-v1",
  });
  const run2 = runExtract({
    snapshotFile: snapshotPath,
    outDir: outDirB,
    sourceMapPath: mapB,
    includeSeeds: true,
    splitSalt: "retro-v1",
  });

  // Evidence Protocol #1: identical inputs produce byte-identical holdout.json & tuning.json SHA-256.
  assert.equal(run1.exitCode, EXIT_CODES.OK);
  assert.equal(run2.exitCode, EXIT_CODES.OK);
  assert.equal(run1.sha256.holdout, run2.sha256.holdout);
  assert.equal(run1.sha256.tuning, run2.sha256.tuning);
  assert.equal(sha256File(path.join(outDirA, "holdout.json")), sha256File(path.join(outDirB, "holdout.json")));

  // All 3 positive origins + 1:1 clean controls + 15 seeds present.
  assert.equal(run1.summary.byOrigin["review-execution"], 1);
  assert.equal(run1.summary.byOrigin["task-rework"], 1);
  assert.equal(run1.summary.byOrigin["git-revert"], 1);
  assert.equal(run1.summary.byOrigin["clean-control"], 3);
  assert.equal(run1.summary.byOrigin.seed, 15);
  assert.equal(run1.totalCases, 21);
  assert.equal(run1.privateLeakHits, 0);

  // Verify 1:1 bucket matching paired xs->xs, s->s, m->m and excluded reverted commit from controls.
  const allCases = [
    ...JSON.parse(readFileSync(path.join(outDirA, "tuning.json"), "utf8")).cases,
    ...JSON.parse(readFileSync(path.join(outDirA, "holdout.json"), "utf8")).cases,
  ];
  const byId = new Map(allCases.map((c) => [c.id, c]));
  const controls = allCases.filter((c) => c.origin === "clean-control");
  assert.equal(controls.length, 3);
  for (const ctrl of controls) {
    assert.notEqual(ctrl.replayRef.headSha, makeHexSha("c"), "reverted commit must not become a clean control");
    const matchedPos = byId.get(ctrl.metadata.matchedPositiveId);
    assert.ok(matchedPos, "control must reference its matched positive case");
    assert.equal(ctrl.diffSizeBucket, matchedPos.diffSizeBucket, "control must match positive diff size bucket");
  }

  // Public datasets contain zero raw task_<26> IDs; private source map holds full traceability.
  const publicText =
    readFileSync(path.join(outDirA, "tuning.json"), "utf8") + readFileSync(path.join(outDirA, "holdout.json"), "utf8");
  assert.equal(findRetroPrivateLeakage(publicText).ok, true);
  assert.equal(existsSync(mapA), true);
  const sourceMap = JSON.parse(readFileSync(mapA, "utf8"));
  assert.equal(sourceMap.schema, "retro-source-map/v1");
  assert.ok(Object.values(sourceMap.entries).some((entry) => entry.taskId === "task_" + "1".repeat(26)));

  // Deterministic split distribution sanity over 200 IDs.
  let holdoutCount = 0;
  for (let i = 0; i < 200; i += 1) {
    const split = assignDeterministicSplit(`retro-sample-${i}`, "retro-v1", 0.4);
    assert.equal(split, assignDeterministicSplit(`retro-sample-${i}`, "retro-v1", 0.4));
    if (split === "holdout") holdoutCount += 1;
  }
  assert.ok(holdoutCount >= 60 && holdoutCount <= 100, `expected ~40% holdout of 200, got ${holdoutCount}`);
});

test("holdout append-only lock rejects modifying or deleting existing holdout caseIds (Evidence Protocol #2)", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "retro-holdout-lock-"));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  const outDir = path.join(temp, "datasets");
  const sourceMapPath = path.join(temp, "source-map.json");
  const snapshotPath = path.join(temp, "snapshot.json");
  const snapshot = makeSyntheticSnapshot();
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

  const initial = runExtract({ snapshotFile: snapshotPath, outDir, sourceMapPath, includeSeeds: true });
  assert.ok(initial.counts.holdout >= 4, "expected multiple frozen holdout cases");
  const holdoutPath = path.join(outDir, "holdout.json");
  const initialHoldoutSha = sha256File(holdoutPath);
  const initialHoldoutDoc = JSON.parse(readFileSync(holdoutPath, "utf8"));

  // Pick a frozen holdout seed case and attempt to mutate its title via a tampered seeds file -> must exit 1.
  const frozenSeed = initialHoldoutDoc.cases.find((c) => c.origin === "seed");
  assert.ok(frozenSeed, "expected at least one seed case in holdout");
  const tamperedSeedsDoc = JSON.parse(readFileSync(SEEDS_PATH, "utf8"));
  const targetSeed = tamperedSeedsDoc.cases.find((c) => c.id === frozenSeed.id);
  targetSeed.title = `${targetSeed.title} [TAMPERED]`;
  const tamperedSeedsPath = path.join(temp, "tampered-seeds.json");
  await writeFile(tamperedSeedsPath, JSON.stringify(tamperedSeedsDoc, null, 2), "utf8");

  const modifyStderr = [];
  const modifyExit = await runCli(
    [
      "extract",
      "--snapshot-file",
      snapshotPath,
      "--out-dir",
      outDir,
      "--source-map",
      sourceMapPath,
      "--include-seeds",
      "--seeds-path",
      tamperedSeedsPath,
    ],
    { stdout: () => {}, stderr: (line) => modifyStderr.push(line) },
  );
  assert.equal(modifyExit, EXIT_CODES.GATE_FAILURE);
  assert.match(modifyStderr.join("\n"), /Holdout immutability violation: attempted to modify frozen holdout case/u);
  assert.equal(sha256File(holdoutPath), initialHoldoutSha, "holdout.json must remain untouched after rejected tamper");

  // Attempt to delete a frozen holdout caseId under --strict-holdout -> must exit 1.
  const deletedSeedsDoc = JSON.parse(readFileSync(SEEDS_PATH, "utf8"));
  deletedSeedsDoc.cases = deletedSeedsDoc.cases.filter((c) => c.id !== frozenSeed.id);
  const deletedSeedsPath = path.join(temp, "deleted-seeds.json");
  await writeFile(deletedSeedsPath, JSON.stringify(deletedSeedsDoc, null, 2), "utf8");

  const deleteStderr = [];
  const deleteExit = await runCli(
    [
      "extract",
      "--snapshot-file",
      snapshotPath,
      "--out-dir",
      outDir,
      "--source-map",
      sourceMapPath,
      "--include-seeds",
      "--seeds-path",
      deletedSeedsPath,
      "--strict-holdout",
    ],
    { stdout: () => {}, stderr: (line) => deleteStderr.push(line) },
  );
  assert.equal(deleteExit, EXIT_CODES.GATE_FAILURE);
  assert.match(deleteStderr.join("\n"), /holdout case deleted/u);
  assert.equal(sha256File(holdoutPath), initialHoldoutSha, "holdout.json must remain untouched after rejected delete");

  // Direct schema immutability helper check for both deletion and modification.
  assert.ok(
    collectHoldoutImmutabilityIssues(initialHoldoutDoc, {
      ...initialHoldoutDoc,
      cases: initialHoldoutDoc.cases.slice(1),
    }).some((msg) => msg.includes("holdout case deleted")),
  );
});

test("diff normalizer strips private paths, binaries, and lockfiles while keeping valid hunks", () => {
  const dirtyPath = [".harness", "/cache/x.ts"].join("");
  const mixedDiff = [
    `diff --git a/${dirtyPath} b/${dirtyPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${dirtyPath}`,
    "@@ -0,0 +1 @@",
    "+secret",
    "diff --git a/package-lock.json b/package-lock.json",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1 +1 @@",
    "-{}",
    '+{"a":1}',
    makeUnifiedDiff("src/valid-file.ts", 3).trimEnd(),
    "",
  ].join("\n");

  const normalized = normalizeUnifiedDiff(mixedDiff);
  assert.ok(normalized);
  assert.deepEqual(normalized.files, ["src/valid-file.ts"]);
  assert.equal(normalized.diffLines, 3);
  assert.equal(findRetroPrivateLeakage(normalized.diff).ok, true);

  // Bucket matcher falls back gracefully when exact bucket is empty.
  const pairs = matchNegativeControlsBySizeBucket(
    [{ caseObj: { id: "p1", diffLines: 50, diffSizeBucket: "s" } }],
    [{ sortKey: "c1", diffLines: 10, diffSizeBucket: "xs" }],
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].negative.sortKey, "c1");
});

test("committed tools/retro/datasets/{tuning,holdout}.json are valid, leak-free, disjoint, and git-apply parseable", () => {
  assert.equal(existsSync(TUNING_PATH), true, "tuning.json must exist");
  assert.equal(existsSync(HOLDOUT_PATH), true, "holdout.json must exist");

  const tuningDoc = JSON.parse(readFileSync(TUNING_PATH, "utf8"));
  const holdoutDoc = JSON.parse(readFileSync(HOLDOUT_PATH, "utf8"));

  assert.deepEqual(collectRetroCaseIssues(tuningDoc), []);
  assert.deepEqual(collectRetroCaseIssues(holdoutDoc), []);
  assert.doesNotThrow(() => assertNoPrivateLeakage(tuningDoc, "tuning.json"));
  assert.doesNotThrow(() => assertNoPrivateLeakage(holdoutDoc, "holdout.json"));

  const tuningIds = new Set(tuningDoc.cases.map((c) => c.id));
  const holdoutIds = new Set(holdoutDoc.cases.map((c) => c.id));
  for (const id of holdoutIds) {
    assert.equal(tuningIds.has(id), false, `holdout case ${id} leaked into tuning.json`);
  }

  const allCases = [...tuningDoc.cases, ...holdoutDoc.cases];
  assert.ok(allCases.length >= 10, `expected >= 10 committed cases, got ${allCases.length}`);

  const parsed = spawnSync("git", ["apply", "--numstat", "-"], {
    input: allCases.map((c) => c.diff).join(""),
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.ok(parsed.stdout.trim().split("\n").length >= allCases.length);
});
