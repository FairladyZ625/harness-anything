// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { reviewFindingCategories, reviewVerdicts } from "@harness-anything/kernel/internal/domain/review.ts";
import {
  verifyFourStateCounts,
  loadEvalCases,
  runDryRun,
  runLiveEval,
  scoreEvalResults,
  collectEvalCaseIssues,
} from "./run-eval.mjs";

const casesPath = path.resolve(import.meta.dirname, "cases.json");

function perfectResponsesFor(cases) {
  return cases.map((item, index) => ({
    caseId: item.id,
    verdict: item.expectedVerdict,
    findings:
      item.expectedVerdict === "changes_requested"
        ? [
            {
              findingId: `f-${index}`,
              blocking: true,
              category: item.expectedCategories[0],
              text: item.expectedEvidence.map(([phrase]) => phrase).join(". "),
            },
          ]
        : item.bucket === "pre_existing"
          ? [
              {
                findingId: `note-${index}`,
                blocking: false,
                label: "Pre-existing",
                category: "style",
                text: "Untouched legacy code outside diff.",
              },
            ]
          : [],
    latencyMs: 120 + index,
  }));
}

test("golden dataset passes dry-run validation and aligns with kernel review vocabularies", () => {
  const dry = runDryRun(casesPath);
  const doc = loadEvalCases(casesPath);

  assert.equal(dry.ok, true);
  assert.equal(dry.privateLeakHits, 0);
  assert.ok(dry.totalCases >= 12 && dry.totalCases <= 20, `expected 12..20 cases, got ${dry.totalCases}`);
  assert.ok(dry.buckets.positive >= 5, "must include >= 5 positive incident cases");
  assert.ok(dry.buckets.negative >= 5, "must include >= 5 clean negative cases");
  assert.ok(dry.buckets.pre_existing >= 2, "must include >= 2 pre_existing boundary cases");
  assert.deepEqual(dry.counts, { passed: 0, failed: 0, timedOut: 0, unexecuted: dry.totalCases });
  const parsed = spawnSync("git", ["apply", "--numstat", "-"], {
    input: doc.cases.map(({ diff }) => diff).join(""),
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout.trim().split("\n").length, 24);

  for (const defectClass of [
    "fake-green-test",
    "zombie-module",
    "host-package-bloat",
    "weakened-test-oracle",
    "swallowed-error-fallback",
  ]) {
    assert.ok((dry.defectClasses[defectClass] ?? 0) >= 1, `missing required defectClass ${defectClass}`);
  }

  for (const item of doc.cases) {
    assert.ok(reviewVerdicts.includes(item.expectedVerdict));
    for (const category of item.expectedCategories) {
      assert.ok(reviewFindingCategories.includes(category), `invalid category ${category}`);
    }
  }
});

test("schema validator rejects unknown categories, non-blocking-only positives, and private paths", () => {
  const doc = structuredClone(loadEvalCases(casesPath));

  const badCategoryDoc = structuredClone(doc);
  badCategoryDoc.cases[0].expectedCategories = ["invented-category"];
  assert.ok(collectEvalCaseIssues(badCategoryDoc).some((msg) => msg.includes("unknown ReviewFindingCategory")));

  const styleOnlyPositiveDoc = structuredClone(doc);
  styleOnlyPositiveDoc.cases[0].expectedCategories = ["style"];
  assert.ok(collectEvalCaseIssues(styleOnlyPositiveDoc).some((msg) => msg.includes("style/diagnostic/cleanup")));

  const leakedPathDoc = structuredClone(doc);
  const privateDir = [".harness", "-private"].join("");
  leakedPathDoc.cases[0].diff += `\n// leaked path: ${privateDir}/secret-notes.md\n`;
  assert.ok(collectEvalCaseIssues(leakedPathDoc).some((msg) => msg.includes("private path marker")));
});

test("dry-run rejects corrupted hunks, trailing garbage and non-diff text", async (context) => {
  const {
    schema,
    cases: [entry],
  } = loadEvalCases(casesPath);
  const temp = await mkdtemp(path.join(os.tmpdir(), "review-eval-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const invalidCasesPath = path.join(temp, "cases.json");

  for (const diff of [
    "not a diff\n",
    entry.diff.replace(/@@ -(\d+),(\d+)/u, (_, line, count) => `@@ -${line},${Number(count) + 1}`),
    entry.diff + "+extra hunk line\n",
    entry.diff + "trailing garbage\n",
    "diff --git a/reviewer-probe.txt b/reviewer-probe.txt\nnew file mode 100644\n--- /dev/null\n+++ b/reviewer-probe.txt\n@@ -1 +1 @@\n-old\n+new\n",
    "diff --git a/reviewer-probe.txt b/reviewer-probe.txt\ndeleted file mode 100644\n--- a/reviewer-probe.txt\n+++ /dev/null\n@@ -1 +1 @@\n-old\n+new\n",
  ]) {
    await writeFile(invalidCasesPath, JSON.stringify({ schema, cases: [{ ...entry, diff }] }));
    assert.throws(() => runDryRun(invalidCasesPath), /invalid unified diff/u);
  }

  assert.match(
    collectEvalCaseIssues({ schema, cases: [{ ...entry, expectedEvidence: [["  "], ["404"], ["headers"]] }] }).join(
      "\n",
    ),
    /positive case needs at least three non-empty evidence groups/u,
  );
});

test("scorer computes 100% recall and 0% FPR on perfect responses, and drops recall or raises FPR on errors", () => {
  const doc = loadEvalCases(casesPath);
  const cases = doc.cases;

  const perfect = scoreEvalResults(cases, perfectResponsesFor(cases));
  assert.equal(perfect.counts.passed, cases.length);
  assert.equal(perfect.counts.failed, 0);
  assert.equal(perfect.counts.timedOut, 0);
  assert.equal(perfect.counts.unexecuted, 0);
  assert.equal(perfect.metrics.passRate, 1);
  assert.equal(perfect.metrics.recall, 1);
  assert.equal(perfect.metrics.falsePositiveRate, 0);
  assert.equal(perfect.metrics.preExistingFalseBlockRate, 0);

  // Missed positive defect reduces Recall
  const missedPositive = perfectResponsesFor(cases);
  const firstPosIdx = cases.findIndex((item) => item.bucket === "positive");
  missedPositive[firstPosIdx] = { caseId: cases[firstPosIdx].id, verdict: "approved", findings: [], latencyMs: 100 };
  const missedReport = scoreEvalResults(cases, missedPositive);
  const positiveCount = cases.filter((item) => item.bucket === "positive").length;
  assert.equal(missedReport.counts.failed, 1);
  assert.equal(missedReport.metrics.recall, (positiveCount - 1) / positiveCount);

  // False block on clean negative PR raises FPR
  const falsePositive = perfectResponsesFor(cases);
  const firstNegIdx = cases.findIndex((item) => item.bucket === "negative");
  falsePositive[firstNegIdx] = {
    caseId: cases[firstNegIdx].id,
    verdict: "changes_requested",
    findings: [{ findingId: "fp-1", blocking: true, category: "correctness", text: "Spurious block" }],
    latencyMs: 90,
  };
  const fpReport = scoreEvalResults(cases, falsePositive);
  const cleanCount = cases.filter((item) => item.bucket === "negative" || item.bucket === "pre_existing").length;
  assert.equal(fpReport.counts.failed, 1);
  assert.equal(fpReport.metrics.falsePositiveRate, 1 / cleanCount);

  // False block on pre_existing boundary raises preExistingFalseBlockRate & FPR
  const preExistingBlock = perfectResponsesFor(cases);
  const firstPreIdx = cases.findIndex((item) => item.bucket === "pre_existing");
  preExistingBlock[firstPreIdx] = {
    caseId: cases[firstPreIdx].id,
    verdict: "changes_requested",
    findings: [{ findingId: "pre-1", blocking: true, category: "correctness", text: "Blocking on old code" }],
    latencyMs: 80,
  };
  const preReport = scoreEvalResults(cases, preExistingBlock);
  const preCount = cases.filter((item) => item.bucket === "pre_existing").length;
  assert.equal(preReport.metrics.preExistingFalseBlockRate, 1 / preCount);
  assert.equal(preReport.metrics.falsePositiveRate, 1 / cleanCount);
});

test("recall requires a legal blocking finding with all evidence groups on the same finding", () => {
  const [incident] = loadEvalCases(casesPath).cases;
  const [response] = perfectResponsesFor([incident]);
  const [finding] = response.findings;
  const alternatives = [
    { ...finding, text: "Unrelated naming concern" },
    { ...finding, anchor: "test/static-broker.test.ts:2", text: "Rename the test." },
    { ...finding, text: "The response is 404." },
    {
      ...finding,
      anchor: "test/static-broker.test.ts:7",
      text: "The 404 response body uses an inconsistent capitalization for its error message.",
    },
    { ...finding, text: "The policy has a 1404 error." },
    { ...finding, blocking: false },
    { ...finding, category: "style" },
  ];
  for (const candidate of alternatives) {
    const report = scoreEvalResults([incident], [{ ...response, findings: [candidate] }]);
    if (candidate.blocking && candidate.category !== "style") {
      assert.equal(report.validResponses, 1);
    } else {
      assert.equal(report.adapterErrors, 1);
      assert.equal(report.validResponses, 0);
    }
    assert.equal(report.metrics.recall, 0, JSON.stringify(candidate));
  }
  const split = scoreEvalResults(
    [incident],
    [{ ...response, findings: [alternatives[1], { ...alternatives[2], findingId: "second" }] }],
  );
  assert.equal(split.metrics.recall, 0);
  const anchored = scoreEvalResults(
    [incident],
    [
      {
        ...response,
        findings: [
          {
            ...finding,
            anchor: "test/static-broker.test.ts:2",
            text: "The security headers test does not set up dist or assert status, so a 404 with those headers satisfies the test.",
          },
        ],
      },
    ],
  );
  assert.equal(anchored.metrics.recall, 1);
});

test("malformed verdicts and findings are protocol errors on both positive and clean cases", () => {
  const { cases } = loadEvalCases(casesPath);
  const pair = [cases[0], cases.find(({ bucket }) => bucket === "negative")];
  for (const [index, response] of perfectResponsesFor(pair).entries()) {
    const finding = {
      findingId: "f-1",
      text: "static-broker.test.ts returns 404 with security headers",
      category: "correctness",
      blocking: true,
    };
    for (const badResponse of [
      { ...response, verdict: "dismissed" },
      { ...response, status: "unknown" },
      { ...response, findings: undefined },
      { ...response, findings: "not an array" },
      { ...response, findings: [null] },
      { ...response, findings: [{ ...finding, findingId: " " }] },
      { ...response, findings: [{ ...finding, text: "" }] },
      { ...response, findings: [{ ...finding, category: undefined }] },
      { ...response, findings: [{ ...finding, category: "unknown" }] },
      { ...response, findings: [{ ...finding, blocking: "yes" }] },
      { ...response, findings: [finding, finding] },
      { ...response, verdict: "changes_requested", findings: [] },
      {
        ...response,
        verdict: "changes_requested",
        findings: [{ findingId: "ci", blocking: true, category: "ci-required", text: "CI is pending." }],
      },
      { ...response, verdict: "approved", findings: [finding] },
    ]) {
      const report = scoreEvalResults([pair[index]], [badResponse]);
      assert.deepEqual(report.counts, { passed: 0, failed: 1, timedOut: 0, unexecuted: 0 });
      assert.equal(report.adapterErrors, 1);
      assert.equal(report.validResponses, 0);
      assert.equal(report.metrics.recall, 0);
      assert.equal(report.metrics.falsePositiveRate, null);
      assert.match(report.outcomes[0].reason, /^invalid reviewer response:/u);
    }
  }
});

test("FPR counts only legal reviewer false blocks against the full fixture denominator", () => {
  const { cases } = loadEvalCases(casesPath);
  const clean = cases.filter(({ bucket }) => bucket !== "positive");
  const responses = perfectResponsesFor(clean);
  responses[0] = { ...responses[0], status: "errored", error: "command not found" };
  responses[1] = {
    ...responses[1],
    verdict: "changes_requested",
    findings: [{ findingId: "fp-clean", blocking: true, category: "correctness", text: "Spurious block on clean PR." }],
  };
  responses[2] = { ...responses[2], verdict: "changes_requested", findings: [] };
  responses[5] = { ...responses[5], status: "unavailable", error: "missing adapter" };
  responses[6] = {
    ...responses[6],
    verdict: "changes_requested",
    findings: [{ findingId: "fp-pre", blocking: true, category: "correctness", text: "Blocked on untouched code." }],
  };
  const report = scoreEvalResults(clean, responses);
  assert.deepEqual(report.counts, { passed: 2, failed: 4, timedOut: 0, unexecuted: 1 });
  assert.equal(report.adapterErrors, 3);
  assert.equal(report.validResponses, 4);
  assert.equal(report.byBucket.pre_existing.adapterErrors, 1);
  assert.equal(report.byBucket.pre_existing.validResponses, 1);
  assert.equal(report.metrics.falsePositiveRate, 2 / 7);
  assert.equal(report.metrics.preExistingFalseBlockRate, 1 / 2);

  const withoutVerdicts = scoreEvalResults(
    clean,
    clean.map(({ id }) => ({ caseId: id, status: "errored" })),
  );
  assert.equal(withoutVerdicts.adapterErrors, 7);
  assert.equal(withoutVerdicts.validResponses, 0);
  assert.equal(withoutVerdicts.metrics.falsePositiveRate, null);
  assert.equal(withoutVerdicts.metrics.preExistingFalseBlockRate, null);
});

test(
  "live deadline freezes a case and kills a TERM-ignoring reviewer group",
  {
    skip: process.platform === "win32" ? "requires POSIX shell and process-group signals" : false,
    timeout: 2000,
  },
  async (context) => {
    const { schema, cases } = loadEvalCases(casesPath);
    const negative = cases.find(({ bucket }) => bucket === "negative");
    const temp = await mkdtemp(path.join(os.tmpdir(), "review-timeout-"));
    context.after(() => rm(temp, { recursive: true, force: true }));
    const fixture = path.join(temp, "cases.json");
    await writeFile(fixture, JSON.stringify({ schema, cases: [negative] }));
    const watcher = watch(temp).on("change", (event, file) => {
      if (file === "ready") watcher.emit("ready");
    });
    context.after(() => watcher.close());
    const ready = once(watcher, "ready");
    const signal = context.mock.method(process, "kill");
    context.mock.timers.enable({ apis: ["setTimeout"] });

    const approval = JSON.stringify({ verdict: "approved", findings: [] });
    const result = runLiveEval({
      casesPath: fixture,
      caseWaitMs: 1000,
      reviewerCmd: `exec sh -c 'trap "" TERM; printf "%s" "$2"; : > "$1"; exec sleep 10' sh '${path.join(temp, "ready")}' '${approval}'`,
    });
    await ready;
    context.mock.timers.tick(1000);
    const [term] = signal.mock.calls;
    assert.ok(term.arguments[0] < 0);
    assert.equal(term.arguments[1], "SIGTERM");
    context.mock.timers.runAll();

    const report = await result;
    const kill = signal.mock.calls.find(({ arguments: args }) => args[1] === "SIGKILL");
    assert.equal(kill?.arguments[0], term.arguments[0]);
    assert.equal(kill?.result, true);
    assert.deepEqual(report.counts, { passed: 0, failed: 0, timedOut: 1, unexecuted: 0 });
    assert.equal(report.validResponses, 0);
    assert.equal(report.outcomes[0].verdict, null);
  },
);

test("four-state accounting keeps timedOut and unexecuted in total denominator and rejects folding", () => {
  const doc = loadEvalCases(casesPath);
  const cases = doc.cases;
  const responses = perfectResponsesFor(cases);

  const posIdx = cases.findIndex((item) => item.bucket === "positive");
  const negIdx = cases.findIndex((item) => item.bucket === "negative");
  responses[posIdx] = { caseId: cases[posIdx].id, status: "timedOut", error: "worker timeout", latencyMs: 60_000 };
  responses[negIdx] = { caseId: cases[negIdx].id, status: "unexecuted", error: "skipped" };

  const report = scoreEvalResults(cases, responses);
  assert.equal(report.totalCases, cases.length);
  assert.equal(report.counts.timedOut, 1);
  assert.equal(report.counts.unexecuted, 1);
  assert.equal(report.counts.passed, cases.length - 2);
  assert.equal(report.counts.failed, 0);
  assert.equal(report.executedCases, cases.length - 2);
  assert.equal(
    report.counts.passed + report.counts.failed + report.counts.timedOut + report.counts.unexecuted,
    report.totalCases,
  );
  // Timed-out positive case stays in positive denominator, lowering recall instead of inflating it.
  const positiveCount = cases.filter((item) => item.bucket === "positive").length;
  assert.equal(report.metrics.recall, (positiveCount - 1) / positiveCount);
  assert.equal(report.metrics.passRate, (cases.length - 2) / cases.length);

  // Positive control: attempting to drop timedOut/unexecuted from total denominator must throw.
  assert.throws(
    () => verifyFourStateCounts({ passed: cases.length - 2, failed: 0, timedOut: 1, unexecuted: 1 }, cases.length - 2),
    /four-state accounting mismatch/u,
  );
  assert.throws(
    () => scoreEvalResults(cases, responses, { expectedTotalCases: cases.length - 1 }),
    /four-state accounting mismatch/u,
  );
});
