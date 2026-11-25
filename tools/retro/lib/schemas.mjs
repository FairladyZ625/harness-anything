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
export const VALID_EVAL_MODES = Object.freeze(["dry-run", "input", "live"]);
export const VALID_REPLAY_MODES = Object.freeze(["diff-only", "tree-snapshot"]);
export const VALID_FUNNEL_STAGES = Object.freeze(["raw", "postVerification", "finalVerdict"]);
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
