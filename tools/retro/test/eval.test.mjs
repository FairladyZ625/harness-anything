// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { EXIT_CODES, runCli } from "../cli.mjs";
import { clampConcurrency, evaluateBaselineGate, runEval, sweepOrphanRetroTempDirs } from "../eval.mjs";
import { ProvenanceError, sha256Hex, verifyJudgeProvenance } from "../lib/judge-provenance.mjs";
import { execIsolatedCommand, killProcessTree, probeProcessAlive } from "../lib/process-runner.mjs";
import { findRetroPrivateLeakage } from "../lib/sanitize.mjs";
import { RETRO_EVAL_REPORT_SCHEMA, collectRetroEvalReportIssues, verifyFourStateCounts } from "../lib/schemas.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const HOLDOUT_PATH = path.join(REPO_ROOT, "tools", "retro", "datasets", "holdout.json");
const MOCK_NODE = JSON.stringify(process.execPath);

function loadHoldoutDoc() {
  return JSON.parse(readFileSync(HOLDOUT_PATH, "utf8"));
}

function makeMiniCasesDoc(cases) {
  return {
    schema: "retro-cases/v1",
    version: 1,
    split: "holdout",
    splitSalt: "retro-v1",
    cases,
  };
}

function perfectResponseFor(evalCase, extra = {}) {
  if (evalCase.bucket === "positive") {
    const finding = {
      findingId: `f-${evalCase.id}`,
      blocking: true,
      category: evalCase.expectedCategories[0],
      text: evalCase.expectedEvidence.map(([phrase]) => phrase).join(". "),
    };
    return {
      caseId: evalCase.id,
      verdict: "changes_requested",
      findings: [finding],
      rawFindings: [finding],
      postVerificationFindings: [finding],
      latencyMs: 50,
      ...extra,
    };
  }
  return {
    caseId: evalCase.id,
    verdict: "approved",
    findings: [],
    rawFindings: [],
    postVerificationFindings: [],
    latencyMs: 40,
    ...extra,
  };
}

function listGitWorktrees(cwd) {
  const res = spawnSync("git", ["-C", cwd, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.split(/\r?\n/u).filter((line) => line.startsWith("worktree "));
}

function quoteCmd(scriptPath, extraArgs = []) {
  return [MOCK_NODE, JSON.stringify(scriptPath), ...extraArgs.map((arg) => JSON.stringify(arg))].join(" ");
}

test("clampConcurrency enforces min(cli, max(1, floor((freeMemMB - 2048) / 1024)))", () => {
  const mib = 1024 * 1024;
  assert.equal(clampConcurrency(4, 1024 * mib), 1);
  assert.equal(clampConcurrency(4, 2048 * mib), 1);
  assert.equal(clampConcurrency(4, 3071 * mib), 1);
  assert.equal(clampConcurrency(4, 4096 * mib), 2);
  assert.equal(clampConcurrency(8, 6144 * mib), 4);
  assert.equal(clampConcurrency(3, 16384 * mib), 3);
  assert.throws(() => clampConcurrency(0, 8192 * mib), /--concurrency/u);
});

test(
  "process-runner kills full child+grandchild process tree on timeout and records timedOut (Evidence Protocol #1)",
  { timeout: 20_000 },
  async (t) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "retro-proc-test-"));
    t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));

    const pidFile = path.join(temp, "grandchild.pid");
    const mockScript = path.join(temp, "hang-tree.mjs");
    await writeFile(
      mockScript,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'import process from "node:process";',
        'process.on("SIGTERM", () => {});',
        "const pidFile = process.argv[2];",
        'const grand = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });',
        'writeFileSync(pidFile, String(grand.pid), "utf8");',
        'process.stdout.write(JSON.stringify({ verdict: "approved", findings: [] }));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );

    // 1) Direct execIsolatedCommand negative control: must kill child + grandchild
    const direct = await execIsolatedCommand({
      command: quoteCmd(mockScript, [pidFile]),
      stdinText: "{}",
      waitMs: 800,
      settleMs: 120,
    });
    assert.equal(direct.status, "timedOut");
    assert.equal(direct.stdout, "");
    assert.ok(direct.killMethod === "taskkill" || direct.killMethod === "posix-group");
    assert.ok(existsSync(pidFile), "grandchild PID file must have been written before timeout");
    const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
    // Wait briefly for OS process table teardown, then verify zero residual processes.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(probeProcessAlive(grandchildPid), false, `grandchild PID ${grandchildPid} must not survive tree kill`);
    if (direct.pid) {
      assert.equal(probeProcessAlive(direct.pid), false, `child PID ${direct.pid} must not survive tree kill`);
    }

    // 2) Full live eval integration: timed-out case counted in timedOut with four-state conservation
    const holdout = loadHoldoutDoc();
    const oneCase = holdout.cases.find((c) => c.bucket === "negative");
    const casesFile = path.join(temp, "cases.json");
    await writeFile(casesFile, JSON.stringify(makeMiniCasesDoc([oneCase]), null, 2), "utf8");

    const pidFile2 = path.join(temp, "grandchild-2.pid");
    const { exitCode, report } = await runEval({
      mode: "live",
      replayMode: "diff-only",
      casesPath: casesFile,
      reviewerCmd: quoteCmd(mockScript, [pidFile2]),
      caseWaitMs: 800,
      concurrency: 1,
      persistCheckpoint: false,
      repoRoot: REPO_ROOT,
    });
    assert.equal(exitCode, EXIT_CODES.OK);
    assert.deepEqual(report.counts, { passed: 0, failed: 0, timedOut: 1, unexecuted: 0 });
    assert.equal(report.validResponses, 0);
    assert.equal(report.outcomes[0].verdict, null);
    verifyFourStateCounts(report.counts, 1, "timeout-eval");
    if (existsSync(pidFile2)) {
      const gpid2 = Number(readFileSync(pidFile2, "utf8").trim());
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(probeProcessAlive(gpid2), false, `grandchild PID ${gpid2} must be killed`);
    }

    // 3) Unit-verify both platform dispatch paths (Windows taskkill + POSIX -pid SIGTERM->SIGKILL)
    const winCalls = [];
    const winOutcome = await killProcessTree(42424, {
      platform: "win32",
      execFileFn: (file, args, _opts, cb) => {
        winCalls.push({ file, args });
        cb(null, "SUCCESS", "");
      },
    });
    assert.equal(winOutcome.ok, true);
    assert.equal(winOutcome.method, "taskkill");
    assert.deepEqual(winCalls, [{ file: "taskkill", args: ["/PID", "42424", "/T", "/F"] }]);

    const posixSignals = [];
    const posixOutcome = await killProcessTree(51515, {
      platform: "linux",
      settleMs: 10,
      killFn: (pid, sig) => {
        posixSignals.push({ pid, sig });
        return true;
      },
    });
    assert.equal(posixOutcome.ok, true);
    assert.equal(posixOutcome.method, "posix-group");
    assert.deepEqual(posixSignals, [
      { pid: -51515, sig: "SIGTERM" },
      { pid: -51515, sig: "SIGKILL" },
    ]);

    // 4) Output byte ceiling protection
    const spamScript = path.join(temp, "spam.mjs");
    await writeFile(spamScript, 'process.stdout.write("x".repeat(4096));', "utf8");
    const overflow = await execIsolatedCommand({
      command: quoteCmd(spamScript),
      waitMs: 5000,
      maxOutputBytes: 128,
    });
    assert.equal(overflow.status, "errored");
    assert.match(overflow.error, /exceeded 128 bytes/u);
  },
);

test("three-stage funnel attributes raw-miss, verification-over-pruned, verdict-downgraded, and noise suppression + Tier 2 dual judge", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "retro-funnel-test-"));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));

  const holdout = loadHoldoutDoc();
  const positives = holdout.cases.filter((c) => c.bucket === "positive").slice(0, 3);
  const negative = holdout.cases.find((c) => c.bucket === "negative");
  assert.equal(positives.length, 3);
  assert.ok(negative);

  const cases = [...positives, negative];
  const casesFile = path.join(temp, "cases.json");
  await writeFile(casesFile, JSON.stringify(makeMiniCasesDoc(cases), null, 2), "utf8");

  const pos0Finding = perfectResponseFor(positives[0]).findings[0];
  const pos1Finding = perfectResponseFor(positives[1]).findings[0];
  const pos2Finding = perfectResponseFor(positives[2]).findings[0];

  const responses = [
    // Pos 0: missed already at raw stage -> raw-miss
    {
      caseId: positives[0].id,
      verdict: "approved",
      findings: [],
      rawFindings: [],
      postVerificationFindings: [],
      latencyMs: 30,
    },
    // Pos 1: caught at raw, dropped at postVerification -> verification-over-pruned
    {
      caseId: positives[1].id,
      verdict: "approved",
      findings: [],
      rawFindings: [pos1Finding],
      postVerificationFindings: [],
      latencyMs: 35,
    },
    // Pos 2: caught at raw & postVerification, downgraded to approved at finalVerdict -> verdict-downgraded
    {
      caseId: positives[2].id,
      verdict: "approved",
      findings: [{ ...pos2Finding, blocking: false }],
      rawFindings: [pos2Finding],
      postVerificationFindings: [pos2Finding],
      latencyMs: 40,
    },
    // Negative: false-flagged blocking at raw, suppressed at postVerification, approved at finalVerdict
    {
      caseId: negative.id,
      verdict: "approved",
      findings: [],
      rawFindings: [{ findingId: "fp-raw", blocking: true, category: "correctness", text: "Spurious initial alarm" }],
      postVerificationFindings: [],
      latencyMs: 25,
    },
  ];
  assert.ok(pos0Finding);

  const { exitCode, report } = await runEval({
    mode: "input",
    replayMode: "diff-only",
    casesPath: casesFile,
    responses,
    repoRoot: REPO_ROOT,
  });

  assert.equal(exitCode, EXIT_CODES.OK);
  assert.equal(report.schema, RETRO_EVAL_REPORT_SCHEMA);
  assert.deepEqual(collectRetroEvalReportIssues(report), []);
  assert.deepEqual(report.counts, { passed: 1, failed: 3, timedOut: 0, unexecuted: 0 });
  assert.equal(report.funnel.raw.recall, 2 / 3);
  assert.equal(report.funnel.raw.falsePositiveRate, 1);
  assert.equal(report.funnel.postVerification.recall, 1 / 3);
  assert.equal(report.funnel.postVerification.falsePositiveRate, 0);
  assert.equal(report.funnel.finalVerdict.recall, 0);
  assert.equal(report.funnel.finalVerdict.falsePositiveRate, 0);
  assert.deepEqual(report.funnel.dropoff, {
    rawMissedPositives: 1,
    prunedAtVerificationPositives: 1,
    downgradedAtFinalVerdictPositives: 1,
    noiseSuppressedAtVerification: 1,
    noiseSuppressedAtFinalVerdict: 0,
  });

  // Tier 2 dual low-temperature judge: unanimous true promotes paraphrased finding; disagreement fails closed
  const judgeAgreeScript = path.join(temp, "judge-agree.mjs");
  const judgeSplitScript = path.join(temp, "judge-split.mjs");
  await writeFile(
    judgeAgreeScript,
    'let buf=""; process.stdin.on("data", c => buf += c); process.stdin.on("end", () => { const p = JSON.parse(buf); process.stdout.write(JSON.stringify({ match: p.temperature === 0, reason: "semantic match run " + p.runIndex })); });',
    "utf8",
  );
  await writeFile(
    judgeSplitScript,
    'let buf=""; process.stdin.on("data", c => buf += c); process.stdin.on("end", () => { const p = JSON.parse(buf); process.stdout.write(JSON.stringify({ match: p.runIndex === 1, reason: "split vote" })); });',
    "utf8",
  );

  const paraphraseResponses = [
    {
      caseId: positives[0].id,
      verdict: "changes_requested",
      findings: [
        {
          findingId: "para-1",
          blocking: true,
          category: positives[0].expectedCategories[0],
          text: "Semantically describes the defect using completely paraphrased wording.",
        },
      ],
      latencyMs: 55,
    },
  ];
  const onePosFile = path.join(temp, "one-pos.json");
  await writeFile(onePosFile, JSON.stringify(makeMiniCasesDoc([positives[0]]), null, 2), "utf8");

  const agreeRun = await runEval({
    mode: "input",
    casesPath: onePosFile,
    responses: paraphraseResponses,
    secondaryJudgeCmd: quoteCmd(judgeAgreeScript),
    repoRoot: REPO_ROOT,
  });
  assert.equal(agreeRun.report.counts.passed, 1);
  assert.equal(agreeRun.report.outcomes[0].secondaryJudge.unanimousMatch, true);
  assert.equal(agreeRun.report.outcomes[0].secondaryJudge.votes.length, 2);

  const splitRun = await runEval({
    mode: "input",
    casesPath: onePosFile,
    responses: paraphraseResponses,
    secondaryJudgeCmd: quoteCmd(judgeSplitScript),
    repoRoot: REPO_ROOT,
  });
  assert.equal(splitRun.report.counts.failed, 1);
  assert.equal(splitRun.report.outcomes[0].secondaryJudge.unanimousMatch, false);
  assert.equal(splitRun.report.outcomes[0].secondaryJudge.agreed, false);
});

test("baseline regression veto blocks any single-case regression with exit 1 and accepts clean improvement with exit 0 (Evidence Protocol #2)", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "retro-baseline-test-"));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));

  const holdout = loadHoldoutDoc();
  const positives = holdout.cases.filter((c) => c.bucket === "positive").slice(0, 3);
  const negatives = holdout.cases.filter((c) => c.bucket === "negative").slice(0, 2);
  const cases = [...positives, ...negatives];
  const casesFile = path.join(temp, "cases.json");
  await writeFile(casesFile, JSON.stringify(makeMiniCasesDoc(cases), null, 2), "utf8");

  // Baseline: pos[0] passed, pos[1] failed, pos[2] failed, neg[0..1] passed -> recall = 1/3, FPR = 0
  const baselineResponses = [
    perfectResponseFor(positives[0]),
    { caseId: positives[1].id, verdict: "approved", findings: [], latencyMs: 20 },
    { caseId: positives[2].id, verdict: "approved", findings: [], latencyMs: 20 },
    perfectResponseFor(negatives[0]),
    perfectResponseFor(negatives[1]),
  ];
  const baselinePath = path.join(temp, "baseline.json");
  const baseRun = await runEval({
    mode: "input",
    casesPath: casesFile,
    responses: baselineResponses,
    outPath: baselinePath,
    repoRoot: REPO_ROOT,
  });
  assert.equal(baseRun.exitCode, EXIT_CODES.OK);
  assert.equal(baseRun.report.metrics.recall, 1 / 3);

  // Negative control: candidate improves pos[1] & pos[2] (recall 2/3 > 1/3) BUT regresses pos[0]!
  // Single-case regression MUST veto with exit 1.
  const regressedResponses = [
    { caseId: positives[0].id, verdict: "approved", findings: [], latencyMs: 20 },
    perfectResponseFor(positives[1]),
    perfectResponseFor(positives[2]),
    perfectResponseFor(negatives[0]),
    perfectResponseFor(negatives[1]),
  ];
  const regressedRun = await runEval({
    mode: "input",
    casesPath: casesFile,
    responses: regressedResponses,
    baselinePath,
    repoRoot: REPO_ROOT,
  });
  assert.equal(regressedRun.exitCode, EXIT_CODES.GATE_FAILURE);
  assert.equal(regressedRun.report.gate.passed, false);
  assert.equal(regressedRun.report.gate.regressions, 1);
  assert.deepEqual(regressedRun.report.gate.regressedCaseIds, [positives[0].id]);

  // Positive control: candidate keeps pos[0], improves pos[1], keeps neg[0..1] -> exit 0
  const improvedResponses = [
    perfectResponseFor(positives[0]),
    perfectResponseFor(positives[1]),
    { caseId: positives[2].id, verdict: "approved", findings: [], latencyMs: 20 },
    perfectResponseFor(negatives[0]),
    perfectResponseFor(negatives[1]),
  ];
  const improvedRun = await runEval({
    mode: "input",
    casesPath: casesFile,
    responses: improvedResponses,
    baselinePath,
    repoRoot: REPO_ROOT,
  });
  assert.equal(improvedRun.exitCode, EXIT_CODES.OK);
  assert.equal(improvedRun.report.gate.passed, true);
  assert.equal(improvedRun.report.gate.regressions, 0);
  assert.ok(improvedRun.report.gate.deltaRecall > 0);
  assert.equal(improvedRun.report.gate.deltaFPR, 0);
  assert.equal(improvedRun.report.gate.executedRate, 1);

  // Direct gate check: low executedRate (< 0.95) must fail even with zero regressions
  const partialReport = structuredClone(improvedRun.report);
  partialReport.counts = { passed: 4, failed: 0, timedOut: 0, unexecuted: 1 };
  const lowExecGate = evaluateBaselineGate(partialReport, baseRun.report);
  assert.equal(lowExecGate.passed, false);
  assert.ok(lowExecGate.reasons.some((r) => r.includes("executedRate")));
});

test("budget circuit breaker exits 3 with four-state conservation and --resume-run only runs unfinished cases (Evidence Protocol #3)", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "retro-resume-test-"));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));

  const holdout = loadHoldoutDoc();
  const cases = holdout.cases.filter((c) => c.bucket === "negative").slice(0, 4);
  assert.equal(cases.length, 4);
  const casesFile = path.join(temp, "cases.json");
  await writeFile(casesFile, JSON.stringify(makeMiniCasesDoc(cases), null, 2), "utf8");

  const callLogPath = path.join(temp, "invocations.log");
  const mockReviewer = path.join(temp, "cost-reviewer.mjs");
  await writeFile(
    mockReviewer,
    [
      'import { appendFileSync } from "node:fs";',
      'let buf = "";',
      'process.stdin.on("data", (c) => { buf += c; });',
      'process.stdin.on("end", () => {',
      "  const payload = JSON.parse(buf);",
      '  appendFileSync(process.argv[2], payload.caseId + "\\n", "utf8");',
      '  process.stdout.write(JSON.stringify({ verdict: "approved", findings: [], costUsd: 0.5 }));',
      "});",
    ].join("\n"),
    "utf8",
  );

  const runDir = path.join(temp, "run-checkpoint");

  // Run 1: maxCostUsd = 1.0 with concurrency = 1 -> executes 2 cases ($1.0), truncates remaining 2 as unexecuted -> exit 3
  const first = await runEval({
    mode: "live",
    replayMode: "diff-only",
    casesPath: casesFile,
    reviewerCmd: quoteCmd(mockReviewer, [callLogPath]),
    concurrency: 1,
    maxCostUsd: 1.0,
    runDir,
    repoRoot: REPO_ROOT,
  });
  assert.equal(first.exitCode, EXIT_CODES.BUDGET_EXCEEDED);
  assert.equal(first.report.budget.truncated, true);
  assert.deepEqual(first.report.counts, { passed: 2, failed: 0, timedOut: 0, unexecuted: 2 });
  verifyFourStateCounts(first.report.counts, 4, "budget-truncated");

  const callsAfterRun1 = readFileSync(callLogPath, "utf8").trim().split(/\r?\n/u);
  assert.equal(callsAfterRun1.length, 2);

  // Run 2: --resume-run reuses the 2 completed cases and ONLY executes the 2 unfinished cases -> exit 0
  const resumed = await runEval({
    mode: "live",
    replayMode: "diff-only",
    casesPath: casesFile,
    reviewerCmd: quoteCmd(mockReviewer, [callLogPath]),
    concurrency: 1,
    resumeRun: runDir,
    repoRoot: REPO_ROOT,
  });
  assert.equal(resumed.exitCode, EXIT_CODES.OK);
  assert.equal(resumed.report.budget.truncated, false);
  assert.equal(resumed.report.reusedCaseCount, 2);
  assert.equal(resumed.report.newlyExecutedCaseCount, 2);
  assert.deepEqual(resumed.report.counts, { passed: 4, failed: 0, timedOut: 0, unexecuted: 0 });
  verifyFourStateCounts(resumed.report.counts, 4, "resumed-complete");

  const callsAfterRun2 = readFileSync(callLogPath, "utf8").trim().split(/\r?\n/u);
  assert.equal(callsAfterRun2.length, 4, "each case must be executed exactly once across truncated + resumed runs");
  assert.equal(new Set(callsAfterRun2).size, 4);

  // Also test deterministic --max-wall-ms truncation via injected clock
  let fakeClock = 1000;
  const wallRun = await runEval({
    mode: "input",
    casesPath: casesFile,
    responses: cases.map((c) => perfectResponseFor(c)),
    concurrency: 1,
    maxWallMs: 100,
    nowMs: () => {
      const current = fakeClock;
      fakeClock += 60;
      return current;
    },
    repoRoot: REPO_ROOT,
  });
  assert.equal(wallRun.exitCode, EXIT_CODES.BUDGET_EXCEEDED);
  assert.equal(wallRun.report.budget.truncated, true);
  assert.ok(wallRun.report.counts.unexecuted >= 1);
  verifyFourStateCounts(wallRun.report.counts, 4, "wall-budget-truncated");
});

test("tree-snapshot uses readonly-checkout with zero git worktree registration, zero temp residue, and sweeps >24h orphans (Evidence Protocol #4)", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "retro-snapshot-test-"));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));

  const fakeTmpRoot = path.join(temp, "tmp-sandbox");
  mkdirSync(fakeTmpRoot, { recursive: true });

  // Plant a 25h-old orphan dir and a 1h-old active dir
  const staleOrphan = path.join(fakeTmpRoot, "ha-retro-stale-orphan");
  const freshSibling = path.join(fakeTmpRoot, "ha-retro-fresh-sibling");
  mkdirSync(staleOrphan, { recursive: true });
  mkdirSync(freshSibling, { recursive: true });
  writeFileSync(path.join(staleOrphan, "marker.txt"), "stale", "utf8");
  const now = Date.now();
  const staleDate = new Date(now - 25 * 60 * 60 * 1000);
  const freshDate = new Date(now - 1 * 60 * 60 * 1000);
  utimesSync(staleOrphan, staleDate, staleDate);
  utimesSync(freshSibling, freshDate, freshDate);

  const holdout = loadHoldoutDoc();
  const realCommitCases = holdout.cases
    .filter((c) => c.replayRef && c.replayRef.headSha && c.bucket === "negative")
    .slice(0, 2);
  assert.equal(realCommitCases.length, 2, "holdout must have at least 2 real-commit negative cases");
  const casesFile = path.join(temp, "real-cases.json");
  await writeFile(casesFile, JSON.stringify(makeMiniCasesDoc(realCommitCases), null, 2), "utf8");

  const observerLog = path.join(temp, "snapshot-observations.ndjson");
  const snapshotReviewer = path.join(temp, "snapshot-reviewer.mjs");
  await writeFile(
    snapshotReviewer,
    [
      'import { appendFileSync, existsSync } from "node:fs";',
      'import path from "node:path";',
      'let buf = "";',
      'process.stdin.on("data", (c) => { buf += c; });',
      'process.stdin.on("end", () => {',
      "  const payload = JSON.parse(buf);",
      "  const cwd = process.cwd();",
      "  appendFileSync(process.argv[2], JSON.stringify({",
      "    caseId: payload.caseId,",
      "    cwd,",
      '    hasPackageJson: existsSync(path.join(cwd, "package.json")),',
      '    hasGitDir: existsSync(path.join(cwd, ".git")),',
      "    envDir: process.env.RETRO_SNAPSHOT_DIR ?? null,",
      '  }) + "\\n", "utf8");',
      '  process.stdout.write(JSON.stringify({ verdict: "approved", findings: [] }));',
      "});",
    ].join("\n"),
    "utf8",
  );

  const worktreesBefore = listGitWorktrees(REPO_ROOT);

  const { exitCode, report } = await runEval({
    mode: "live",
    replayMode: "tree-snapshot",
    casesPath: casesFile,
    reviewerCmd: quoteCmd(snapshotReviewer, [observerLog]),
    concurrency: 1,
    tmpDir: fakeTmpRoot,
    persistCheckpoint: false,
    repoRoot: REPO_ROOT,
  });

  const worktreesAfter = listGitWorktrees(REPO_ROOT);
  assert.equal(exitCode, EXIT_CODES.OK);
  assert.deepEqual(worktreesAfter, worktreesBefore, "tree-snapshot must never register git worktrees");
  assert.deepEqual(report.counts, { passed: 2, failed: 0, timedOut: 0, unexecuted: 0 });
  assert.ok(report.sweptOrphanTempDirs.includes(staleOrphan), "must sweep >24h orphan ha-retro-* dir");
  assert.equal(existsSync(staleOrphan), false);
  assert.equal(existsSync(freshSibling), true, "must preserve <24h sibling dir");

  const remainingEntries = (await readdir(fakeTmpRoot)).filter((name) => name.startsWith("ha-retro-"));
  assert.deepEqual(remainingEntries, ["ha-retro-fresh-sibling"], "zero temp residue from current run");

  const observations = readFileSync(observerLog, "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  assert.equal(observations.length, 2);
  for (const obs of observations) {
    assert.equal(obs.hasPackageJson, true, `materialized snapshot for ${obs.caseId} must contain package.json`);
    assert.equal(obs.hasGitDir, false, `materialized snapshot for ${obs.caseId} must not be a git worktree`);
    assert.ok(obs.envDir && obs.envDir.includes("ha-retro-"));
  }

  // Also test sweepOrphanRetroTempDirs directly on empty/missing dir
  assert.deepEqual(sweepOrphanRetroTempDirs({ tmpDir: path.join(temp, "no-such-dir") }), []);
});

test("judge-provenance fails closed (exit 2) on unreachable origin/main and reads tamper-proof holdout/closure from origin/main", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "retro-prov-test-"));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));

  const runGit = (args) => {
    const res = spawnSync("git", ["-C", temp, ...args], { encoding: "utf8" });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
    return res.stdout.trim();
  };

  runGit(["init", "-b", "main"]);
  runGit(["config", "user.name", "Retro Test"]);
  runGit(["config", "user.email", "retro-test@example.com"]);

  const evalRel = "tools/evals/closeout-reviewer/run-eval.mjs";
  const retroEvalRel = "tools/retro/eval.mjs";
  const holdoutRel = "tools/retro/datasets/holdout.json";
  for (const rel of [evalRel, retroEvalRel, holdoutRel]) {
    mkdirSync(path.dirname(path.join(temp, rel)), { recursive: true });
  }

  const originHoldoutBody = JSON.stringify(
    { schema: "retro-cases/v1", version: 1, split: "holdout", cases: [] },
    null,
    2,
  );
  writeFileSync(path.join(temp, evalRel), "export const JUDGE_V = 1;\n", "utf8");
  writeFileSync(path.join(temp, retroEvalRel), "export const RETRO_V = 1;\n", "utf8");
  writeFileSync(path.join(temp, holdoutRel), originHoldoutBody, "utf8");

  runGit(["add", "."]);
  runGit(["commit", "-m", "init origin main"]);
  const mainSha = runGit(["rev-parse", "HEAD"]);
  runGit(["update-ref", "refs/remotes/origin/main", mainSha]);

  // 1) Unreachable origin ref -> fail-closed exit 2
  assert.throws(
    () => verifyJudgeProvenance({ rootDir: temp, originRef: "refs/remotes/origin/missing" }),
    (err) =>
      err instanceof ProvenanceError &&
      err.exitCode === EXIT_CODES.INVALID_INPUT &&
      err.code === "origin_main_unreachable",
  );

  // 2) Tamper with local working tree holdout.json & retro/eval.mjs on a feature branch
  runGit(["checkout", "-b", "candidate-branch"]);
  writeFileSync(path.join(temp, holdoutRel), '{"tampered": true}', "utf8");
  writeFileSync(path.join(temp, retroEvalRel), "export const RETRO_V = 999;\n", "utf8");

  const verified = verifyJudgeProvenance({
    rootDir: temp,
    originRef: "origin/main",
    casesPath: path.join(temp, holdoutRel),
  });
  assert.equal(verified.provenance.originMainSha, mainSha);
  assert.equal(verified.provenance.casesSource, "origin/main");
  assert.equal(
    verified.provenance.casesSha256,
    sha256Hex(originHoldoutBody),
    "must read holdout from origin/main, ignoring local tamper",
  );
  assert.equal(verified.casesRawText, originHoldoutBody);
  assert.equal(verified.provenance.holdoutDivergedFromOrigin, true);
  assert.deepEqual(verified.provenance.divergedJudgeFiles, [retroEvalRel]);

  // 3) Strict judge closure rejects locally tampered judge files with exit 2
  assert.throws(
    () =>
      verifyJudgeProvenance({
        rootDir: temp,
        originRef: "origin/main",
        casesPath: path.join(temp, holdoutRel),
        strictJudgeClosure: true,
      }),
    (err) =>
      err instanceof ProvenanceError &&
      err.exitCode === EXIT_CODES.INVALID_INPUT &&
      err.code === "judge_closure_tampered",
  );
});

test("CLI retro eval --mode dry-run on committed holdout.json exits 0 with four-state conservation and zero private leaks", async () => {
  const out = [];
  const err = [];
  const io = { stdout: (line) => out.push(line), stderr: (line) => err.push(line) };

  const exitCode = await runCli(["eval", "--mode", "dry-run", "--cases", HOLDOUT_PATH], io);
  assert.equal(exitCode, EXIT_CODES.OK, err.join("\n"));

  const report = JSON.parse(out.join("\n"));
  assert.equal(report.schema, RETRO_EVAL_REPORT_SCHEMA);
  assert.deepEqual(collectRetroEvalReportIssues(report), []);
  assert.equal(report.totalCases, loadHoldoutDoc().cases.length);
  assert.deepEqual(report.counts, { passed: 0, failed: 0, timedOut: 0, unexecuted: report.totalCases });
  verifyFourStateCounts(report.counts, report.totalCases, "cli-dry-run");
  assert.match(report.provenance.originMainSha, /^[0-9a-f]{40}$/u);
  assert.match(report.provenance.harnessClosureSha256, /^[0-9a-f]{64}$/u);
  assert.match(report.provenance.casesSha256, /^[0-9a-f]{64}$/u);

  const leakScan = findRetroPrivateLeakage(report);
  assert.equal(leakScan.ok, true, `unexpected private leaks: ${JSON.stringify(leakScan.hits)}`);

  // Fail-closed CLI check when origin/main ref is unreachable
  const errFail = [];
  const failCode = await runCli(
    ["eval", "--mode", "dry-run", "--cases", HOLDOUT_PATH, "--origin-ref", "refs/remotes/origin/does-not-exist"],
    { stdout: () => {}, stderr: (line) => errFail.push(line) },
  );
  assert.equal(failCode, EXIT_CODES.INVALID_INPUT);
  assert.match(errFail.join("\n"), /Fail-closed/u);
});
