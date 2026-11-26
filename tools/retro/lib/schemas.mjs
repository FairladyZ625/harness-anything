import {
  reviewFindingCategories,
  reviewFindingLabels,
  reviewVerdicts,
} from "@harness-anything/kernel/internal/domain/review.ts";
import {
  EVAL_CASES_SCHEMA,
  NON_BLOCKING_ONLY_CATEGORIES,
  VALID_BUCKETS,
  collectEvalCaseIssues,
  verifyFourStateCounts,
} from "../../evals/closeout-reviewer/run-eval.mjs";
import { unifiedDiffIssue } from "../../evals/closeout-reviewer/unified-diff.mjs";
import { findRetroPrivateLeakage } from "./sanitize.mjs";

export {
  EVAL_CASES_SCHEMA,
  NON_BLOCKING_ONLY_CATEGORIES,
  VALID_BUCKETS,
  reviewFindingCategories,
  reviewFindingLabels,
  reviewVerdicts,
  unifiedDiffIssue,
  verifyFourStateCounts,
};

export const RETRO_CASES_SCHEMA = "retro-cases/v1";
export const RETRO_EVAL_REPORT_SCHEMA = "retro-eval-report/v1";
export const RETRO_DISTILL_PROPOSAL_SCHEMA = "retro-distill-proposal/v1";
export const RETRO_AUDIT_REPORT_SCHEMA = "retro-audit-report/v1";
export const RETRO_BASELINES_SCHEMA = "retro-baselines/v1";
export const RETRO_PRUNE_PLAN_SCHEMA = "retro-prune-plan/v1";
export const VALID_ALLOWLIST_OBSERVABILITY = Object.freeze(["observable", "unobservable"]);
export const VALID_PRUNE_ACTIONS = Object.freeze([
  "remove_quarantine",
  "remove_allowlist_entry",
  "review_waiver_dispute",
  "enrich_decision_whynot",
  "quarantine_or_archive_fact",
  "retire_stale_rule",
]);
export const VALID_PRUNE_PRIORITIES = Object.freeze(["high", "medium", "low"]);
export const VALID_EVAL_MODES = Object.freeze(["dry-run", "input", "live"]);
export const VALID_REPLAY_MODES = Object.freeze(["diff-only", "tree-snapshot"]);
export const VALID_FUNNEL_STAGES = Object.freeze(["raw", "postVerification", "finalVerdict"]);
export const VALID_DISTILL_TARGETS = Object.freeze(["semantic-rule", "deterministic-gate"]);
export const VALID_DISTILL_PROPOSAL_STATUSES = Object.freeze([
  "approved_for_pr",
  "rejected_false_positive",
  "rejected_self_test",
]);
export const VALID_FALSIFICATION_VERDICTS = Object.freeze(["pass", "reject"]);
export const DISTILL_MIN_CLUSTER_TASKS = 2;
export const DISTILL_PROBE_TRIALS = 3;
export const DISTILL_SEMANTIC_MIN_HITS = 2;
export const VALID_ORIGINS = Object.freeze(["review-execution", "task-rework", "git-revert", "clean-control", "seed"]);
export const VALID_SPLITS = Object.freeze(["tuning", "holdout"]);
export const VALID_DATASET_SPLITS = Object.freeze(["tuning", "holdout", "all"]);
export const VALID_DIFF_SIZE_BUCKETS = Object.freeze(["xs", "s", "m", "l"]);

export const DIFF_SIZE_THRESHOLDS = Object.freeze({
  xsMax: 30,
  sMax: 120,
  mMax: 400,
});

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

/** Count effective added/deleted lines inside unified diff hunks (excluding file headers). */
export function countEffectiveDiffLines(diff) {
  if (typeof diff !== "string" || diff.length === 0) return 0;
  let count = 0;
  let inHunk = false;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if ((line.startsWith("+") && !line.startsWith("+++ ")) || (line.startsWith("-") && !line.startsWith("--- "))) {
      count += 1;
    }
  }
  return count;
}

/** Classify effective diff line count into one of the four stratification buckets (xs/s/m/l). */
export function classifyDiffSizeBucket(diffLines) {
  if (!Number.isSafeInteger(diffLines) || diffLines < 0) {
    throw new TypeError(`diffLines must be a non-negative safe integer (got ${String(diffLines)})`);
  }
  if (diffLines <= DIFF_SIZE_THRESHOLDS.xsMax) return "xs";
  if (diffLines <= DIFF_SIZE_THRESHOLDS.sMax) return "s";
  if (diffLines <= DIFF_SIZE_THRESHOLDS.mMax) return "m";
  return "l";
}

function collectReplayRefIssues(replayRef, label) {
  const issues = [];
  if (!replayRef || typeof replayRef !== "object" || Array.isArray(replayRef)) {
    return [`${label}: replayRef must be an object`];
  }
  for (const field of ["baseSha", "headSha"]) {
    const val = replayRef[field];
    if (val !== null && (typeof val !== "string" || !SHA_PATTERN.test(val))) {
      issues.push(`${label}: replayRef.${field} must be null or a 40-char lowercase hex SHA`);
    }
  }
  return issues;
}

/**
 * Validate a `retro-cases/v1` (or backward-compatible `closeout-reviewer-eval-cases/v1`) document.
 * Reuses `collectEvalCaseIssues` from `closeout-reviewer/run-eval.mjs` and enforces strengthened
 * retro privacy checks and metadata invariants.
 */
export function collectRetroCaseIssues(doc, options = {}) {
  const issues = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return ["document must be a JSON object"];
  }

  const isLegacy = doc.schema === EVAL_CASES_SCHEMA;
  const isRetro = doc.schema === RETRO_CASES_SCHEMA;
  if (!isRetro && !isLegacy) {
    return [`expected schema ${RETRO_CASES_SCHEMA} (or compatible ${EVAL_CASES_SCHEMA}), got ${String(doc.schema)}`];
  }
  if (!Array.isArray(doc.cases)) {
    return ["cases must be an array"];
  }

  if (doc.cases.length === 0) {
    if (options.allowEmpty !== true) {
      issues.push("cases array must not be empty");
    }
  } else {
    const compatDoc = { schema: EVAL_CASES_SCHEMA, cases: doc.cases };
    issues.push(...collectEvalCaseIssues(compatDoc));
  }

  if (isRetro) {
    if (doc.version !== 1) {
      issues.push(`expected version 1, got ${String(doc.version)}`);
    }
    if (!VALID_DATASET_SPLITS.includes(doc.split)) {
      issues.push(`invalid dataset split ${String(doc.split)}`);
    }
    if (typeof doc.splitSalt !== "string" || doc.splitSalt.trim() === "") {
      issues.push("missing non-empty splitSalt");
    }
    for (const [index, entry] of doc.cases.entries()) {
      const label = entry?.id ? `case ${entry.id}` : `cases[${index}]`;
      if (!entry || typeof entry !== "object") continue;
      if (!VALID_ORIGINS.includes(entry.origin)) {
        issues.push(`${label}: invalid origin ${String(entry.origin)}`);
      }
      if (!VALID_SPLITS.includes(entry.split)) {
        issues.push(`${label}: invalid split ${String(entry.split)}`);
      } else if (doc.split !== "all" && entry.split !== doc.split) {
        issues.push(`${label}: case split ${entry.split} does not match dataset split ${doc.split}`);
      }
      if (!Number.isSafeInteger(entry.diffLines) || entry.diffLines < 0) {
        issues.push(`${label}: diffLines must be a non-negative integer`);
      } else {
        const expectedBucket = classifyDiffSizeBucket(entry.diffLines);
        if (entry.diffSizeBucket !== expectedBucket) {
          issues.push(
            `${label}: diffSizeBucket ${String(entry.diffSizeBucket)} mismatches diffLines ${entry.diffLines}`,
          );
        }
      }
      if (!VALID_DIFF_SIZE_BUCKETS.includes(entry.diffSizeBucket)) {
        issues.push(`${label}: invalid diffSizeBucket ${String(entry.diffSizeBucket)}`);
      }
      issues.push(...collectReplayRefIssues(entry.replayRef, label));
      if (entry.metadata?.findingLabels !== undefined) {
        if (
          !Array.isArray(entry.metadata.findingLabels) ||
          entry.metadata.findingLabels.some((lbl) => !reviewFindingLabels.includes(lbl))
        ) {
          issues.push(`${label}: metadata.findingLabels contains unknown ReviewFindingLabel`);
        }
      }
    }
  }

  const leakScan = findRetroPrivateLeakage(doc, options);
  if (!leakScan.ok) {
    for (const hit of leakScan.hits) {
      issues.push(`private leakage (${hit.rule}): ${hit.match}`);
    }
  }

  return issues;
}

/** Build deterministic summary counts for a list of retro cases. */
export function summarizeRetroCases(cases) {
  const byOrigin = Object.fromEntries(VALID_ORIGINS.map((origin) => [origin, 0]));
  const byBucket = Object.fromEntries(VALID_BUCKETS.map((bucket) => [bucket, 0]));
  const byDiffSizeBucket = Object.fromEntries(VALID_DIFF_SIZE_BUCKETS.map((size) => [size, 0]));

  for (const item of cases) {
    if (item.origin in byOrigin) byOrigin[item.origin] += 1;
    if (item.bucket in byBucket) byBucket[item.bucket] += 1;
    if (item.diffSizeBucket in byDiffSizeBucket) byDiffSizeBucket[item.diffSizeBucket] += 1;
  }

  return {
    total: cases.length,
    byOrigin,
    byBucket,
    byDiffSizeBucket,
  };
}

/**
 * Verify holdout append-only immutability: every previously frozen holdout `caseId` must remain
 * present and byte-for-byte identical in `nextHoldoutDoc`.
 */
export function collectHoldoutImmutabilityIssues(existingHoldoutDoc, nextHoldoutDoc) {
  const issues = [];
  if (!existingHoldoutDoc) return issues;
  const existingCases = Array.isArray(existingHoldoutDoc.cases) ? existingHoldoutDoc.cases : [];
  const nextCases = Array.isArray(nextHoldoutDoc?.cases) ? nextHoldoutDoc.cases : [];
  const nextById = new Map(nextCases.map((entry) => [entry.id, entry]));

  for (const oldCase of existingCases) {
    const nextCase = nextById.get(oldCase.id);
    if (!nextCase) {
      issues.push(`holdout case deleted: ${oldCase.id}`);
      continue;
    }
    if (JSON.stringify(oldCase) !== JSON.stringify(nextCase)) {
      issues.push(`holdout case modified: ${oldCase.id}`);
    }
  }
  return issues;
}

/** Validate a `retro-eval-report/v1` document including four-state conservation and funnel invariants. */
export function collectRetroEvalReportIssues(report) {
  const issues = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["report must be a JSON object"];
  }
  if (report.schema !== RETRO_EVAL_REPORT_SCHEMA) {
    issues.push(`expected schema ${RETRO_EVAL_REPORT_SCHEMA}, got ${String(report.schema)}`);
  }
  if (report.version !== 1) {
    issues.push(`expected version 1, got ${String(report.version)}`);
  }
  if (!VALID_EVAL_MODES.includes(report.mode)) {
    issues.push(`invalid eval mode ${String(report.mode)}`);
  }
  if (!VALID_REPLAY_MODES.includes(report.replayMode)) {
    issues.push(`invalid replayMode ${String(report.replayMode)}`);
  }
  if (!Number.isSafeInteger(report.totalCases) || report.totalCases < 0) {
    issues.push(`totalCases must be a non-negative safe integer (got ${String(report.totalCases)})`);
  } else {
    try {
      verifyFourStateCounts(report.counts, report.totalCases, "report.counts");
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  const prov = report.provenance;
  if (!prov || typeof prov !== "object") {
    issues.push("missing provenance object");
  } else {
    for (const field of ["originMainSha", "targetCommitSha", "harnessClosureSha256", "casesSha256"]) {
      if (typeof prov[field] !== "string" || prov[field].trim() === "") {
        issues.push(`provenance.${field} must be a non-empty string`);
      }
    }
  }

  if (!report.funnel || typeof report.funnel !== "object") {
    issues.push("missing funnel object");
  } else {
    for (const stage of VALID_FUNNEL_STAGES) {
      const stageEntry = report.funnel[stage];
      if (!stageEntry || typeof stageEntry !== "object") {
        issues.push(`funnel.${stage} is required`);
        continue;
      }
      if (Number.isSafeInteger(report.totalCases) && report.totalCases >= 0) {
        try {
          verifyFourStateCounts(stageEntry.counts, report.totalCases, `funnel.${stage}`);
        } catch (error) {
          issues.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  if (!Array.isArray(report.outcomes)) {
    issues.push("outcomes must be an array");
  } else if (Number.isSafeInteger(report.totalCases) && report.outcomes.length !== report.totalCases) {
    issues.push(`outcomes length (${report.outcomes.length}) !== totalCases (${report.totalCases})`);
  }

  return issues;
}

function collectGateSelfTestSpecIssues(spec, label) {
  const issues = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return [`${label}: gateSelfTestSpec is required for deterministic-gate proposals`];
  }
  if (typeof spec.command !== "string" || !spec.command.includes("--self-test")) {
    issues.push(`${label}: gateSelfTestSpec.command must include --self-test`);
  }
  if (!Array.isArray(spec.positiveFixtures) || spec.positiveFixtures.length === 0) {
    issues.push(`${label}: gateSelfTestSpec.positiveFixtures must be a non-empty array`);
  }
  if (!Array.isArray(spec.negativeFixtures) || spec.negativeFixtures.length === 0) {
    issues.push(`${label}: gateSelfTestSpec.negativeFixtures must be a non-empty array`);
  }
  if (!Number.isSafeInteger(spec.hitCount) || spec.hitCount < 0) {
    issues.push(`${label}: gateSelfTestSpec.hitCount must be a non-negative integer`);
  }
  return issues;
}

function collectDistillFalsificationIssues(falsification, label) {
  const issues = [];
  if (!falsification || typeof falsification !== "object" || Array.isArray(falsification)) {
    return [`${label}: missing falsification object`];
  }
  if (!Array.isArray(falsification.agents) || falsification.agents.length !== 3) {
    issues.push(`${label}: falsification.agents must contain exactly 3 agent reviews`);
  }
  if (!Number.isSafeInteger(falsification.falsePositiveDelta)) {
    issues.push(`${label}: falsification.falsePositiveDelta must be a safe integer`);
  }
  if (!VALID_FALSIFICATION_VERDICTS.includes(falsification.verdict)) {
    issues.push(`${label}: invalid falsification.verdict ${String(falsification.verdict)}`);
  }
  return issues;
}

function collectSingleDistillProposalIssues(entry, index) {
  const issues = [];
  const label = entry?.proposalId ? `proposal ${entry.proposalId}` : `proposals[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return [`${label}: must be an object`];
  }
  if (typeof entry.proposalId !== "string" || entry.proposalId.trim() === "") {
    issues.push(`${label}: missing proposalId`);
  }
  if (typeof entry.clusterKey !== "string" || entry.clusterKey.trim() === "") {
    issues.push(`${label}: missing clusterKey`);
  }
  if (!Array.isArray(entry.taskIds) || new Set(entry.taskIds.filter(Boolean)).size < DISTILL_MIN_CLUSTER_TASKS) {
    issues.push(`${label}: requires at least ${DISTILL_MIN_CLUSTER_TASKS} distinct taskIds`);
  }
  if (!VALID_DISTILL_TARGETS.includes(entry.target)) {
    issues.push(`${label}: invalid target ${String(entry.target)}`);
  }
  if (!VALID_DISTILL_PROPOSAL_STATUSES.includes(entry.status)) {
    issues.push(`${label}: invalid status ${String(entry.status)}`);
  }

  // L6 four elements: target, scope, invariant, verification
  if (!entry.scope || typeof entry.scope !== "object" || !Array.isArray(entry.scope.modules)) {
    issues.push(`${label}: missing L6 scope.modules array`);
  }
  if (typeof entry.invariant !== "string" || entry.invariant.trim() === "") {
    issues.push(`${label}: missing L6 invariant statement`);
  }
  if (!entry.verification || typeof entry.verification !== "object") {
    issues.push(`${label}: missing L6 verification object`);
  }

  const probe = entry.probe;
  if (!probe || typeof probe !== "object") {
    issues.push(`${label}: missing probe object`);
  } else {
    if (probe.trials !== DISTILL_PROBE_TRIALS) {
      issues.push(`${label}: probe.trials must equal ${DISTILL_PROBE_TRIALS}`);
    }
    if (!Number.isSafeInteger(probe.hits) || probe.hits < 0 || probe.hits > DISTILL_PROBE_TRIALS) {
      issues.push(`${label}: probe.hits must be an integer between 0 and ${DISTILL_PROBE_TRIALS}`);
    } else if (probe.hits < DISTILL_SEMANTIC_MIN_HITS) {
      if (entry.target !== "deterministic-gate") {
        issues.push(`${label}: probe.hits=${probe.hits}/${DISTILL_PROBE_TRIALS} must route to deterministic-gate`);
      }
      if (entry.ruleDraft !== null && entry.ruleDraft !== undefined) {
        issues.push(`${label}: probe.hits=${probe.hits}/${DISTILL_PROBE_TRIALS} must not emit a semantic ruleDraft`);
      }
    }
  }

  if (entry.target === "deterministic-gate") {
    issues.push(...collectGateSelfTestSpecIssues(entry.gateSelfTestSpec, label));
    if (entry.status === "approved_for_pr" && (entry.gateSelfTestSpec?.hitCount ?? 0) <= 0) {
      issues.push(`${label}: approved deterministic-gate requires gateSelfTestSpec.hitCount > 0`);
    }
  } else if (entry.target === "semantic-rule") {
    if (!entry.ruleDraft || typeof entry.ruleDraft !== "object" || typeof entry.ruleDraft.ruleText !== "string") {
      issues.push(`${label}: semantic-rule requires ruleDraft.ruleText`);
    }
  }

  issues.push(...collectDistillFalsificationIssues(entry.falsification, label));
  if (
    entry.status === "approved_for_pr" &&
    (entry.falsification?.falsePositiveDelta > 0 || entry.falsification?.verdict !== "pass")
  ) {
    issues.push(`${label}: cannot be approved_for_pr when falsification rejects or falsePositiveDelta > 0`);
  }

  return issues;
}

/** Validate a `retro-distill-proposal/v1` document including L6 four-element & probe-routing invariants. */
export function collectRetroDistillProposalIssues(doc, options = {}) {
  const issues = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return ["distill proposal must be a JSON object"];
  }
  if (doc.schema !== RETRO_DISTILL_PROPOSAL_SCHEMA) {
    issues.push(`expected schema ${RETRO_DISTILL_PROPOSAL_SCHEMA}, got ${String(doc.schema)}`);
  }
  if (doc.version !== 1) {
    issues.push(`expected version 1, got ${String(doc.version)}`);
  }
  if (typeof doc.runId !== "string" || doc.runId.trim() === "") {
    issues.push("missing non-empty runId");
  }
  if (!Array.isArray(doc.proposals)) {
    issues.push("proposals must be an array");
  } else {
    for (const [index, entry] of doc.proposals.entries()) {
      issues.push(...collectSingleDistillProposalIssues(entry, index));
    }
  }
  if (!Array.isArray(doc.rejectedClusters)) {
    issues.push("rejectedClusters must be an array");
  }

  const leakScan = findRetroPrivateLeakage(doc, options);
  if (!leakScan.ok) {
    for (const hit of leakScan.hits) {
      issues.push(`private leakage (${hit.rule}): ${hit.match}`);
    }
  }

  return issues;
}

function collectHotFilesIssues(hotFiles, label) {
  const issues = [];
  if (!Array.isArray(hotFiles)) {
    return [`${label} must be an array`];
  }
  if (hotFiles.length > 20) {
    issues.push(`${label} must contain at most 20 entries (got ${hotFiles.length})`);
  }
  for (const [index, item] of hotFiles.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push(`${label}[${index}] must be an object`);
      continue;
    }
    if (typeof item.path !== "string" || item.path.trim() === "") {
      issues.push(`${label}[${index}].path must be a non-empty string`);
    }
    if (!Number.isSafeInteger(item.touchCount) || item.touchCount < 1) {
      issues.push(`${label}[${index}].touchCount must be a positive integer`);
    }
  }
  return issues;
}

function collectDurationMetricIssue(value, label) {
  if (value === null) return [];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return [`${label} must be null or a non-negative finite number`];
  }
  return [];
}

function collectRateMetricIssue(value, label) {
  if (value === null) return [];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return [`${label} must be null or a finite number in [0, 1]`];
  }
  return [];
}

/** Validate a `retro-baselines/v1` snapshot document including strict zero-private-leakage enforcement. */
export function collectRetroBaselinesIssues(doc, options = {}) {
  const issues = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return ["baselines document must be a JSON object"];
  }
  if (doc.schema !== RETRO_BASELINES_SCHEMA) {
    issues.push(`expected schema ${RETRO_BASELINES_SCHEMA}, got ${String(doc.schema)}`);
  }
  if (doc.version !== 1) {
    issues.push(`expected version 1, got ${String(doc.version)}`);
  }
  if (typeof doc.generatedAt !== "string" || doc.generatedAt.trim() === "") {
    issues.push("missing non-empty generatedAt");
  }
  if (!Number.isSafeInteger(doc.windowDays) || doc.windowDays <= 0) {
    issues.push(`windowDays must be a positive integer (got ${String(doc.windowDays)})`);
  }
  const metrics = doc.metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    issues.push("missing metrics object");
  } else {
    for (const field of ["sampleSize", "completedCount", "reworkedCount"]) {
      if (!Number.isSafeInteger(metrics[field]) || metrics[field] < 0) {
        issues.push(`metrics.${field} must be a non-negative integer`);
      }
    }
    issues.push(...collectDurationMetricIssue(metrics.p50DurationMs, "metrics.p50DurationMs"));
    issues.push(...collectDurationMetricIssue(metrics.p90DurationMs, "metrics.p90DurationMs"));
    issues.push(...collectRateMetricIssue(metrics.reworkRate, "metrics.reworkRate"));
  }
  issues.push(...collectHotFilesIssues(doc.topHotFiles, "topHotFiles"));

  const leakScan = findRetroPrivateLeakage(doc, options);
  if (!leakScan.ok) {
    for (const hit of leakScan.hits) {
      issues.push(`private leakage (${hit.rule}): ${hit.match}`);
    }
  }
  return issues;
}

/** Validate a `retro-audit-report/v1` offline governance audit report. */
export function collectRetroAuditReportIssues(report) {
  const issues = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["audit report must be a JSON object"];
  }
  if (report.schema !== RETRO_AUDIT_REPORT_SCHEMA) {
    issues.push(`expected schema ${RETRO_AUDIT_REPORT_SCHEMA}, got ${String(report.schema)}`);
  }
  if (report.version !== 1) {
    issues.push(`expected version 1, got ${String(report.version)}`);
  }
  if (typeof report.generatedAt !== "string" || report.generatedAt.trim() === "") {
    issues.push("missing non-empty generatedAt");
  }
  if (typeof report.strict !== "boolean") {
    issues.push("strict must be a boolean");
  }

  const summary = report.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    issues.push("missing summary object");
  } else {
    for (const field of [
      "expiredQuarantineCount",
      "closedOwnerQuarantineCount",
      "unreachedAllowlistCount",
      "unobservableAllowlistCount",
      "nullWaiverCount",
      "hollowDecisionCount",
      "contagiousFactCount",
      "strictViolations",
    ]) {
      if (!Number.isSafeInteger(summary[field]) || summary[field] < 0) {
        issues.push(`summary.${field} must be a non-negative integer`);
      }
    }
  }

  const baselines = report.taskBaselines;
  if (!baselines || typeof baselines !== "object" || Array.isArray(baselines)) {
    issues.push("missing taskBaselines object");
  } else {
    if (!Number.isSafeInteger(baselines.sampleSize) || baselines.sampleSize < 0) {
      issues.push("taskBaselines.sampleSize must be a non-negative integer");
    }
    issues.push(...collectDurationMetricIssue(baselines.p50DurationMs, "taskBaselines.p50DurationMs"));
    issues.push(...collectDurationMetricIssue(baselines.p90DurationMs, "taskBaselines.p90DurationMs"));
    issues.push(...collectRateMetricIssue(baselines.reworkRate, "taskBaselines.reworkRate"));
    issues.push(...collectHotFilesIssues(baselines.topHotFiles, "taskBaselines.topHotFiles"));
  }

  if (
    !report.quarantineAudit ||
    !Array.isArray(report.quarantineAudit.expired) ||
    !Array.isArray(report.quarantineAudit.closedOwnerTasks)
  ) {
    issues.push("quarantineAudit must contain expired and closedOwnerTasks arrays");
  }
  if (
    !report.unreachedAllowlists ||
    !Array.isArray(report.unreachedAllowlists.unreached) ||
    !Array.isArray(report.unreachedAllowlists.unobservable)
  ) {
    issues.push("unreachedAllowlists must contain unreached and unobservable arrays");
  }
  if (
    !report.waiverExposure ||
    !Array.isArray(report.waiverExposure.nullWaivers) ||
    !Array.isArray(report.waiverExposure.disputeDrafts)
  ) {
    issues.push("waiverExposure must contain nullWaivers and disputeDrafts arrays");
  }
  if (!report.decisionWhyNotAudit || !Array.isArray(report.decisionWhyNotAudit.hollowDecisions)) {
    issues.push("decisionWhyNotAudit must contain hollowDecisions array");
  }
  if (!report.factContagionFlags || !Array.isArray(report.factContagionFlags.flags)) {
    issues.push("factContagionFlags must contain flags array");
  }

  return issues;
}

/** Validate a `retro-prune-plan/v1` read-only retirement proposal document. */
export function collectRetroPrunePlanIssues(plan) {
  const issues = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return ["prune plan must be a JSON object"];
  }
  if (plan.schema !== RETRO_PRUNE_PLAN_SCHEMA) {
    issues.push(`expected schema ${RETRO_PRUNE_PLAN_SCHEMA}, got ${String(plan.schema)}`);
  }
  if (plan.version !== 1) {
    issues.push(`expected version 1, got ${String(plan.version)}`);
  }
  if (typeof plan.generatedAt !== "string" || plan.generatedAt.trim() === "") {
    issues.push("missing non-empty generatedAt");
  }
  if (plan.readOnly !== true) {
    issues.push("prune plan must explicitly assert readOnly: true");
  }
  if (!plan.sources || typeof plan.sources !== "object" || Array.isArray(plan.sources)) {
    issues.push("missing sources object");
  } else if (!Number.isSafeInteger(plan.sources.evalReportCount) || plan.sources.evalReportCount < 0) {
    issues.push("sources.evalReportCount must be a non-negative integer");
  }
  if (!plan.summary || typeof plan.summary !== "object" || Array.isArray(plan.summary)) {
    issues.push("missing summary object");
  } else if (!Number.isSafeInteger(plan.summary.totalProposals) || plan.summary.totalProposals < 0) {
    issues.push("summary.totalProposals must be a non-negative integer");
  }
  if (!Array.isArray(plan.proposals)) {
    issues.push("proposals must be an array");
  } else {
    if (plan.summary && plan.summary.totalProposals !== plan.proposals.length) {
      issues.push(
        `summary.totalProposals (${plan.summary.totalProposals}) !== proposals.length (${plan.proposals.length})`,
      );
    }
    for (const [index, entry] of plan.proposals.entries()) {
      const label = entry?.proposalId ? `proposal ${entry.proposalId}` : `proposals[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        issues.push(`${label}: must be an object`);
        continue;
      }
      if (typeof entry.proposalId !== "string" || entry.proposalId.trim() === "") {
        issues.push(`${label}: missing proposalId`);
      }
      if (!VALID_PRUNE_ACTIONS.includes(entry.action)) {
        issues.push(`${label}: invalid action ${String(entry.action)}`);
      }
      if (!VALID_PRUNE_PRIORITIES.includes(entry.priority)) {
        issues.push(`${label}: invalid priority ${String(entry.priority)}`);
      }
      if (typeof entry.target !== "string" || entry.target.trim() === "") {
        issues.push(`${label}: missing target`);
      }
      if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
        issues.push(`${label}: missing reason`);
      }
    }
  }
  return issues;
}
