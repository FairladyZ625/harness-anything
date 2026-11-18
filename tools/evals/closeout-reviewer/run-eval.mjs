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
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { reviewFindingCategories, reviewVerdicts } from "@harness-anything/kernel/internal/domain/review.ts";

export const EVAL_CASES_SCHEMA = "closeout-reviewer-eval-cases/v1";
export const EVAL_REPORT_SCHEMA = "closeout-reviewer-eval-report/v1";
export const VALID_BUCKETS = Object.freeze(["positive", "negative", "pre_existing"]);
export const NON_BLOCKING_ONLY_CATEGORIES = Object.freeze(["style", "diagnostic", "cleanup"]);

const DEFAULT_CASES_PATH = path.resolve(import.meta.dirname, "cases.json");
const DEFAULT_LIVE_TIMEOUT_MS = 60_000;
const PRIVATE_LEAK_PATTERN = /(?:^|[^a-zA-Z0-9_.-])(?:\.harness-private\/|harness\/|\.harness\/|\/Users\/)/u;

/** Scan a JSON-serializable fixture document for private ledger paths or local user directories. */
export function findPrivateLeakage(document) {
  const serialized = typeof document === "string" ? document : JSON.stringify(document);
  const match = PRIVATE_LEAK_PATTERN.exec(serialized);
  return match ? [match[0].trim()] : [];
}

/** Validate the golden case dataset against kernel ReviewFindingCategory and ReviewVerdict vocabularies. */
export function validateEvalCasesDocument(doc) {
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
    if (!reviewVerdicts.includes(entry.expectedVerdict) || entry.expectedVerdict === "dismissed") {
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
    if (!entry.taskContext || typeof entry.taskContext !== "object" || typeof entry.taskContext.summary !== "string") {
      issues.push(`${label}: missing taskContext.summary`);
    }
    if (typeof entry.diff !== "string" || entry.diff.trim() === "") {
      issues.push(`${label}: missing unified diff`);
    }
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
  const issues = validateEvalCasesDocument(raw);
  if (issues.length > 0) {
    throw new Error(`Invalid eval cases (${casesPath}):\n- ${issues.join("\n- ")}`);
  }
  return raw;
}

/** Enforce explicit four-state accounting so timed-out or unexecuted cases can never be dropped from the denominator. */
export function assertFourStateCounts(counts, totalCases, label = "eval") {
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

/** Evaluate a single reviewer response against one golden case. */
export function evaluateCaseOutcome(evalCase, response) {
  const base = {
    caseId: evalCase.id,
    bucket: evalCase.bucket,
    defectClass: evalCase.defectClass,
    expectedVerdict: evalCase.expectedVerdict,
    latencyMs:
      typeof response?.latencyMs === "number" && Number.isFinite(response.latencyMs) ? response.latencyMs : null,
  };

  if (!response || response.status === "unexecuted") {
    return {
      ...base,
      status: "unexecuted",
      verdict: null,
      matchedCategories: [],
      reason: response?.error ?? "not executed",
    };
  }
  if (response.status === "timedOut") {
    return { ...base, status: "timedOut", verdict: null, matchedCategories: [], reason: response.error ?? "timed out" };
  }
  if (response.status === "errored" || !reviewVerdicts.includes(response.verdict)) {
    return {
      ...base,
      status: "failed",
      verdict: response.verdict ?? null,
      matchedCategories: [],
      reason: response.error ?? `invalid or missing verdict: ${String(response.verdict)}`,
    };
  }

  const findings = Array.isArray(response.findings) ? response.findings : [];
  const blockingFindings = findings.filter((item) => item && item.blocking === true);

  if (evalCase.expectedVerdict === "changes_requested") {
    if (response.verdict !== "changes_requested") {
      return {
        ...base,
        status: "failed",
        verdict: response.verdict,
        matchedCategories: [],
        reason: `missed defect: expected changes_requested, got ${response.verdict}`,
      };
    }
    const matchedCategories = blockingFindings
      .map((item) => item.category ?? "correctness")
      .filter(
        (category) =>
          reviewFindingCategories.includes(category) &&
          !NON_BLOCKING_ONLY_CATEGORIES.includes(category) &&
          evalCase.expectedCategories.includes(category),
      );
    if (matchedCategories.length === 0) {
      return {
        ...base,
        status: "failed",
        verdict: response.verdict,
        matchedCategories: [],
        reason: `changes_requested lacked blocking finding in expected categories [${evalCase.expectedCategories.join(", ")}]`,
      };
    }
    return {
      ...base,
      status: "passed",
      verdict: response.verdict,
      matchedCategories: [...new Set(matchedCategories)],
      reason: "detected defect and matched category",
    };
  }

  if (response.verdict !== "approved" || blockingFindings.length > 0) {
    return {
      ...base,
      status: "failed",
      verdict: response.verdict,
      matchedCategories: [],
      reason:
        evalCase.bucket === "pre_existing"
          ? `pre-existing false block: expected approved, got ${response.verdict} with ${blockingFindings.length} blocking finding(s)`
          : `false positive: expected approved, got ${response.verdict} with ${blockingFindings.length} blocking finding(s)`,
    };
  }

  return {
    ...base,
    status: "passed",
    verdict: response.verdict,
    matchedCategories: [],
    nonBlockingNotesCount: findings.length - blockingFindings.length,
    reason: "clean approval with zero blocking findings",
  };
}

function emptyCounts() {
  return { passed: 0, failed: 0, timedOut: 0, unexecuted: 0 };
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
    byBucket[outcome.bucket] ??= { ...emptyCounts(), total: 0 };
    byBucket[outcome.bucket][outcome.status] += 1;
    byBucket[outcome.bucket].total += 1;

    byDefectClass[outcome.defectClass] ??= { ...emptyCounts(), total: 0 };
    byDefectClass[outcome.defectClass][outcome.status] += 1;
    byDefectClass[outcome.defectClass].total += 1;
  }

  const expectedTotal = options.expectedTotalCases ?? cases.length;
  assertFourStateCounts(counts, expectedTotal, "total");
  for (const [bucket, bucketCounts] of Object.entries(byBucket)) {
    assertFourStateCounts(bucketCounts, bucketCounts.total, `bucket:${bucket}`);
  }
  for (const [defectClass, classCounts] of Object.entries(byDefectClass)) {
    assertFourStateCounts(classCounts, classCounts.total, `defectClass:${defectClass}`);
  }

  const positiveOutcomes = outcomes.filter((item) => item.bucket === "positive");
  const cleanOutcomes = outcomes.filter((item) => item.bucket === "negative" || item.bucket === "pre_existing");
  const preExistingOutcomes = outcomes.filter((item) => item.bucket === "pre_existing");

  const positivePassed = positiveOutcomes.filter((item) => item.status === "passed").length;
  const cleanFalseBlocked = cleanOutcomes.filter((item) => item.status === "failed").length;
  const preExistingBlocked = preExistingOutcomes.filter((item) => item.status === "failed").length;

  const measuredLatencies = outcomes.map((item) => item.latencyMs).filter((value) => value !== null);
  const totalMs = measuredLatencies.reduce((sum, value) => sum + value, 0);

  return {
    schema: EVAL_REPORT_SCHEMA,
    mode: options.mode ?? "offline",
    totalCases: expectedTotal,
    executedCases: counts.passed + counts.failed,
    counts,
    metrics: {
      passRate: expectedTotal > 0 ? counts.passed / expectedTotal : 0,
      recall: positiveOutcomes.length > 0 ? positivePassed / positiveOutcomes.length : 0,
      falsePositiveRate: cleanOutcomes.length > 0 ? cleanFalseBlocked / cleanOutcomes.length : 0,
      preExistingFalseBlockRate: preExistingOutcomes.length > 0 ? preExistingBlocked / preExistingOutcomes.length : 0,
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
      verdict: "approved | changes_requested",
      reason: "string",
      findings: [{ findingId: "string", blocking: "boolean", category: reviewFindingCategories, text: "string" }],
    },
  });
}

function invokeReviewerCommand(command, evalCase, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ caseId: evalCase.id, status: "unexecuted", error: error.message, latencyMs: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const latencyMs = Date.now() - startedAt;
      if (timedOut) {
        resolve({ caseId: evalCase.id, status: "timedOut", error: `timed out after ${timeoutMs}ms`, latencyMs });
        return;
      }
      if (code !== 0) {
        resolve({
          caseId: evalCase.id,
          status: "errored",
          error: stderr.trim() || `reviewer exited with code ${String(code)}`,
          latencyMs,
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve({
          caseId: evalCase.id,
          verdict: parsed.verdict,
          findings: parsed.findings ?? [],
          reason: parsed.reason,
          latencyMs,
        });
      } catch (error) {
        resolve({
          caseId: evalCase.id,
          status: "errored",
          error: `invalid JSON from reviewer: ${error instanceof Error ? error.message : String(error)}`,
          latencyMs,
        });
      }
    });

    child.stdin.end(buildReviewerPrompt(evalCase));
  });
}

/** Run explicit on-demand live evaluation against a reviewer command that reads JSON on stdin and writes verdict JSON. */
export async function runLiveEval(options = {}) {
  const doc = loadEvalCases(options.casesPath ?? DEFAULT_CASES_PATH);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS;
  const reviewerCmd = options.reviewerCmd ?? process.env.CLOSEOUT_REVIEWER_EVAL_CMD;
  if (!reviewerCmd) {
    const unexecuted = doc.cases.map((item) => ({
      caseId: item.id,
      status: "unexecuted",
      error: "missing --reviewer-cmd or CLOSEOUT_REVIEWER_EVAL_CMD",
    }));
    return scoreEvalResults(doc.cases, unexecuted, { mode: "live" });
  }
  const responses = [];
  for (const evalCase of doc.cases) {
    responses.push(await invokeReviewerCommand(reviewerCmd, evalCase, timeoutMs));
  }
  return scoreEvalResults(doc.cases, responses, { mode: "live" });
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
      "timeout-ms": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node tools/evals/closeout-reviewer/run-eval.mjs [--dry-run | --input <responses.json> | --live --reviewer-cmd <cmd>] [--cases <cases.json>] [--out <report.json>]\n",
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
    const timeoutMs = values["timeout-ms"] ? Number(values["timeout-ms"]) : DEFAULT_LIVE_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("--timeout-ms must be a positive integer");
    }
    report = await runLiveEval({ casesPath, reviewerCmd: values["reviewer-cmd"], timeoutMs });
  }

  const formatted = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) writeFileSync(path.resolve(values.out), formatted, "utf8");
  process.stdout.write(formatted);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
