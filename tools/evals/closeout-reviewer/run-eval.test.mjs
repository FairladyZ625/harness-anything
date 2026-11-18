// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { reviewFindingCategories, reviewVerdicts } from "@harness-anything/kernel/internal/domain/review.ts";
import {
  assertFourStateCounts,
  loadEvalCases,
  runDryRun,
  scoreEvalResults,
  validateEvalCasesDocument,
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
              text: `Detected ${item.defectClass}`,
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
  assert.ok(validateEvalCasesDocument(badCategoryDoc).some((msg) => msg.includes("unknown ReviewFindingCategory")));

  const styleOnlyPositiveDoc = structuredClone(doc);
  styleOnlyPositiveDoc.cases[0].expectedCategories = ["style"];
  assert.ok(validateEvalCasesDocument(styleOnlyPositiveDoc).some((msg) => msg.includes("style/diagnostic/cleanup")));

  const leakedPathDoc = structuredClone(doc);
  const privateDir = [".harness", "-private"].join("");
  leakedPathDoc.cases[0].diff += `\n// leaked path: ${privateDir}/secret-notes.md\n`;
  assert.ok(validateEvalCasesDocument(leakedPathDoc).some((msg) => msg.includes("private path marker")));
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
    () => assertFourStateCounts({ passed: cases.length - 2, failed: 0, timedOut: 1, unexecuted: 1 }, cases.length - 2),
    /four-state accounting mismatch/u,
  );
  assert.throws(
    () => scoreEvalResults(cases, responses, { expectedTotalCases: cases.length - 1 }),
    /four-state accounting mismatch/u,
  );
});
