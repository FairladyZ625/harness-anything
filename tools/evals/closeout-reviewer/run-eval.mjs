#!/usr/bin/env node
/**
 * Offline & on-demand regression evaluator for closeout-reviewer.
 *
 * Implements dec_C03EF62BF9ED0F2FB77F0B5115/CH3:
 * - Validates sanitized golden incident / clean / pre-existing fixture cases against kernel review vocabularies.
 * - Scores reviewer responses with explicit four-state accounting (passed / failed / timedOut / unexecuted),
 *   forbidding denominator folding of timed-out or unexecuted cases.
 * - Supports `--dry-run` (offline structural check), `--input <file>` (deterministic scoring), and explicit
 *   opt-in `--live` evaluation (never wired into daily PR required gates).
 */
import { createWriteStream, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  reviewFindingCategories,
  reviewVerdicts,
  validateReviewFindings,
} from "@harness-anything/kernel/internal/domain/review.ts";
import { runReviewerCommand } from "./reviewer-command.mjs";
import { unifiedDiffIssue } from "./unified-diff.mjs";

export const EVAL_CASES_SCHEMA = "closeout-reviewer-eval-cases/v1";
export const EVAL_REPORT_SCHEMA = "closeout-reviewer-eval-report/v1";
export const VALID_BUCKETS = Object.freeze(["positive", "negative", "pre_existing"]);
export const NON_BLOCKING_ONLY_CATEGORIES = Object.freeze(["style", "diagnostic", "cleanup"]);

const EVAL_VERDICTS = reviewVerdicts.filter((verdict) => verdict !== "dismissed");
const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_CASES_PATH = path.resolve(import.meta.dirname, "cases.json");
const DEFAULT_LIVE_WAIT_MS = 60_000;
const PRIVATE_LEAK_PATTERN = /(?:^|[^a-zA-Z0-9_.-])(?:\.harness-private\/|harness\/|\.harness\/|\/Users\/)/u;

/** Scan a JSON-serializable fixture document for private ledger paths or local user directories. */
export function findPrivateLeakage(document) {
  const serialized = typeof document === "string" ? document : JSON.stringify(document);
  const match = PRIVATE_LEAK_PATTERN.exec(serialized);
  return match ? [match[0].trim()] : [];
}

/** Collect structural or vocabulary issues on the golden case dataset against kernel ReviewFindingCategory and ReviewVerdict. */
export function collectEvalCaseIssues(doc) {
  const issues = [];
  if (!doc || typeof doc !== "object" || doc.schema !== EVAL_CASES_SCHEMA || !Array.isArray(doc.cases)) {
    return [`expected ${EVAL_CASES_SCHEMA} document with a cases array`];
  }
  if (doc.cases.length === 0) return ["cases array must not be empty"];

  const seenIds = new Set();
  for (const [index, entry] of doc.cases.entries()) {
    const label = entry?.id ? `case ${entry.id}` : `cases[${index}]`;
    if (!entry || typeof entry !== "object") {
      issues.push(`${label}: must be an object`);
      continue;
    }
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      issues.push(`${label}: missing non-empty id`);
    } else if (seenIds.has(entry.id)) {
      issues.push(`${label}: duplicate case id`);
    } else {
      seenIds.add(entry.id);
    }
    if (!VALID_BUCKETS.includes(entry.bucket)) {
      issues.push(`${label}: invalid bucket ${String(entry.bucket)}`);
    }
    if (typeof entry.defectClass !== "string" || entry.defectClass.trim() === "") {
      issues.push(`${label}: missing defectClass`);
    }
    if (typeof entry.title !== "string" || entry.title.trim() === "") {
      issues.push(`${label}: missing title`);
    }
    if (!EVAL_VERDICTS.includes(entry.expectedVerdict)) {
      issues.push(`${label}: expectedVerdict must be approved or changes_requested`);
    }
    if (!Array.isArray(entry.expectedCategories)) {
      issues.push(`${label}: expectedCategories must be an array`);
    } else {
      for (const category of entry.expectedCategories) {
        if (!reviewFindingCategories.includes(category)) {
          issues.push(`${label}: unknown ReviewFindingCategory ${String(category)}`);
        }
      }
      if (entry.bucket === "positive") {
        if (entry.expectedVerdict !== "changes_requested") {
          issues.push(`${label}: positive case must expect changes_requested`);
        }
        const hasBlockingCategory = entry.expectedCategories.some(
          (category) => !NON_BLOCKING_ONLY_CATEGORIES.includes(category),
        );
        if (!hasBlockingCategory) {
          issues.push(
            `${label}: positive case must require at least one blocking category outside style/diagnostic/cleanup`,
          );
        }
      } else if (entry.bucket === "negative" || entry.bucket === "pre_existing") {
        if (entry.expectedVerdict !== "approved") {
          issues.push(`${label}: ${entry.bucket} case must expect approved`);
        }
        if (entry.expectedCategories.length > 0) {
          issues.push(`${label}: ${entry.bucket} case must have empty expectedCategories`);
        }
      }
    }
    if (entry.bucket === "positive" && !hasExpectedEvidence(entry.expectedEvidence)) {
      issues.push(`${label}: positive case needs at least two non-empty evidence groups`);
    }
    if (!entry.taskContext || typeof entry.taskContext !== "object" || typeof entry.taskContext.summary !== "string") {
      issues.push(`${label}: missing taskContext.summary`);
    }
    const diffIssue = unifiedDiffIssue(entry.diff);
    if (diffIssue) issues.push(`${label}: invalid unified diff: ${diffIssue}`);
  }

  const leaks = findPrivateLeakage(doc);
  if (leaks.length > 0) {
    issues.push(`private path marker detected in fixture: ${leaks.join(", ")}`);
  }
  return issues;
}

/** Read and validate the golden eval cases file. */
export function loadEvalCases(casesPath = DEFAULT_CASES_PATH) {
  const raw = JSON.parse(readFileSync(casesPath, "utf8"));
  const issues = collectEvalCaseIssues(raw);
  if (issues.length > 0) {
    throw new Error(`Invalid eval cases (${casesPath}):\n- ${issues.join("\n- ")}`);
  }
  return raw;
}

/** Enforce explicit four-state accounting so timed-out or unexecuted cases can never be dropped from the denominator. */
export function verifyFourStateCounts(counts, totalCases, label = "eval") {
  if (!counts || typeof counts !== "object") {
    throw new Error(`${label}: counts object is required`);
  }
  const states = ["passed", "failed", "timedOut", "unexecuted"];
  let sum = 0;
  for (const state of states) {
    const value = counts[state];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label}: four-state count ${state} must be a non-negative integer (got ${String(value)})`);
    }
    sum += value;
  }
  if (!Number.isSafeInteger(totalCases) || totalCases < 0) {
    throw new Error(`${label}: totalCases must be a non-negative integer (got ${String(totalCases)})`);
  }
  if (sum !== totalCases) {
    throw new Error(
      `${label}: four-state accounting mismatch: passed(${counts.passed}) + failed(${counts.failed}) + ` +
        `timedOut(${counts.timedOut}) + unexecuted(${counts.unexecuted}) = ${sum} !== totalCases(${totalCases})`,
    );
  }
  return counts;
}

function evidenceWords(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}

function hasExpectedEvidence(groups) {
  return (
    Array.isArray(groups) &&
    groups.length >= 2 &&
    groups.every(
      (group) =>
        Array.isArray(group) &&
        group.length > 0 &&
        group.every((phrase) => typeof phrase === "string" && evidenceWords(phrase).length > 0),
    )
  );
}

function reviewerProtocolIssue(response) {
  if (response.status !== undefined) return `unknown response status: ${String(response.status)}`;
  if (!EVAL_VERDICTS.includes(response.verdict)) return `invalid or missing verdict: ${String(response.verdict)}`;
  const [issue] = validateReviewFindings(response.findings, true);
  if (issue) return issue.message;
  if (response.findings.some(({ category }) => category === undefined)) return "each finding requires a category";
  return null;
}

function matchesExpectedEvidence(evalCase, finding) {
  const text = ` ${evidenceWords(`${finding.anchor ?? ""} ${finding.text}`)} `;
  return evalCase.expectedEvidence.every((group) =>
    group.some((phrase) => text.includes(` ${evidenceWords(phrase)} `)),
  );
}

/** Evaluate a single reviewer response against one golden case. */
export function evaluateCaseOutcome(evalCase, response) {
  const base = {
    caseId: evalCase.id,
    bucket: evalCase.bucket,
    defectClass: evalCase.defectClass,
    expectedVerdict: evalCase.expectedVerdict,
    latencyMs:
      typeof response?.latencyMs === "number" && Number.isFinite(response.latencyMs) ? response.latencyMs : null,
    verdict: null,
    matchedCategories: [],
    adapterError: false,
    falseBlocked: false,
  };

  if (!response || response.status === "unexecuted" || response.status === "unavailable") {
    return {
      ...base,
      status: "unexecuted",
      adapterError: response?.status === "unavailable",
      reason: response?.error ?? "not executed",
    };
  }
  if (response.status === "timedOut") {
    return { ...base, status: "timedOut", reason: response.error ?? "timed out" };
  }
  if (response.status === "errored") {
    return { ...base, status: "failed", adapterError: true, reason: response.error ?? "reviewer adapter failed" };
  }
  const issue = reviewerProtocolIssue(response);
  if (issue) {
    return { ...base, status: "failed", adapterError: true, reason: `invalid reviewer response: ${issue}` };
  }

  const { verdict, findings } = response;
  const blockingFindings = findings.filter(({ blocking }) => blocking);
  if (evalCase.bucket === "positive") {
    if (verdict !== "changes_requested") {
      return { ...base, status: "failed", verdict, reason: `missed defect: got ${verdict}` };
    }
    const matchedCategories = blockingFindings
      .filter(
        (finding) =>
          evalCase.expectedCategories.includes(finding.category) &&
          !NON_BLOCKING_ONLY_CATEGORIES.includes(finding.category) &&
          matchesExpectedEvidence(evalCase, finding),
      )
      .map(({ category }) => category);
    if (matchedCategories.length === 0) {
      return {
        ...base,
        status: "failed",
        verdict,
        reason: "no blocking finding matched the target evidence and category",
      };
    }
    return {
      ...base,
      status: "passed",
      verdict,
      matchedCategories: [...new Set(matchedCategories)],
      reason: "blocking finding matched the target evidence and category",
    };
  }

  if (verdict === "changes_requested" || blockingFindings.length > 0) {
    return {
      ...base,
      status: "failed",
      verdict,
      falseBlocked: true,
      reason: `expected approved with zero blocking findings, got ${verdict} with ${blockingFindings.length} blocking finding(s)`,
    };
  }
  return { ...base, status: "passed", verdict, nonBlockingNotesCount: findings.length, reason: "clean approval" };
}

function emptyCounts() {
  return { passed: 0, failed: 0, timedOut: 0, unexecuted: 0 };
}

function falseBlockRate(outcomes) {
  // Rates keep the full fixture denominator. No legal verdict in this slice means no observation.
  if (!outcomes.some(({ verdict }) => verdict !== null)) return null;
  return outcomes.filter(({ falseBlocked }) => falseBlocked).length / outcomes.length;
}

/** Score a full set of reviewer responses against the golden case list. */
export function scoreEvalResults(cases, responses = [], options = {}) {
  if (!Array.isArray(cases)) throw new Error("cases must be an array");
  if (!Array.isArray(responses)) throw new Error("responses must be an array");

  const caseIds = new Set(cases.map((item) => item.id));
  const responseById = new Map();
  for (const response of responses) {
    if (!response || typeof response.caseId !== "string") {
      throw new Error("each response must include a string caseId");
    }
    if (!caseIds.has(response.caseId)) {
      throw new Error(`response references unknown caseId: ${response.caseId}`);
    }
    if (responseById.has(response.caseId)) {
      throw new Error(`duplicate response for caseId: ${response.caseId}`);
    }
    responseById.set(response.caseId, response);
  }

  const outcomes = cases.map((evalCase) => evaluateCaseOutcome(evalCase, responseById.get(evalCase.id)));
  const counts = emptyCounts();
  const byBucket = {};
  const byDefectClass = {};

  for (const outcome of outcomes) {
    counts[outcome.status] += 1;
    const bucket = (byBucket[outcome.bucket] ??= { ...emptyCounts(), total: 0, adapterErrors: 0, validResponses: 0 });
    bucket[outcome.status] += 1;
    bucket.total += 1;
    bucket.adapterErrors += Number(outcome.adapterError);
    bucket.validResponses += Number(outcome.verdict !== null);

    byDefectClass[outcome.defectClass] ??= { ...emptyCounts(), total: 0 };
    byDefectClass[outcome.defectClass][outcome.status] += 1;
    byDefectClass[outcome.defectClass].total += 1;
  }

  const expectedTotal = options.expectedTotalCases ?? cases.length;
  verifyFourStateCounts(counts, expectedTotal, "total");
  for (const [bucket, bucketCounts] of Object.entries(byBucket)) {
    verifyFourStateCounts(bucketCounts, bucketCounts.total, `bucket:${bucket}`);
  }
  for (const [defectClass, classCounts] of Object.entries(byDefectClass)) {
    verifyFourStateCounts(classCounts, classCounts.total, `defectClass:${defectClass}`);
  }

  const positiveOutcomes = outcomes.filter((item) => item.bucket === "positive");
  const cleanOutcomes = outcomes.filter((item) => item.bucket === "negative" || item.bucket === "pre_existing");
  const preExistingOutcomes = outcomes.filter((item) => item.bucket === "pre_existing");

  const positivePassed = positiveOutcomes.filter((item) => item.status === "passed").length;

  const measuredLatencies = outcomes.map((item) => item.latencyMs).filter((value) => value !== null);
  const totalMs = measuredLatencies.reduce((sum, value) => sum + value, 0);

  return {
    schema: EVAL_REPORT_SCHEMA,
    mode: options.mode ?? "offline",
    totalCases: expectedTotal,
    executedCases: counts.passed + counts.failed,
    counts,
    adapterErrors: outcomes.filter(({ adapterError }) => adapterError).length,
    validResponses: outcomes.filter(({ verdict }) => verdict !== null).length,
    metrics: {
      passRate: expectedTotal > 0 ? counts.passed / expectedTotal : 0,
      recall: positiveOutcomes.length > 0 ? positivePassed / positiveOutcomes.length : 0,
      falsePositiveRate: falseBlockRate(cleanOutcomes),
      preExistingFalseBlockRate: falseBlockRate(preExistingOutcomes),
    },
    latencyMs: {
      totalMs,
      meanMs: measuredLatencies.length > 0 ? totalMs / measuredLatencies.length : null,
      maxMs: measuredLatencies.length > 0 ? Math.max(...measuredLatencies) : null,
      measuredCount: measuredLatencies.length,
    },
    byBucket,
    byDefectClass,
    outcomes,
  };
}

/** Validate the benchmark fixture set offline without invoking any LLM or network call. */
export function runDryRun(casesPath = DEFAULT_CASES_PATH) {
  const doc = loadEvalCases(casesPath);
  const dryResponses = doc.cases.map((item) => ({ caseId: item.id, status: "unexecuted" }));
  const report = scoreEvalResults(doc.cases, dryResponses, { mode: "dry-run" });
  return {
    ok: true,
    casesPath: path.relative(process.cwd(), path.resolve(casesPath)).split(path.sep).join("/"),
    schema: doc.schema,
    totalCases: report.totalCases,
    counts: report.counts,
    buckets: Object.fromEntries(Object.entries(report.byBucket).map(([key, value]) => [key, value.total])),
    defectClasses: Object.fromEntries(Object.entries(report.byDefectClass).map(([key, value]) => [key, value.total])),
    privateLeakHits: 0,
  };
}

function buildReviewerPrompt(evalCase) {
  return JSON.stringify({
    taskContext: evalCase.taskContext,
    diff: evalCase.diff,
    requiredOutputSchema: {
      verdict: EVAL_VERDICTS,
      findings: [{ findingId: "string", blocking: "boolean", category: reviewFindingCategories, text: "string" }],
    },
  });
}

async function invokeReviewerCommand(command, evalCase, caseWaitMs) {
  const { stdout, ...result } = await runReviewerCommand(command, buildReviewerPrompt(evalCase), caseWaitMs);
  if (result.status) return { caseId: evalCase.id, ...result };
  try {
    const parsed = JSON.parse(stdout);
    return { caseId: evalCase.id, verdict: parsed?.verdict, findings: parsed?.findings, latencyMs: result.latencyMs };
  } catch (error) {
    return { caseId: evalCase.id, status: "errored", error: `invalid reviewer JSON: ${error.message}`, ...result };
  }
}

/** Run explicit on-demand live evaluation against a reviewer command that reads JSON on stdin and writes verdict JSON. */
export async function runLiveEval(options = {}) {
  const doc = loadEvalCases(options.casesPath ?? DEFAULT_CASES_PATH);
  const caseWaitMs = options.caseWaitMs ?? DEFAULT_LIVE_WAIT_MS;
  if (!Number.isSafeInteger(caseWaitMs) || caseWaitMs <= 0 || caseWaitMs > MAX_TIMER_MS) {
    throw new Error(`--case-wait-ms must be an integer between 1 and ${MAX_TIMER_MS}`);
  }
  const reviewerCmd = options.reviewerCmd ?? process.env.CLOSEOUT_REVIEWER_EVAL_CMD;
  const unavailable =
    process.platform === "win32"
      ? "live evaluation requires POSIX process groups"
      : reviewerCmd?.trim()
        ? null
        : "missing --reviewer-cmd or CLOSEOUT_REVIEWER_EVAL_CMD";
  if (unavailable) {
    const unexecuted = doc.cases.map((item) => ({
      caseId: item.id,
      status: "unavailable",
      error: unavailable,
    }));
    return scoreEvalResults(doc.cases, unexecuted, { mode: "live" });
  }
  const responses = [];
  for (const evalCase of doc.cases) {
    responses.push(await invokeReviewerCommand(reviewerCmd, evalCase, caseWaitMs));
  }
  return scoreEvalResults(doc.cases, responses, { mode: "live" });
}

function writeReportFile(targetPath, content) {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(targetPath, "utf8");
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end(content);
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      input: { type: "string" },
      cases: { type: "string" },
      out: { type: "string" },
      "reviewer-cmd": { type: "string" },
      "case-wait-ms": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(
      "Usage: node tools/evals/closeout-reviewer/run-eval.mjs [--dry-run | --input <responses.json> | --live --reviewer-cmd <cmd>] [--cases <cases.json>] [--out <report.json>]",
    );
    return;
  }

  const casesPath = values.cases ? path.resolve(values.cases) : DEFAULT_CASES_PATH;
  let report;
  if (values["dry-run"] || (!values.live && !values.input)) {
    report = runDryRun(casesPath);
  } else if (values.input) {
    const doc = loadEvalCases(casesPath);
    const input = JSON.parse(readFileSync(path.resolve(values.input), "utf8"));
    const responses = Array.isArray(input) ? input : input.responses;
    report = scoreEvalResults(doc.cases, responses, { mode: "offline-replay" });
  } else {
    const caseWaitMs = values["case-wait-ms"] ? Number(values["case-wait-ms"]) : DEFAULT_LIVE_WAIT_MS;
    report = await runLiveEval({ casesPath, reviewerCmd: values["reviewer-cmd"], caseWaitMs });
  }

  const formatted = JSON.stringify(report, null, 2);
  if (values.out) await writeReportFile(path.resolve(values.out), `${formatted}\n`);
  console.log(formatted);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
