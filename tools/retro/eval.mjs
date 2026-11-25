/**
 * Offline & isolated-replay three-stage funnel evaluation engine for `tools/retro/`.
 *
 * Implements dec_D8EECF29C93D0C300252060A10 (CH2, CH3):
 * - Replay modes: `diff-only` and `tree-snapshot` (exclusively via `tools/readonly-checkout.mjs`,
 *   never `git worktree add`, materialized under `os.tmpdir()/ha-retro-<runId>/<caseId>` with
 *   exit/SIGINT/SIGTERM cleanup hooks and startup 24h orphan sweep).
 * - Dynamic free-memory concurrency clamping:
 *     `effectiveConcurrency = min(cliConcurrency, max(1, floor((freeMemMB - 2048) / 1024)))`.
 * - Three-stage funnel (`raw` / `postVerification` / `finalVerdict`) with dropoff attribution,
 *   Tier 1 deterministic evidence-group scoring + optional Tier 2 dual low-temperature judge.
 * - Strict four-state conservation (`passed + failed + timedOut + unexecuted === totalCases`),
 *   wall/cost budget circuit breaker (exit 3), `results.ndjson` checkpointing & `--resume-run`,
 *   and `--baseline` single-case regression veto (exit 1).
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync as purgePathSync,
  statSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  reviewFindingCategories,
  reviewVerdicts,
  validateReviewFindings,
} from "@harness-anything/kernel/internal/domain/review.ts";
import { reviewFindingReverifyIssues } from "@harness-anything/kernel/internal/domain/review-reverify.ts";
import {
  NON_BLOCKING_ONLY_CATEGORIES,
  evaluateCaseOutcome,
  verifyFourStateCounts,
} from "../evals/closeout-reviewer/run-eval.mjs";
import { materialize } from "../readonly-checkout.mjs";
import { DEFAULT_ORIGIN_REF, ProvenanceError, verifyJudgeProvenance } from "./lib/judge-provenance.mjs";
import { DEFAULT_CASE_WAIT_MS, execIsolatedCommand } from "./lib/process-runner.mjs";
import { SanitizeError, rejectPrivateLeakage } from "./lib/sanitize.mjs";
import {
  RETRO_EVAL_REPORT_SCHEMA,
  VALID_EVAL_MODES,
  VALID_REPLAY_MODES,
  collectRetroCaseIssues,
  collectRetroEvalReportIssues,
} from "./lib/schemas.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_CASES_PATH = path.join(REPO_ROOT, "tools", "retro", "datasets", "holdout.json");
const DEFAULT_LOCAL_RUNS_ROOT = path.join(REPO_ROOT, ".retro-local", "runs");
const CHECKPOINT_SCHEMA = "retro-eval-checkpoint/v1";
const NON_REWORK_BLOCKING_CATEGORIES = new Set([...NON_BLOCKING_ONLY_CATEGORIES, "ci-required"]);
const EVAL_VERDICTS = reviewVerdicts.filter((verdict) => verdict !== "dismissed");

const EXIT_OK = 0;
const EXIT_GATE_FAIL = 1;
const EXIT_INVALID = 2;
const EXIT_BUDGET = 3;

const DEFAULT_CLI_WORKERS = 2;
const FREE_MEM_RESERVE_MB = 2048;
const MEM_PER_WORKER_MB = 1024;
const BYTES_PER_MIB = 1024 * 1024;
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MIN_EXECUTED_FRACTION = 0.95;
const TEMP_DIR_PREFIX = "ha-retro-";
const SECONDARY_JUDGE_RUNS = 2;
const SECONDARY_JUDGE_TEMP = 0;
const PURGE_MAX_RETRIES = 4;
const PURGE_RETRY_DELAY_MS = 50;
const STRING_FLAG_SPEC = Object.freeze({ type: "string" });

export class EvalError extends Error {
  constructor(message, exitCode = EXIT_INVALID, code = "eval_error") {
    super(message);
    this.name = "EvalError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

function persistUtf8FileSync(targetPath, content) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const fd = openSync(targetPath, "w");
  try {
    writeSync(fd, content, undefined, "utf8");
  } finally {
    closeSync(fd);
  }
}

function appendUtf8LineSync(targetPath, line) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const fd = openSync(targetPath, "a");
  try {
    writeSync(fd, `${line}\n`, undefined, "utf8");
  } finally {
    closeSync(fd);
  }
}

function purgeDirQuietly(dirPath) {
  if (!dirPath || !existsSync(dirPath)) return;
  try {
    purgePathSync(dirPath, {
      recursive: true,
      force: true,
      maxRetries: PURGE_MAX_RETRIES,
      retryDelay: PURGE_RETRY_DELAY_MS,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

/**
 * Dynamic free-memory concurrency clamp:
 *   `effectiveConcurrency = min(cliConcurrency, max(1, floor((freeMemMB - 2048) / 1024)))`
 */
export function clampConcurrency(cliWorkers, freeMemBytes = os.freemem()) {
  if (!Number.isSafeInteger(cliWorkers) || cliWorkers < 1) {
    throw new EvalError(`--concurrency must be a positive integer (got ${String(cliWorkers)})`, EXIT_INVALID);
  }
  const freeMemMB = Math.floor(freeMemBytes / BYTES_PER_MIB);
  const memCap = Math.max(1, Math.floor((freeMemMB - FREE_MEM_RESERVE_MB) / MEM_PER_WORKER_MB));
  return Math.min(cliWorkers, memCap);
}

/**
 * Startup sweep of orphaned `ha-retro-*` temp directories older than `maxAgeMs` (default 24h).
 */
export function sweepOrphanRetroTempDirs(options = {}) {
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? ORPHAN_MAX_AGE_MS;
  const swept = [];
  if (!existsSync(tmpDir)) return swept;

  for (const entry of readdirSync(tmpDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_DIR_PREFIX)) continue;
    const fullPath = path.join(tmpDir, entry.name);
    let mtimeMs;
    try {
      mtimeMs = statSync(fullPath).mtimeMs;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (nowMs - mtimeMs > maxAgeMs) {
      purgeDirQuietly(fullPath);
      swept.push(fullPath);
    }
  }
  return swept;
}

function sanitizeDirToken(caseId) {
  return String(caseId)
    .replace(/[^a-zA-Z0-9._-]+/gu, "_")
    .slice(0, 80);
}

function evidenceWords(text) {
  return (
    String(text ?? "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).join(" ");
}

function matchTier1Evidence(evalCase, finding) {
  if (!Array.isArray(evalCase.expectedEvidence) || evalCase.expectedEvidence.length === 0) return false;
  const combined = ` ${evidenceWords(`${finding.anchor ?? ""} ${finding.text}`)} `;
  const proseOnly = ` ${evidenceWords(finding.text)} `;
  return evalCase.expectedEvidence.every((group, groupIndex) => {
    const haystack = groupIndex === 0 ? combined : proseOnly;
    return group.some((phrase) => haystack.includes(` ${evidenceWords(phrase)} `));
  });
}

function extractStageFindings(response, stageName) {
  if (!response || typeof response !== "object") return null;
  if (stageName === "raw") {
    if (Array.isArray(response.rawFindings)) return response.rawFindings;
    if (Array.isArray(response.stages?.raw?.findings)) return response.stages.raw.findings;
    return Array.isArray(response.findings) ? response.findings : null;
  }
  if (stageName === "postVerification") {
    if (Array.isArray(response.postVerificationFindings)) return response.postVerificationFindings;
    if (Array.isArray(response.stages?.postVerification?.findings)) return response.stages.postVerification.findings;
    return Array.isArray(response.findings) ? response.findings : null;
  }
  return Array.isArray(response.findings) ? response.findings : null;
}

function matchFindingOnStage(evalCase, finding) {
  if (!finding || typeof finding !== "object") return false;
  if (typeof finding.text !== "string" || finding.text.trim() === "") return false;
  if (!evalCase.expectedCategories.includes(finding.category)) return false;
  if (NON_REWORK_BLOCKING_CATEGORIES.has(finding.category)) return false;
  return matchTier1Evidence(evalCase, finding);
}

function evaluatePreFinalStage(evalCase, response, stageName, finalOutcome) {
  if (finalOutcome.status === "unexecuted") {
    return { status: "unexecuted", falseBlocked: false, matched: false, observed: false };
  }
  if (finalOutcome.status === "timedOut") {
    return { status: "timedOut", falseBlocked: false, matched: false, observed: false };
  }
  const findings = extractStageFindings(response, stageName);
  if (!findings) {
    return { status: "failed", falseBlocked: false, matched: false, observed: false };
  }

  if (evalCase.bucket === "positive") {
    const matched = findings.some((finding) => matchFindingOnStage(evalCase, finding));
    return { status: matched ? "passed" : "failed", falseBlocked: false, matched, observed: true };
  }

  const hasBlockingClaim = findings.some((finding) => finding && finding.blocking === true);
  if (hasBlockingClaim) {
    return { status: "failed", falseBlocked: true, matched: false, observed: true };
  }
  return { status: "passed", falseBlocked: false, matched: false, observed: true };
}

function emptyCounts() {
  return { passed: 0, failed: 0, timedOut: 0, unexecuted: 0 };
}

function falseBlockFraction(items) {
  if (!items.some((item) => item.observed)) return null;
  if (items.length === 0) return null;
  return items.filter((item) => item.falseBlocked).length / items.length;
}

function aggregateFunnelStage(outcomes, stageKey, totalCases) {
  const counts = emptyCounts();
  const stageRows = outcomes.map((outcome) => {
    if (stageKey === "finalVerdict") {
      return {
        bucket: outcome.bucket,
        status: outcome.status,
        falseBlocked: outcome.falseBlocked,
        observed: outcome.verdict !== null,
      };
    }
    const entry = outcome.funnel[stageKey];
    return {
      bucket: outcome.bucket,
      status: entry.status,
      falseBlocked: entry.falseBlocked,
      observed: entry.observed,
    };
  });

  for (const row of stageRows) {
    counts[row.status] += 1;
  }
  verifyFourStateCounts(counts, totalCases, `funnel.${stageKey}`);

  const positives = stageRows.filter((row) => row.bucket === "positive");
  const clean = stageRows.filter((row) => row.bucket === "negative" || row.bucket === "pre_existing");
  const preExisting = stageRows.filter((row) => row.bucket === "pre_existing");
  const positiveMatched = positives.filter((row) => row.status === "passed").length;
  const cleanFalseBlocked = clean.filter((row) => row.falseBlocked).length;

  return {
    counts,
    positiveMatched,
    positiveTotal: positives.length,
    cleanFalseBlocked,
    cleanTotal: clean.length,
    passRate: totalCases > 0 ? counts.passed / totalCases : 0,
    recall: positives.length > 0 ? positiveMatched / positives.length : 0,
    falsePositiveRate: falseBlockFraction(clean),
    preExistingFalseBlockRate: falseBlockFraction(preExisting),
  };
}

function classifyPositiveDropoff(rawStage, postVerStage, finalOutcome) {
  if (finalOutcome.status === "passed") return "passed";
  if (finalOutcome.status === "timedOut") return "timedOut";
  if (finalOutcome.status === "unexecuted") return "unexecuted";
  if (finalOutcome.adapterError) return "adapter-error";
  if (rawStage.status !== "passed") return "raw-miss";
  if (postVerStage.status !== "passed") return "verification-over-pruned";
  return "verdict-downgraded";
}

function buildReviewerPayload(evalCase, replayInfo) {
  return JSON.stringify({
    caseId: evalCase.id,
    taskContext: evalCase.taskContext,
    diff: evalCase.diff,
    replay: replayInfo,
    requiredOutputSchema: {
      verdict: EVAL_VERDICTS,
      findings: [{ findingId: "string", blocking: "boolean", category: reviewFindingCategories, text: "string" }],
      rawFindings: "optional array of stage-1 candidate findings",
      postVerificationFindings: "optional array of stage-2 post-verification findings",
    },
  });
}

function qualifySecondaryJudge(evalCase, response, baseOutcome) {
  if (evalCase.bucket !== "positive") return false;
  if (baseOutcome.status === "passed" || baseOutcome.adapterError) return false;
  if (!response || response.verdict !== "changes_requested" || !Array.isArray(response.findings)) return false;
  const [findingIssue] = validateReviewFindings(response.findings);
  if (findingIssue) return false;
  const [reverifyIssue] = reviewFindingReverifyIssues(response.findings);
  if (reverifyIssue) return false;
  return response.findings.some(
    (item) =>
      item.blocking === true &&
      evalCase.expectedCategories.includes(item.category) &&
      !NON_REWORK_BLOCKING_CATEGORIES.has(item.category),
  );
}

async function queryDualSecondaryJudge(evalCase, response, judgeCmd, waitMs) {
  const candidates = response.findings.filter(
    (item) =>
      item.blocking === true &&
      evalCase.expectedCategories.includes(item.category) &&
      !NON_REWORK_BLOCKING_CATEGORIES.has(item.category),
  );
  const votes = [];
  for (let idx = 1; idx <= SECONDARY_JUDGE_RUNS; idx += 1) {
    const payload = JSON.stringify({
      temperature: SECONDARY_JUDGE_TEMP,
      runIndex: idx,
      caseId: evalCase.id,
      title: evalCase.title,
      defectClass: evalCase.defectClass,
      expectedEvidence: evalCase.expectedEvidence,
      findings: candidates,
    });
    const proc = await execIsolatedCommand({
      command: judgeCmd,
      stdinText: payload,
      waitMs,
    });
    if (proc.status !== "ok") {
      votes.push({ runIndex: idx, match: false, error: proc.error });
      continue;
    }
    try {
      const parsed = JSON.parse(proc.stdout);
      votes.push({
        runIndex: idx,
        match: parsed?.match === true,
        reason: typeof parsed?.reason === "string" ? parsed.reason : "",
      });
    } catch (error) {
      votes.push({ runIndex: idx, match: false, error: `invalid judge JSON: ${error.message}` });
    }
  }
  const unanimousMatch = votes.length === SECONDARY_JUDGE_RUNS && votes.every((vote) => vote.match === true);
  const agreed = votes.length === SECONDARY_JUDGE_RUNS && votes[0].match === votes[1].match;
  return { unanimousMatch, agreed, votes, matchedCategories: [...new Set(candidates.map((c) => c.category))] };
}

async function scoreSingleCase(evalCase, response, options = {}) {
  const baseOutcome = evaluateCaseOutcome(evalCase, response);
  let finalOutcome = baseOutcome;
  let secondaryJudge = null;

  if (options.secondaryJudgeCmd && qualifySecondaryJudge(evalCase, response, baseOutcome)) {
    secondaryJudge = await queryDualSecondaryJudge(
      evalCase,
      response,
      options.secondaryJudgeCmd,
      options.caseWaitMs ?? DEFAULT_CASE_WAIT_MS,
    );
    if (secondaryJudge.unanimousMatch) {
      finalOutcome = {
        ...baseOutcome,
        status: "passed",
        matchedCategories: secondaryJudge.matchedCategories,
        reason: "blocking finding confirmed by unanimous dual low-temperature judge",
      };
    }
  }

  const rawStage = evaluatePreFinalStage(evalCase, response, "raw", finalOutcome);
  const postVerStage = evaluatePreFinalStage(evalCase, response, "postVerification", finalOutcome);
  const stageDiagnosis =
    evalCase.bucket === "positive"
      ? classifyPositiveDropoff(rawStage, postVerStage, finalOutcome)
      : finalOutcome.status;

  const costUsd =
    typeof response?.costUsd === "number" && Number.isFinite(response.costUsd) && response.costUsd >= 0
      ? response.costUsd
      : 0;

  return {
    ...finalOutcome,
    origin: evalCase.origin ?? "seed",
    diffSizeBucket: evalCase.diffSizeBucket ?? "xs",
    costUsd,
    replayKind: response?._replayKind ?? "diff-only",
    materializedCommit: response?._materializedCommit ?? null,
    stageDiagnosis,
    secondaryJudge,
    funnel: {
      raw: rawStage,
      postVerification: postVerStage,
    },
  };
}

function parseResponsesFile(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!existsSync(resolved)) {
    throw new EvalError(`Input responses file not found: ${resolved}`, EXIT_INVALID, "input_missing");
  }
  const rawText = readFileSync(resolved, "utf8").trim();
  if (rawText.length === 0) return [];
  if (resolved.endsWith(".ndjson")) {
    return rawText
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          const parsed = JSON.parse(line);
          return parsed.response ? { ...parsed.response, caseId: parsed.caseId } : parsed;
        } catch (error) {
          throw new EvalError(`Invalid NDJSON at line ${index + 1}: ${error.message}`, EXIT_INVALID, "invalid_ndjson");
        }
      });
  }
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.responses)) return parsed.responses;
    throw new EvalError("Input JSON must be an array or an object with a responses array", EXIT_INVALID);
  } catch (error) {
    if (error instanceof EvalError) throw error;
    throw new EvalError(`Invalid JSON in ${resolved}: ${error.message}`, EXIT_INVALID, "invalid_json");
  }
}

function locateResumeRunDir(resumeArg, runsRoot) {
  const direct = path.resolve(resumeArg);
  if (existsSync(path.join(direct, "results.ndjson"))) return direct;
  const underRuns = path.join(runsRoot, resumeArg);
  if (existsSync(path.join(underRuns, "results.ndjson"))) return underRuns;
  throw new EvalError(
    `Resume checkpoint not found for "${resumeArg}" (checked ${direct} and ${underRuns})`,
    EXIT_INVALID,
    "resume_not_found",
  );
}

function loadCheckpointRecords(checkpointPath) {
  const raw = readFileSync(checkpointPath, "utf8");
  const priorById = new Map();
  let priorRunId = null;
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new EvalError(
        `Corrupted checkpoint at ${checkpointPath}:${index + 1}: ${error.message}`,
        EXIT_INVALID,
        "corrupted_checkpoint",
      );
    }
    if (!record || typeof record.caseId !== "string") {
      throw new EvalError(`Checkpoint line ${index + 1} missing caseId`, EXIT_INVALID, "corrupted_checkpoint");
    }
    if (record.runId && !priorRunId) priorRunId = record.runId;
    if (record.outcome?.status && record.outcome.status !== "unexecuted") {
      priorById.set(record.caseId, record);
    }
  }
  return { priorById, priorRunId };
}

/**
 * Evaluate baseline regression gate:
 *   `executedRate >= 0.95 && deltaRecall > 0 && regressions === 0 && deltaFPR <= 0`
 * (Any single-case regression from `passed` -> non-`passed` vetoes the candidate.)
 */
export function evaluateBaselineGate(currentReport, baselineReport, options = {}) {
  if (!baselineReport || typeof baselineReport !== "object" || !Array.isArray(baselineReport.outcomes)) {
    throw new EvalError("Invalid baseline report: missing outcomes array", EXIT_INVALID, "invalid_baseline");
  }
  const baselineById = new Map(baselineReport.outcomes.map((item) => [item.caseId, item]));
  const regressedCaseIds = [];
  const improvedCaseIds = [];

  for (const outcome of currentReport.outcomes) {
    const base = baselineById.get(outcome.caseId);
    if (!base) continue;
    if (base.status === "passed" && outcome.status !== "passed") {
      regressedCaseIds.push(outcome.caseId);
    } else if (base.status !== "passed" && outcome.status === "passed") {
      improvedCaseIds.push(outcome.caseId);
    }
  }

  const totalCases = currentReport.totalCases;
  const executedCount = currentReport.counts.passed + currentReport.counts.failed;
  const executedFraction = totalCases > 0 ? executedCount / totalCases : 0;

  const baseRecall = Number(baselineReport.metrics?.recall ?? 0);
  const currRecall = Number(currentReport.metrics?.recall ?? 0);
  const deltaRecall = currRecall - baseRecall;

  const baseFpr = baselineReport.metrics?.falsePositiveRate ?? null;
  const currFpr = currentReport.metrics?.falsePositiveRate ?? null;
  const deltaFPR = currFpr === null && baseFpr === null ? 0 : (currFpr ?? 0) - (baseFpr ?? 0);

  const regressions = regressedCaseIds.length;
  const reasons = [];
  if (executedFraction < MIN_EXECUTED_FRACTION) {
    reasons.push(`executedRate ${executedFraction.toFixed(4)} < ${MIN_EXECUTED_FRACTION}`);
  }
  if (regressions > 0) {
    reasons.push(`single-case regression veto (${regressions}): ${regressedCaseIds.join(", ")}`);
  }
  if (deltaFPR > 0) {
    reasons.push(`falsePositiveRate regressed by +${deltaFPR.toFixed(4)}`);
  }
  const allowTie = options.allowTie === true;
  if (!allowTie && deltaRecall <= 0) {
    reasons.push(`deltaRecall ${deltaRecall.toFixed(4)} <= 0 (strict recall improvement required)`);
  } else if (allowTie && deltaRecall < 0) {
    reasons.push(`deltaRecall ${deltaRecall.toFixed(4)} < 0`);
  }

  return {
    passed: reasons.length === 0,
    executedRate: executedFraction,
    deltaRecall,
    deltaFPR,
    regressions,
    regressedCaseIds,
    improvedCaseIds,
    reasons,
  };
}

function buildBreakdown(outcomes, keyFn, labelPrefix) {
  const groups = {};
  for (const outcome of outcomes) {
    const key = keyFn(outcome);
    const entry = (groups[key] ??= { ...emptyCounts(), total: 0, adapterErrors: 0, validResponses: 0 });
    entry[outcome.status] += 1;
    entry.total += 1;
    entry.adapterErrors += Number(outcome.adapterError);
    entry.validResponses += Number(outcome.verdict !== null);
  }
  for (const [key, groupCounts] of Object.entries(groups)) {
    verifyFourStateCounts(groupCounts, groupCounts.total, `${labelPrefix}:${key}`);
  }
  return groups;
}

function assembleEvalReport(cases, outcomes, meta) {
  const totalCases = cases.length;
  const counts = emptyCounts();
  for (const outcome of outcomes) {
    counts[outcome.status] += 1;
  }
  verifyFourStateCounts(counts, totalCases, "total");

  const byBucket = buildBreakdown(outcomes, (o) => o.bucket, "bucket");
  const byDefectClass = buildBreakdown(outcomes, (o) => o.defectClass, "defectClass");
  const byOrigin = buildBreakdown(outcomes, (o) => o.origin, "origin");
  const byDiffSizeBucket = buildBreakdown(outcomes, (o) => o.diffSizeBucket, "diffSizeBucket");

  const rawFunnel = aggregateFunnelStage(outcomes, "raw", totalCases);
  const postVerFunnel = aggregateFunnelStage(outcomes, "postVerification", totalCases);
  const finalFunnel = aggregateFunnelStage(outcomes, "finalVerdict", totalCases);

  const positives = outcomes.filter((o) => o.bucket === "positive");
  const clean = outcomes.filter((o) => o.bucket === "negative" || o.bucket === "pre_existing");

  const dropoff = {
    rawMissedPositives: positives.filter((o) => o.stageDiagnosis === "raw-miss").length,
    prunedAtVerificationPositives: positives.filter((o) => o.stageDiagnosis === "verification-over-pruned").length,
    downgradedAtFinalVerdictPositives: positives.filter((o) => o.stageDiagnosis === "verdict-downgraded").length,
    noiseSuppressedAtVerification: clean.filter(
      (o) => o.funnel.raw.falseBlocked && !o.funnel.postVerification.falseBlocked,
    ).length,
    noiseSuppressedAtFinalVerdict: clean.filter(
      (o) => o.funnel.postVerification.falseBlocked && !o.falseBlocked && o.verdict !== null,
    ).length,
  };

  const latencies = outcomes.map((o) => o.latencyMs).filter((v) => typeof v === "number" && Number.isFinite(v));
  const totalLatencyMs = latencies.reduce((sum, v) => sum + v, 0);

  return {
    schema: RETRO_EVAL_REPORT_SCHEMA,
    version: 1,
    runId: meta.runId,
    mode: meta.mode,
    replayMode: meta.replayMode,
    effectiveConcurrency: meta.effectiveConcurrency,
    resumedFromRunId: meta.resumedFromRunId ?? null,
    reusedCaseCount: meta.reusedCaseCount ?? 0,
    newlyExecutedCaseCount: meta.newlyExecutedCaseCount ?? 0,
    sweptOrphanTempDirs: meta.sweptOrphanTempDirs ?? [],
    provenance: meta.provenance,
    totalCases,
    executedCases: counts.passed + counts.failed,
    counts,
    adapterErrors: outcomes.filter((o) => o.adapterError).length,
    validResponses: outcomes.filter((o) => o.verdict !== null).length,
    metrics: {
      passRate: finalFunnel.passRate,
      recall: finalFunnel.recall,
      falsePositiveRate: finalFunnel.falsePositiveRate,
      preExistingFalseBlockRate: finalFunnel.preExistingFalseBlockRate,
    },
    funnel: {
      raw: rawFunnel,
      postVerification: postVerFunnel,
      finalVerdict: finalFunnel,
      dropoff,
    },
    budget: meta.budget,
    gate: meta.gate ?? null,
    latencyMs: {
      totalMs: totalLatencyMs,
      meanMs: latencies.length > 0 ? totalLatencyMs / latencies.length : null,
      maxMs: latencies.length > 0 ? Math.max(...latencies) : null,
      measuredCount: latencies.length,
    },
    byBucket,
    byDefectClass,
    byOrigin,
    byDiffSizeBucket,
    outcomes,
  };
}

async function runCaseWithReplay(evalCase, context) {
  const { mode, replayMode, rootDir, runTempRoot, reviewerCmd, caseWaitMs, inputMap } = context;

  if (mode === "dry-run") {
    return { caseId: evalCase.id, status: "unexecuted", error: "dry-run mode", _replayKind: replayMode };
  }

  let snapshotDir = null;
  let replayKind = "diff-only";
  let materializedCommit = null;

  try {
    if (replayMode === "tree-snapshot" && evalCase.replayRef?.headSha) {
      snapshotDir = path.join(runTempRoot, sanitizeDirToken(evalCase.id));
      const mat = materialize({
        rootDir,
        revision: evalCase.replayRef.headSha,
        out: snapshotDir,
        deps: false,
      });
      if (!mat.ok) {
        return {
          caseId: evalCase.id,
          status: "errored",
          error: `readonly-checkout materialize failed for ${evalCase.replayRef.headSha}: ${mat.detail}`,
          _replayKind: "tree-snapshot",
        };
      }
      replayKind = "tree-snapshot";
      materializedCommit = mat.commit;
    }

    if (mode === "input") {
      const provided = inputMap.get(evalCase.id);
      if (!provided) {
        return {
          caseId: evalCase.id,
          status: "unexecuted",
          error: "missing from input",
          _replayKind: replayKind,
          _materializedCommit: materializedCommit,
        };
      }
      return { ...provided, _replayKind: replayKind, _materializedCommit: materializedCommit };
    }

    const payload = buildReviewerPayload(evalCase, {
      mode: replayKind,
      snapshotDir: snapshotDir ?? null,
      commitSha: materializedCommit,
    });
    const proc = await execIsolatedCommand({
      command: reviewerCmd,
      stdinText: payload,
      cwd: snapshotDir ?? rootDir,
      env: snapshotDir ? { ...process.env, RETRO_SNAPSHOT_DIR: snapshotDir } : process.env,
      waitMs: caseWaitMs,
    });

    if (proc.status === "timedOut") {
      return {
        caseId: evalCase.id,
        status: "timedOut",
        error: proc.error,
        latencyMs: proc.latencyMs,
        _replayKind: replayKind,
        _materializedCommit: materializedCommit,
      };
    }
    if (proc.status !== "ok") {
      return {
        caseId: evalCase.id,
        status: "errored",
        error: proc.error,
        latencyMs: proc.latencyMs,
        _replayKind: replayKind,
        _materializedCommit: materializedCommit,
      };
    }
    try {
      const parsed = JSON.parse(proc.stdout);
      return {
        ...parsed,
        caseId: evalCase.id,
        latencyMs: typeof parsed?.latencyMs === "number" ? parsed.latencyMs : proc.latencyMs,
        _replayKind: replayKind,
        _materializedCommit: materializedCommit,
      };
    } catch (error) {
      return {
        caseId: evalCase.id,
        status: "errored",
        error: `invalid reviewer JSON: ${error.message}`,
        latencyMs: proc.latencyMs,
        _replayKind: replayKind,
        _materializedCommit: materializedCommit,
      };
    }
  } finally {
    if (snapshotDir) {
      purgeDirQuietly(snapshotDir);
    }
  }
}

/**
 * Main programmatic entrypoint for `retro eval`.
 * Returns `{ exitCode, report, runDir, checkpointPath }`.
 */
export async function runEval(options = {}) {
  const mode = options.mode ?? "dry-run";
  const replayMode = options.replayMode ?? "diff-only";
  if (!VALID_EVAL_MODES.includes(mode)) {
    throw new EvalError(`Invalid --mode "${String(mode)}"; expected ${VALID_EVAL_MODES.join("|")}`, EXIT_INVALID);
  }
  if (!VALID_REPLAY_MODES.includes(replayMode)) {
    throw new EvalError(
      `Invalid --replay "${String(replayMode)}"; expected ${VALID_REPLAY_MODES.join("|")}`,
      EXIT_INVALID,
    );
  }

  const rootDir = path.resolve(options.repoRoot ?? REPO_ROOT);
  const casesPath = path.resolve(options.casesPath ?? DEFAULT_CASES_PATH);
  const originRef = options.originRef ?? DEFAULT_ORIGIN_REF;
  const caseWaitMs = options.caseWaitMs ?? DEFAULT_CASE_WAIT_MS;
  if (!Number.isSafeInteger(caseWaitMs) || caseWaitMs <= 0) {
    throw new EvalError(`--case-wait-ms must be a positive integer (got ${String(caseWaitMs)})`, EXIT_INVALID);
  }

  const cliWorkers = options.concurrency ?? DEFAULT_CLI_WORKERS;
  const effectiveWorkers = clampConcurrency(cliWorkers, options.freeMemBytes ?? os.freemem());

  const maxWallMs = options.maxWallMs ?? null;
  if (maxWallMs !== null && (!Number.isFinite(maxWallMs) || maxWallMs <= 0)) {
    throw new EvalError(`--max-wall-ms must be a positive number (got ${String(maxWallMs)})`, EXIT_INVALID);
  }
  const maxCostUsd = options.maxCostUsd ?? null;
  if (maxCostUsd !== null && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) {
    throw new EvalError(`--max-cost-usd must be a positive number (got ${String(maxCostUsd)})`, EXIT_INVALID);
  }

  const reviewerCmd =
    options.reviewerCmd ?? process.env.RETRO_EVAL_REVIEWER_CMD ?? process.env.CLOSEOUT_REVIEWER_EVAL_CMD ?? null;
  if (mode === "live" && (!reviewerCmd || reviewerCmd.trim() === "")) {
    throw new EvalError("--mode live requires --reviewer-cmd (or RETRO_EVAL_REVIEWER_CMD)", EXIT_INVALID);
  }
  if (mode === "input" && !options.inputPath && !Array.isArray(options.responses)) {
    throw new EvalError("--mode input requires --input <responses.json|.ndjson>", EXIT_INVALID);
  }

  const tmpBaseDir = options.tmpDir ?? os.tmpdir();
  const nowMs = options.nowMs ?? (() => Date.now());
  const sweptOrphanTempDirs = sweepOrphanRetroTempDirs({ tmpDir: tmpBaseDir, nowMs: nowMs() });

  const { provenance, casesRawText } = verifyJudgeProvenance({
    rootDir,
    originRef,
    targetRef: options.targetRef ?? "HEAD",
    casesPath,
    requireOriginCases: options.requireOriginCases === true,
    strictJudgeClosure: options.strictJudgeClosure === true,
  });

  let casesDoc;
  try {
    casesDoc = JSON.parse(casesRawText);
  } catch (error) {
    throw new EvalError(`Invalid JSON in cases file (${casesPath}): ${error.message}`, EXIT_INVALID, "invalid_json");
  }
  rejectPrivateLeakage(casesDoc, casesPath);
  const caseIssues = collectRetroCaseIssues(casesDoc);
  if (caseIssues.length > 0) {
    throw new EvalError(`Invalid retro cases (${casesPath}):\n- ${caseIssues.join("\n- ")}`, EXIT_INVALID);
  }

  const cases = casesDoc.cases;
  const inputMap = new Map();
  if (mode === "input") {
    const rawResponses = Array.isArray(options.responses) ? options.responses : parseResponsesFile(options.inputPath);
    const validIds = new Set(cases.map((c) => c.id));
    for (const item of rawResponses) {
      if (!item || typeof item.caseId !== "string") {
        throw new EvalError("Each input response must have a string caseId", EXIT_INVALID);
      }
      if (!validIds.has(item.caseId)) {
        throw new EvalError(`Input response references unknown caseId: ${item.caseId}`, EXIT_INVALID);
      }
      if (inputMap.has(item.caseId)) {
        throw new EvalError(`Duplicate input response for caseId: ${item.caseId}`, EXIT_INVALID);
      }
      inputMap.set(item.caseId, item);
    }
  }

  let baselineReport = null;
  if (options.baselinePath) {
    const resolvedBase = path.resolve(options.baselinePath);
    if (!existsSync(resolvedBase)) {
      throw new EvalError(`Baseline report not found: ${resolvedBase}`, EXIT_INVALID, "baseline_missing");
    }
    try {
      baselineReport = JSON.parse(readFileSync(resolvedBase, "utf8"));
    } catch (error) {
      throw new EvalError(`Invalid baseline JSON (${resolvedBase}): ${error.message}`, EXIT_INVALID);
    }
  }

  const runsRoot = options.runsRoot ?? DEFAULT_LOCAL_RUNS_ROOT;
  let priorById = new Map();
  let resumedFromRunId = null;
  let runDir = options.runDir ? path.resolve(options.runDir) : null;
  let runId = options.runId ?? randomUUID().slice(0, 12);

  if (options.resumeRun) {
    runDir = locateResumeRunDir(options.resumeRun, runsRoot);
    const checkpointFile = path.join(runDir, "results.ndjson");
    const loaded = loadCheckpointRecords(checkpointFile);
    priorById = loaded.priorById;
    resumedFromRunId = loaded.priorRunId ?? path.basename(runDir);
    runId = resumedFromRunId;
  } else if (!runDir && mode === "live" && options.persistCheckpoint !== false) {
    runDir = path.join(runsRoot, runId);
  }

  const checkpointPath = runDir ? path.join(runDir, "results.ndjson") : null;
  const runTempRoot = path.join(tmpBaseDir, `${TEMP_DIR_PREFIX}${runId}`);

  const cleanupRunTemp = () => {
    try {
      purgeDirQuietly(runTempRoot);
    } catch {
      // Final signal cleanup should not mask process exit.
      return;
    }
  };
  const onSigInt = () => {
    cleanupRunTemp();
    process.exitCode = 130;
  };
  const onSigTerm = () => {
    cleanupRunTemp();
    process.exitCode = 143;
  };
  process.once("exit", cleanupRunTemp);
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);

  const startedAtMs = nowMs();
  let spentCostUsd = 0;
  let capTruncated = false;
  let truncatedReason = null;
  let reusedCaseCount = 0;
  let newlyExecutedCaseCount = 0;

  const outcomesByIndex = new Array(cases.length);
  const pendingIndices = [];

  try {
    for (let idx = 0; idx < cases.length; idx += 1) {
      const evalCase = cases[idx];
      const prior = priorById.get(evalCase.id);
      if (prior) {
        outcomesByIndex[idx] = prior.outcome;
        spentCostUsd += Number(prior.outcome?.costUsd ?? 0);
        reusedCaseCount += 1;
      } else {
        pendingIndices.push(idx);
      }
    }

    const probeBudgetStop = () => {
      if (capTruncated) return true;
      const elapsed = nowMs() - startedAtMs;
      if (maxWallMs !== null && elapsed >= maxWallMs) {
        capTruncated = true;
        truncatedReason = `max-wall-ms exceeded (${elapsed}ms >= ${maxWallMs}ms)`;
        return true;
      }
      if (maxCostUsd !== null && spentCostUsd >= maxCostUsd) {
        capTruncated = true;
        truncatedReason = `max-cost-usd exceeded ($${spentCostUsd.toFixed(4)} >= $${maxCostUsd.toFixed(4)})`;
        return true;
      }
      return false;
    };

    let cursor = 0;
    const workerCount = Math.min(effectiveWorkers, Math.max(1, pendingIndices.length));

    const drainQueue = async () => {
      while (cursor < pendingIndices.length) {
        const idx = pendingIndices[cursor];
        cursor += 1;
        const evalCase = cases[idx];

        if (probeBudgetStop()) {
          const unexecResp = { caseId: evalCase.id, status: "unexecuted", error: truncatedReason };
          outcomesByIndex[idx] = await scoreSingleCase(evalCase, unexecResp);
          continue;
        }

        const response = await runCaseWithReplay(evalCase, {
          mode,
          replayMode,
          rootDir,
          runTempRoot,
          reviewerCmd,
          caseWaitMs,
          inputMap,
        });
        const outcome = await scoreSingleCase(evalCase, response, {
          secondaryJudgeCmd: options.secondaryJudgeCmd ?? null,
          caseWaitMs,
        });
        outcomesByIndex[idx] = outcome;
        spentCostUsd += outcome.costUsd;
        if (outcome.status !== "unexecuted") {
          newlyExecutedCaseCount += 1;
        }

        if (checkpointPath && outcome.status !== "unexecuted") {
          const record = {
            schema: CHECKPOINT_SCHEMA,
            runId,
            caseId: evalCase.id,
            recordedAt: new Date(nowMs()).toISOString(),
            response: {
              caseId: evalCase.id,
              status: response.status,
              verdict: response.verdict,
              findings: response.findings,
              rawFindings: response.rawFindings,
              postVerificationFindings: response.postVerificationFindings,
              latencyMs: response.latencyMs,
              costUsd: outcome.costUsd,
              error: response.error,
            },
            outcome,
          };
          appendUtf8LineSync(checkpointPath, JSON.stringify(record));
        }

        if (options.onCaseComplete) {
          options.onCaseComplete(outcome, idx);
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => drainQueue()));
  } finally {
    process.off("exit", cleanupRunTemp);
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    purgeDirQuietly(runTempRoot);
  }

  const elapsedWallMs = nowMs() - startedAtMs;
  const report = assembleEvalReport(cases, outcomesByIndex, {
    runId,
    mode,
    replayMode,
    effectiveConcurrency: effectiveWorkers,
    resumedFromRunId,
    reusedCaseCount,
    newlyExecutedCaseCount,
    sweptOrphanTempDirs,
    provenance,
    budget: {
      maxWallMs,
      maxCostUsd,
      elapsedWallMs,
      spentCostUsd,
      truncated: capTruncated,
      truncatedReason,
    },
  });

  if (baselineReport) {
    report.gate = evaluateBaselineGate(report, baselineReport, { allowTie: options.allowTie === true });
  }

  const reportIssues = collectRetroEvalReportIssues(report);
  if (reportIssues.length > 0) {
    throw new EvalError(`Internal report schema violation:\n- ${reportIssues.join("\n- ")}`, EXIT_INVALID);
  }

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (runDir) {
    persistUtf8FileSync(path.join(runDir, "report.json"), serialized);
  }
  if (options.outPath) {
    persistUtf8FileSync(path.resolve(options.outPath), serialized);
  }

  let exitCode = EXIT_OK;
  if (capTruncated) {
    exitCode = EXIT_BUDGET;
  } else if (report.gate && !report.gate.passed) {
    exitCode = EXIT_GATE_FAIL;
  }

  return { exitCode, report, runDir, checkpointPath };
}

export function formatEvalUsage() {
  return [
    "Usage: node tools/retro/cli.mjs eval [options]",
    "",
    "Options:",
    "  --mode <dry-run|input|live>         Evaluation mode (default: dry-run)",
    "  --replay <diff-only|tree-snapshot>  Replay isolation mode (default: diff-only)",
    "  --cases <path>                      Dataset JSON (default: tools/retro/datasets/holdout.json)",
    "  --input <path>                      Reviewer responses JSON or NDJSON (for --mode input)",
    "  --reviewer-cmd <cmd>                Reviewer command reading stdin JSON (for --mode live)",
    "  --tier2-judge-cmd <cmd>             Optional dual low-temperature judge command",
    "  --case-wait-ms <ms>                 Per-case kill deadline in ms (default: 60000)",
    "  --concurrency <n>                   Max workers before free-memory clamp (default: 2)",
    "  --max-wall-ms <ms>                  Wall-clock budget cap; remaining marked unexecuted (exit 3)",
    "  --max-cost-usd <usd>                Cost budget cap; remaining marked unexecuted (exit 3)",
    "  --baseline <path>                   Baseline retro-eval-report/v1 for regression veto (exit 1)",
    "  --allow-tie                         Allow deltaRecall === 0 with --baseline (regression-only)",
    "  --run-dir <path>                    Directory for results.ndjson checkpoint & report.json",
    "  --resume-run <runId-or-dir>         Resume unfinished cases from results.ndjson checkpoint",
    "  --out <path>                        Write retro-eval-report/v1 JSON to file",
    "  --origin-ref <ref>                  Origin git ref for tamper-proof closure (default: origin/main)",
    "  --require-origin-cases              Fail closed (exit 2) if cases path absent on origin ref",
    "  --strict-judge-closure              Fail closed (exit 2) if local judge files diverge from origin",
    "  --repo-root <path>                  Repository root for git/readonly-checkout operations",
    "  -h, --help                          Show this help",
  ].join("\n");
}

function parsePositiveNumberOption(raw, flagName, integerOnly) {
  if (raw === undefined) return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0 || (integerOnly && !Number.isSafeInteger(num))) {
    throw new EvalError(
      `${flagName} must be a positive ${integerOnly ? "integer" : "number"} (got "${raw}")`,
      EXIT_INVALID,
    );
  }
  return num;
}

export async function runEvalCli(argv = [], io = {}) {
  const stdout = io.stdout ?? ((line) => console.log(line));
  const stderr = io.stderr ?? ((line) => console.error(line));

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        mode: { type: "string" },
        replay: { type: "string" },
        cases: { type: "string" },
        input: { type: "string" },
        "reviewer-cmd": STRING_FLAG_SPEC,
        "tier2-judge-cmd": STRING_FLAG_SPEC,
        "case-wait-ms": STRING_FLAG_SPEC,
        concurrency: STRING_FLAG_SPEC,
        "max-wall-ms": { type: "string" },
        "max-cost-usd": { type: "string" },
        baseline: { type: "string" },
        "allow-tie": { type: "boolean", default: false },
        "run-dir": { type: "string" },
        "resume-run": { type: "string" },
        out: { type: "string" },
        "origin-ref": { type: "string" },
        "require-origin-cases": { type: "boolean", default: false },
        "strict-judge-closure": { type: "boolean", default: false },
        "repo-root": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    stderr(`retro eval: ${error instanceof Error ? error.message : String(error)}\n\n${formatEvalUsage()}`);
    return EXIT_INVALID;
  }

  if (parsed.values.help) {
    stdout(formatEvalUsage());
    return EXIT_OK;
  }

  if (!parsed.values.mode) {
    stderr(`retro eval: missing required --mode <dry-run|input|live>\n\n${formatEvalUsage()}`);
    return EXIT_INVALID;
  }

  try {
    const { exitCode, report } = await runEval({
      mode: parsed.values.mode,
      replayMode: parsed.values.replay,
      casesPath: parsed.values.cases,
      inputPath: parsed.values.input,
      reviewerCmd: parsed.values["reviewer-cmd"],
      secondaryJudgeCmd: parsed.values["tier2-judge-cmd"],
      caseWaitMs: parsePositiveNumberOption(parsed.values["case-wait-ms"], "--case-wait-ms", true),
      concurrency: parsePositiveNumberOption(parsed.values.concurrency, "--concurrency", true),
      maxWallMs: parsePositiveNumberOption(parsed.values["max-wall-ms"], "--max-wall-ms", false) ?? null,
      maxCostUsd: parsePositiveNumberOption(parsed.values["max-cost-usd"], "--max-cost-usd", false) ?? null,
      baselinePath: parsed.values.baseline,
      allowTie: parsed.values["allow-tie"],
      runDir: parsed.values["run-dir"],
      resumeRun: parsed.values["resume-run"],
      outPath: parsed.values.out,
      originRef: parsed.values["origin-ref"],
      requireOriginCases: parsed.values["require-origin-cases"],
      strictJudgeClosure: parsed.values["strict-judge-closure"],
      repoRoot: parsed.values["repo-root"],
    });
    stdout(JSON.stringify(report, null, 2));
    return exitCode;
  } catch (error) {
    if (error instanceof ProvenanceError || error instanceof EvalError) {
      stderr(`retro eval: ${error.message}`);
      return error.exitCode;
    }
    if (error instanceof SanitizeError) {
      stderr(`retro eval: ${error.message}`);
      return EXIT_GATE_FAIL;
    }
    stderr(`retro eval: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_GATE_FAIL;
  }
}
