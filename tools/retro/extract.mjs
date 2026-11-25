import { hash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { GIT_HISTORY_FORMAT, parseGitHistory } from "@harness-anything/application/internal/queries/file-trace-read.ts";
import { makeTaskProjectionReader } from "@harness-anything/storage/projection";
import { loadEvalCases } from "../evals/closeout-reviewer/run-eval.mjs";
import {
  SanitizeError,
  findRetroPrivateLeakage,
  rejectPrivateLeakage,
  sanitizeRetroCase,
  sanitizeText,
} from "./lib/sanitize.mjs";
import {
  NON_BLOCKING_ONLY_CATEGORIES,
  RETRO_CASES_SCHEMA,
  VALID_DIFF_SIZE_BUCKETS,
  classifyDiffSizeBucket,
  collectHoldoutImmutabilityIssues,
  collectRetroCaseIssues,
  countEffectiveDiffLines,
  reviewFindingCategories,
  reviewFindingLabels,
  summarizeRetroCases,
  unifiedDiffIssue,
} from "./lib/schemas.mjs";

const EXIT_OK = 0;
const EXIT_GATE_FAILURE = 1;
const EXIT_INVALID_INPUT = 2;
const EXIT_BUDGET_EXCEEDED = 3;

const DEFAULT_RISK_TIER = "medium";
const DEFAULT_SPLIT_SALT = "retro-v1";
const DEFAULT_HOLDOUT_RATIO = 0.4;
const DEFAULT_SINCE_DAYS = 60;
const DEFAULT_MAX_POSITIVES = 32;
const DEFAULT_MAX_TASKS_SCAN = 400;
const MAX_DIFF_BYTES_PER_CASE = 16 * 1024;
const MAX_DIFF_FILES_PER_CASE = 6;
const SHA40_PATTERN = /^[0-9a-f]{40}$/u;
const NON_REWORK_BLOCKING_SET = new Set([...NON_BLOCKING_ONLY_CATEGORIES, "ci-required"]);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "tools", "retro", "datasets");
const DEFAULT_SOURCE_MAP = path.join(REPO_ROOT, ".retro-local", "source-map.json");
const DEFAULT_SEEDS_PATH = path.join(REPO_ROOT, "tools", "evals", "closeout-reviewer", "cases.json");

const SAFE_DIFF_FILE_HEADER = /^diff --git a\/([\w./-]+) b\/\1$/u;
const FORBIDDEN_DIFF_PATH_PREFIXES = [".harness/", ".harness-private/", "harness/", ".retro-local/", ".worktrees/"];
const SKIPPED_DIFF_BASENAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const STOP_WORDS = new Set(
  "the and for with that this from into when where must should have has had not are was were been being does did can could will would only also but its our their than then without after before under over about redacted task local path private".split(
    " ",
  ),
);

class ExtractError extends Error {
  constructor(message, exitCode, code = "extract_error") {
    super(message);
    this.name = "ExtractError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

function persistUtf8FileSync(targetPath, content) {
  const fd = openSync(targetPath, "w");
  try {
    writeSync(fd, content, undefined, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Deterministic 60/40 (or configurable) split assignment keyed on `sha256(caseId + ":" + splitSalt)`. */
export function assignDeterministicSplit(caseId, splitSalt = DEFAULT_SPLIT_SALT, holdoutRatio = DEFAULT_HOLDOUT_RATIO) {
  const digest = hash("sha256", `${caseId}:${splitSalt}`, "buffer");
  return digest.readUInt32BE(0) / 0x100000000 < holdoutRatio ? "holdout" : "tuning";
}

function shortOpaqueHash(input) {
  return hash("sha256", input, "hex").slice(0, 12);
}

function runGit(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    input: options.input,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

function resolveCanonicalGitRoot(repoRoot) {
  const common = runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (!common.ok || !common.stdout.trim()) return path.resolve(repoRoot);
  const commonDir = path.resolve(repoRoot, common.stdout.trim());
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : path.resolve(repoRoot);
}

function batchCheckReachableCommits(gitRoot, shas) {
  const unique = [...new Set(shas.filter((sha) => typeof sha === "string" && SHA40_PATTERN.test(sha)))];
  const reachable = new Set();
  if (unique.length === 0) return reachable;
  const res = runGit(gitRoot, ["cat-file", "--batch-check"], { input: `${unique.join("\n")}\n` });
  if (!res.ok) return reachable;
  for (const line of res.stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.endsWith(" missing")) continue;
    const [sha, type] = trimmed.split(/\s+/u);
    if (sha && type === "commit") reachable.add(sha.toLowerCase());
  }
  return reachable;
}

function resolveParentCommit(gitRoot, sha) {
  const res = runGit(gitRoot, ["rev-parse", "--verify", "--quiet", `${sha}^`]);
  const parent = res.stdout.trim().toLowerCase();
  return res.ok && SHA40_PATTERN.test(parent) ? parent : null;
}

function resolveBaselineSha(gitRoot, execution, headSha, reachable) {
  const baseline =
    execution?.deliveryBaseline?.kind === "commit" ? execution.deliveryBaseline.commitSha.toLowerCase() : null;
  return baseline && reachable.has(baseline) ? baseline : resolveParentCommit(gitRoot, headSha);
}

/**
 * Filter and normalize a raw unified diff into a text-only, leak-free unified diff that passes
 * `unifiedDiffIssue` and respects per-case size bounds without corrupting hunk counts.
 */
export function normalizeUnifiedDiff(rawDiff, options = {}) {
  if (typeof rawDiff !== "string" || rawDiff.trim() === "") return null;
  const maxBytes = options.maxBytes ?? MAX_DIFF_BYTES_PER_CASE;
  const maxFiles = options.maxFiles ?? MAX_DIFF_FILES_PER_CASE;

  const rawSections = [];
  let current = null;
  for (const line of rawDiff.replace(/\r\n/gu, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) rawSections.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) rawSections.push(current);

  const keptSections = [];
  const keptFiles = [];
  let totalBytes = 0;

  for (const sectionLines of rawSections) {
    if (keptSections.length >= maxFiles) break;
    const fileMatch = SAFE_DIFF_FILE_HEADER.exec(sectionLines[0] ?? "");
    if (!fileMatch) continue;
    const filePath = fileMatch[1];
    if (
      FORBIDDEN_DIFF_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix)) ||
      SKIPPED_DIFF_BASENAMES.has(path.posix.basename(filePath)) ||
      sectionLines.some(
        (line) => line.startsWith("Binary files ") || line === "GIT binary patch" || line.startsWith("rename from "),
      )
    ) {
      continue;
    }

    const cleaned = sectionLines.filter(
      (line) =>
        !line.startsWith("old mode ") && !line.startsWith("new mode ") && line !== "\\ No newline at end of file",
    );
    while (cleaned.length > 0 && cleaned.at(-1) === "") cleaned.pop();
    const sectionText = `${cleaned.join("\n")}\n`;
    if (unifiedDiffIssue(sectionText) !== null || !findRetroPrivateLeakage(sectionText).ok) continue;

    const sectionBytes = Buffer.byteLength(sectionText, "utf8");
    if (keptSections.length > 0 && totalBytes + sectionBytes > maxBytes) continue;
    if (keptSections.length === 0 && sectionBytes > maxBytes * 2) continue;

    keptSections.push(sectionText);
    keptFiles.push(filePath);
    totalBytes += sectionBytes;
  }

  if (keptSections.length === 0) return null;
  const diff = keptSections.join("");
  if (unifiedDiffIssue(diff) !== null) return null;
  const diffLines = countEffectiveDiffLines(diff);
  return diffLines > 0 ? { diff, diffLines, files: keptFiles } : null;
}

function extractGitCommitDiff(gitRoot, baseSha, headSha) {
  const res = runGit(gitRoot, [
    "diff",
    "--no-renames",
    "--no-ext-diff",
    "--unified=3",
    baseSha,
    headSha,
    "--",
    ".",
    ":(exclude)package-lock.json",
  ]);
  return res.ok ? normalizeUnifiedDiff(res.stdout) : null;
}

function extractDistinctTokens(text, limit = 8) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const seen = new Set();
  const tokens = [];
  for (const raw of sanitizeText(text).match(/[\p{L}\p{N}_-]{3,}/gu) ?? []) {
    const token = raw.replace(/^[_-]+|[_-]+$/gu, "");
    const lower = token.toLowerCase();
    if (token.length < 3 || /^\d+$/u.test(token) || STOP_WORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    tokens.push(token);
    if (tokens.length >= limit) break;
  }
  return tokens;
}

function fileEvidencePhrases(files) {
  const phrases = [];
  const seen = new Set();
  for (const file of files) {
    const base = path.posix.basename(file);
    const stem = base.replace(/\.[^.]+$/u, "");
    for (const candidate of [stem, base]) {
      const key = candidate.toLowerCase();
      if (candidate.length >= 2 && !seen.has(key)) {
        seen.add(key);
        phrases.push(candidate);
      }
    }
    if (phrases.length >= 6) break;
  }
  return phrases;
}

function buildPositiveEvidenceGroups({ files, anchorText, primaryText, fallbackTerms }) {
  const group1 = [...fileEvidencePhrases(files), ...extractDistinctTokens(anchorText, 4)].slice(0, 6);
  const tokens = extractDistinctTokens(primaryText, 12);
  const fallback = [...fallbackTerms, "regression", "defect", "behavior", "contract", "validation"];
  const ensure = (arr, offset) => {
    const unique = [...new Set(arr.filter((item) => typeof item === "string" && /[\p{L}\p{N}]/u.test(item)))];
    return unique.length > 0
      ? unique.slice(0, 6)
      : [fallback[offset % fallback.length], fallback[(offset + 1) % fallback.length]];
  };
  return [ensure(group1, 0), ensure(tokens.slice(0, 5), 2), ensure(tokens.slice(5, 10), 4)];
}

function resolveSinceIso(sinceOption, now = new Date()) {
  if (!sinceOption) return new Date(now.getTime() - DEFAULT_SINCE_DAYS * 86_400_000).toISOString();
  const dayMatch = /^(\d+)d$/u.exec(String(sinceOption).trim());
  if (dayMatch) {
    const days = Number(dayMatch[1]);
    if (!Number.isSafeInteger(days) || days <= 0) {
      throw new ExtractError(`Invalid --since value: ${sinceOption}`, EXIT_INVALID_INPUT, "invalid_since");
    }
    return new Date(now.getTime() - days * 86_400_000).toISOString();
  }
  const parsed = Date.parse(String(sinceOption));
  if (!Number.isFinite(parsed)) {
    throw new ExtractError(`Invalid --since timestamp: ${sinceOption}`, EXIT_INVALID_INPUT, "invalid_since");
  }
  return new Date(parsed).toISOString();
}

function readJsonQuiet(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function discoverRemoteEdgeProjectionPath(canonicalRoot) {
  const userRoot = process.env.HARNESS_DAEMON_USER_ROOT || path.join(os.homedir(), ".harness");
  const registry = readJsonQuiet(path.join(userRoot, "registry.json"));
  const normalizedTarget = path.resolve(canonicalRoot).toLowerCase();
  const repo = (registry?.repos ?? []).find(
    (entry) =>
      typeof entry?.canonicalRoot === "string" &&
      path.resolve(entry.canonicalRoot).toLowerCase() === normalizedTarget &&
      entry.mode === "remote-edge",
  );
  if (!repo?.repoId) return null;
  // Read only structural locator fields (viewRoot, nodeId); never access credentials.
  const edgeCfg = readJsonQuiet(path.join(userRoot, "fleet", "edge", repo.repoId, "fleet-edge.json"));
  if (typeof edgeCfg?.viewRoot !== "string" || typeof edgeCfg?.nodeId !== "string") return null;
  const viewDir = path.join(edgeCfg.viewRoot, "repos", repo.repoId, "views", edgeCfg.nodeId);
  const current = readJsonQuiet(path.join(viewDir, "current.json"));
  if (typeof current?.id !== "string" || current.id.trim() === "") return null;
  const candidate = path.join(viewDir, "generations", current.id, ".harness", "cache", "task.sqlite");
  return existsSync(candidate) ? candidate : null;
}

function resolveProjectionPath(canonicalRoot, explicitProjectionPath) {
  if (explicitProjectionPath) {
    const resolved = path.resolve(explicitProjectionPath);
    if (!existsSync(resolved)) {
      throw new ExtractError(`Projection file not found: ${resolved}`, EXIT_INVALID_INPUT, "projection_not_found");
    }
    return resolved;
  }
  const localPath = path.join(canonicalRoot, ".harness", "cache", "task.sqlite");
  if (existsSync(localPath)) {
    const reader = makeTaskProjectionReader({ rootDir: canonicalRoot, projectionPath: localPath });
    try {
      if (reader.withSession((queries) => queries.readCut().watermark) > 0) return localPath;
    } catch {
      // Fall through to remote-edge replica discovery.
    } finally {
      reader.close();
    }
  }
  return discoverRemoteEdgeProjectionPath(canonicalRoot);
}

function readTasksFromProjection(projectionPath, canonicalRoot, sinceIso, maxTasksScan, checkBudget) {
  const reader = makeTaskProjectionReader({ rootDir: canonicalRoot, projectionPath });
  const records = [];
  let watermark = 0;
  try {
    reader.withSession((queries) => {
      watermark = queries.readCut().watermark;
      const taskIds = [];
      let cursor;
      while (taskIds.length < maxTasksScan && !checkBudget()) {
        const page = queries.readTaskIndex({
          updatedAfter: sinceIso,
          limit: Math.min(200, maxTasksScan - taskIds.length),
          ...(cursor ? { cursor } : {}),
        });
        for (const row of page.rows) {
          if (row.taskClass === "work") continue;
          taskIds.push(row.taskId);
          if (taskIds.length >= maxTasksScan) break;
        }
        if (!page.page?.nextCursor) break;
        cursor = page.page.nextCursor;
      }

      taskIds.sort((a, b) => a.localeCompare(b, "en"));
      for (const taskId of taskIds) {
        if (checkBudget()) break;
        const snap = queries.read(taskId, false, false).snapshot;
        if (!snap?.task) continue;
        records.push({
          taskId,
          title: snap.task.title,
          status: snap.task.status,
          workKind: snap.task.metadata?.workKind ?? "fix",
          riskTier: snap.task.metadata?.riskTier ?? "medium",
          executions: snap.executions ?? [],
          reviews: snap.reviews ?? [],
          reviewDispositions: snap.reviewDispositions ?? [],
        });
      }
    });
  } finally {
    reader.close();
  }
  return { records, watermark };
}

function extractRevertCandidatesFromGit(gitRoot, sinceIso, checkBudget) {
  const log = runGit(gitRoot, [
    "log",
    `--since=${sinceIso}`,
    "--grep=^Revert",
    `--format=${GIT_HISTORY_FORMAT}`,
    "--name-only",
    "-n",
    "50",
  ]);
  if (!log.ok || !log.stdout.trim()) return { reverts: [], revertedCommitShas: new Set() };
  const reverts = [];
  const revertedCommitShas = new Set();

  for (const commit of parseGitHistory(log.stdout)) {
    if (checkBudget()) break;
    const msg = runGit(gitRoot, ["show", "-s", "--format=%B", commit.commitSha]);
    if (!msg.ok) continue;
    const revertMatch = /This reverts commit ([0-9a-f]{40})/iu.exec(msg.stdout);
    if (!revertMatch) continue;
    const revertedSha = revertMatch[1].toLowerCase();
    revertedCommitShas.add(revertedSha);
    reverts.push({
      revertCommitSha: commit.commitSha,
      revertedSha,
      subject: commit.subject,
      taskId: commit.taskId,
      prNumber: commit.prNumber,
    });
  }
  return { reverts, revertedCommitShas };
}

function extractGitCleanFallbackCommits(gitRoot, sinceIso, excludeShas, limit = 80) {
  const log = runGit(gitRoot, [
    "log",
    `--since=${sinceIso}`,
    "--no-merges",
    `--format=${GIT_HISTORY_FORMAT}`,
    "--name-only",
    "-n",
    String(limit),
  ]);
  if (!log.ok || !log.stdout.trim()) return [];
  return parseGitHistory(log.stdout)
    .filter((commit) => !/^Revert\b/iu.test(commit.subject) && !excludeShas.has(commit.commitSha))
    .map((commit) => ({ commitSha: commit.commitSha, subject: commit.subject, taskId: commit.taskId }));
}

function buildReviewExecutionCase(task, review, execution, diffResult, baseSha, splitSalt) {
  const blockingFindings = (review.findings ?? []).filter((finding) => finding.blocking);
  const rawCategories = [
    ...new Set(
      blockingFindings
        .map((finding) => finding.category)
        .filter((cat) => reviewFindingCategories.includes(cat) && !NON_REWORK_BLOCKING_SET.has(cat)),
    ),
  ];
  const expectedCategories = rawCategories.length > 0 ? rawCategories : ["correctness"];
  const findingLabels = [
    ...new Set(
      (review.findings ?? []).map((finding) => finding.label).filter((lbl) => reviewFindingLabels.includes(lbl)),
    ),
  ];
  const primaryText = blockingFindings.map((finding) => finding.text).join(" ") || review.reason || task.title;
  const anchorText = blockingFindings.map((finding) => finding.anchor ?? "").join(" ");
  const headSha = review.commitSha.toLowerCase();
  const caseId = `retro-rev-${shortOpaqueHash(`review-execution:${review.reviewId}:${headSha}:${splitSalt}`)}`;

  return {
    caseObj: sanitizeRetroCase({
      id: caseId,
      bucket: "positive",
      defectClass: `review-${expectedCategories[0]}`,
      title: sanitizeText(`Review rejection (${expectedCategories[0]}): ${task.title}`).slice(0, 160),
      expectedVerdict: "changes_requested",
      expectedCategories,
      expectedEvidence: buildPositiveEvidenceGroups({
        files: diffResult.files,
        anchorText,
        primaryText,
        fallbackTerms: [expectedCategories[0], "blocking", "review"],
      }),
      taskContext: {
        workKind: task.workKind ?? "fix",
        riskTier: task.riskTier ?? "medium",
        summary: sanitizeText(task.title).slice(0, 240),
      },
      diff: diffResult.diff,
      origin: "review-execution",
      split: "tuning",
      diffLines: diffResult.diffLines,
      diffSizeBucket: classifyDiffSizeBucket(diffResult.diffLines),
      replayRef: { baseSha, headSha },
      ...(findingLabels.length > 0 ? { metadata: { findingLabels } } : {}),
    }),
    sourceMapEntry: {
      origin: "review-execution",
      taskId: task.taskId,
      reviewId: review.reviewId,
      executionId: execution?.executionId ?? review.executionId ?? null,
      baseSha,
      headSha,
    },
  };
}

function buildTaskReworkCase(task, execution, diffResult, baseSha, headSha, splitSalt) {
  const caseId = `retro-rwk-${shortOpaqueHash(`task-rework:${execution.executionId}:${headSha}:${splitSalt}`)}`;
  return {
    caseObj: sanitizeRetroCase({
      id: caseId,
      bucket: "positive",
      defectClass: "task-rework",
      title: sanitizeText(`Reworked delivery cut: ${task.title}`).slice(0, 160),
      expectedVerdict: "changes_requested",
      expectedCategories: ["correctness", "completeness"],
      expectedEvidence: buildPositiveEvidenceGroups({
        files: diffResult.files,
        anchorText: diffResult.files.join(" "),
        primaryText: `${execution.submission?.completionClaim ?? ""} ${task.title}`,
        fallbackTerms: ["rework", "completeness", "correctness"],
      }),
      taskContext: {
        workKind: task.workKind ?? "fix",
        riskTier: task.riskTier ?? "medium",
        summary: sanitizeText(task.title).slice(0, 240),
      },
      diff: diffResult.diff,
      origin: "task-rework",
      split: "tuning",
      diffLines: diffResult.diffLines,
      diffSizeBucket: classifyDiffSizeBucket(diffResult.diffLines),
      replayRef: { baseSha, headSha },
    }),
    sourceMapEntry: {
      origin: "task-rework",
      taskId: task.taskId,
      executionId: execution.executionId,
      baseSha,
      headSha,
    },
  };
}

function buildGitRevertCase(revert, diffResult, baseSha, splitSalt) {
  const caseId = `retro-rvt-${shortOpaqueHash(`git-revert:${revert.revertedSha}:${splitSalt}`)}`;
  const cleanSubject = sanitizeText(revert.subject.replace(/^Revert\s+/iu, "").replace(/^["']|["']$/gu, ""));
  return {
    caseObj: sanitizeRetroCase({
      id: caseId,
      bucket: "positive",
      defectClass: "post-merge-revert",
      title: sanitizeText(`Post-merge revert: ${cleanSubject}`).slice(0, 160),
      expectedVerdict: "changes_requested",
      expectedCategories: ["correctness"],
      expectedEvidence: buildPositiveEvidenceGroups({
        files: diffResult.files,
        anchorText: diffResult.files.join(" "),
        primaryText: cleanSubject,
        fallbackTerms: ["revert", "regression", "correctness"],
      }),
      taskContext: { workKind: "fix", riskTier: DEFAULT_RISK_TIER, summary: sanitizeText(cleanSubject).slice(0, 240) },
      diff: diffResult.diff,
      origin: "git-revert",
      split: "tuning",
      diffLines: diffResult.diffLines,
      diffSizeBucket: classifyDiffSizeBucket(diffResult.diffLines),
      replayRef: { baseSha, headSha: revert.revertedSha },
      metadata: { revertCommitSha: revert.revertCommitSha },
    }),
    sourceMapEntry: {
      origin: "git-revert",
      taskId: revert.taskId ?? null,
      revertCommitSha: revert.revertCommitSha,
      baseSha,
      headSha: revert.revertedSha,
    },
  };
}

function buildCleanControlCase(control, diffResult, baseSha, headSha, matchedPositiveId, splitSalt) {
  const caseId = `retro-neg-${shortOpaqueHash(`clean-control:${headSha}:${splitSalt}`)}`;
  return {
    caseObj: sanitizeRetroCase({
      id: caseId,
      bucket: "negative",
      defectClass: "clean-change",
      title: sanitizeText(`Clean merged change: ${control.title}`).slice(0, 160),
      expectedVerdict: "approved",
      expectedCategories: [],
      taskContext: {
        workKind: control.workKind ?? "fix",
        riskTier: control.riskTier ?? "medium",
        summary: sanitizeText(control.title).slice(0, 240),
      },
      diff: diffResult.diff,
      origin: "clean-control",
      split: "tuning",
      diffLines: diffResult.diffLines,
      diffSizeBucket: classifyDiffSizeBucket(diffResult.diffLines),
      replayRef: { baseSha, headSha },
      metadata: { matchedPositiveId },
    }),
    sourceMapEntry: { origin: "clean-control", taskId: control.taskId ?? null, baseSha, headSha, matchedPositiveId },
  };
}

/** Match clean negative controls 1:1 to positive cases stratified by 4 diff size buckets (xs/s/m/l). */
export function matchNegativeControlsBySizeBucket(positives, cleanCandidates) {
  const bucketRank = Object.fromEntries(VALID_DIFF_SIZE_BUCKETS.map((bucket, idx) => [bucket, idx]));
  const available = [...cleanCandidates].sort((a, b) => a.sortKey.localeCompare(b.sortKey, "en"));
  const used = new Set();
  const pairs = [];

  for (const pos of [...positives].sort((a, b) => a.caseObj.id.localeCompare(b.caseObj.id, "en"))) {
    const targetRank = bucketRank[pos.caseObj.diffSizeBucket];
    let best = null;
    let bestScore = null;
    for (const candidate of available) {
      if (used.has(candidate.sortKey)) continue;
      const score = [
        Math.abs(bucketRank[candidate.diffSizeBucket] - targetRank),
        Math.abs(candidate.diffLines - pos.caseObj.diffLines),
        candidate.sortKey,
      ];
      if (
        bestScore === null ||
        score[0] < bestScore[0] ||
        (score[0] === bestScore[0] && score[1] < bestScore[1]) ||
        (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2].localeCompare(bestScore[2], "en") < 0)
      ) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best) {
      used.add(best.sortKey);
      pairs.push({ positive: pos, negative: best });
    }
  }
  return pairs;
}

function loadSeedCases(seedsPath) {
  const rawSeed = JSON.parse(readFileSync(seedsPath, "utf8"));
  rejectPrivateLeakage(rawSeed, seedsPath);
  return loadEvalCases(seedsPath).cases.map((entry) => {
    const diffLines = countEffectiveDiffLines(entry.diff);
    return sanitizeRetroCase({
      ...entry,
      origin: "seed",
      split: "tuning",
      diffLines,
      diffSizeBucket: classifyDiffSizeBucket(diffLines),
      replayRef: { baseSha: null, headSha: null },
    });
  });
}

/** Verify an existing retro dataset file for schema compliance and zero private leakage. */
export function verifyDatasetFile(datasetPath) {
  const resolved = path.resolve(datasetPath);
  if (!existsSync(resolved)) {
    throw new ExtractError(`Dataset file not found: ${resolved}`, EXIT_INVALID_INPUT, "dataset_not_found");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new ExtractError(
      `Invalid JSON in dataset (${resolved}): ${error instanceof Error ? error.message : String(error)}`,
      EXIT_INVALID_INPUT,
      "invalid_json",
    );
  }
  rejectPrivateLeakage(parsed, resolved);
  const issues = collectRetroCaseIssues(parsed);
  if (issues.length > 0) {
    throw new ExtractError(`Dataset validation failed (${resolved}):\n- ${issues.join("\n- ")}`, EXIT_GATE_FAILURE);
  }
  return {
    ok: true,
    exitCode: EXIT_OK,
    datasetPath: path.relative(process.cwd(), resolved).split(path.sep).join("/"),
    schema: parsed.schema,
    totalCases: parsed.cases.length,
    privateLeakHits: 0,
    summary: summarizeRetroCases(parsed.cases),
  };
}

function extractFromSnapshot(snapshot, options, checkBudget = () => false) {
  const { splitSalt, maxPositives } = options;
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const reverts = Array.isArray(snapshot.reverts) ? snapshot.reverts : [];
  const cleanControlSnapshots = Array.isArray(snapshot.cleanControls) ? snapshot.cleanControls : [];

  const positives = [];
  const cleanCandidates = [];
  const revertedShas = new Set(reverts.map((r) => r.revertedSha?.toLowerCase()).filter(Boolean));
  const usedPositiveHeads = new Set();

  // Prioritize post-merge reverts first so highest-signal escapes are never starved.
  for (const revert of reverts) {
    if (checkBudget() || positives.length >= maxPositives) break;
    const diffResult = normalizeUnifiedDiff(revert.diff);
    const revertedSha = SHA40_PATTERN.test(revert.revertedSha ?? "") ? revert.revertedSha.toLowerCase() : null;
    const revertCommitSha = SHA40_PATTERN.test(revert.revertCommitSha ?? "")
      ? revert.revertCommitSha.toLowerCase()
      : null;
    if (!diffResult || !revertedSha || !revertCommitSha) continue;
    const baseSha = SHA40_PATTERN.test(revert.baseSha ?? "") ? revert.baseSha.toLowerCase() : null;
    positives.push(buildGitRevertCase({ ...revert, revertedSha, revertCommitSha }, diffResult, baseSha, splitSalt));
    usedPositiveHeads.add(revertedSha);
  }

  for (const task of tasks) {
    const reviews = Array.isArray(task.reviews) ? task.reviews : [];
    const executions = Array.isArray(task.executions) ? task.executions : [];
    const rejectedReview = reviews.find((rev) => rev.verdict === "changes_requested" && (rev.diff || task.diff));
    if (rejectedReview && positives.length < maxPositives) {
      const diffResult = normalizeUnifiedDiff(rejectedReview.diff ?? task.diff);
      const headSha = SHA40_PATTERN.test(rejectedReview.commitSha ?? "")
        ? rejectedReview.commitSha.toLowerCase()
        : null;
      if (diffResult && headSha && !usedPositiveHeads.has(headSha)) {
        const exec = executions.find((ex) => ex.executionId === rejectedReview.executionId) ?? executions[0];
        const baseSha =
          exec?.deliveryBaseline?.kind === "commit" && SHA40_PATTERN.test(exec.deliveryBaseline.commitSha ?? "")
            ? exec.deliveryBaseline.commitSha.toLowerCase()
            : null;
        positives.push(buildReviewExecutionCase(task, rejectedReview, exec, diffResult, baseSha, splitSalt));
        usedPositiveHeads.add(headSha);
      }
      continue;
    }

    const reworkedExec = executions.find((ex) => ex.state === "changes_requested" && (ex.diff || task.diff));
    if (reworkedExec && positives.length < maxPositives) {
      const diffResult = normalizeUnifiedDiff(reworkedExec.diff ?? task.diff);
      const headSha = SHA40_PATTERN.test(reworkedExec.submission?.commitSha ?? "")
        ? reworkedExec.submission.commitSha.toLowerCase()
        : null;
      if (diffResult && headSha && !usedPositiveHeads.has(headSha)) {
        const baseSha =
          reworkedExec.deliveryBaseline?.kind === "commit" &&
          SHA40_PATTERN.test(reworkedExec.deliveryBaseline.commitSha ?? "")
            ? reworkedExec.deliveryBaseline.commitSha.toLowerCase()
            : null;
        positives.push(buildTaskReworkCase(task, reworkedExec, diffResult, baseSha, headSha, splitSalt));
        usedPositiveHeads.add(headSha);
      }
      continue;
    }

    if (
      task.status === "done" &&
      reviews.every((rev) => rev.verdict !== "changes_requested") &&
      executions.length === 1
    ) {
      const exec = executions[0];
      const headSha = SHA40_PATTERN.test(exec?.submission?.commitSha ?? "")
        ? exec.submission.commitSha.toLowerCase()
        : null;
      const diffResult = normalizeUnifiedDiff(exec?.diff ?? task.diff);
      if (!headSha || !diffResult || revertedShas.has(headSha) || usedPositiveHeads.has(headSha)) continue;
      const baseSha =
        exec.deliveryBaseline?.kind === "commit" && SHA40_PATTERN.test(exec.deliveryBaseline.commitSha ?? "")
          ? exec.deliveryBaseline.commitSha.toLowerCase()
          : null;
      cleanCandidates.push({
        sortKey: `task:${headSha}`,
        title: task.title,
        workKind: task.workKind ?? "fix",
        riskTier: task.riskTier ?? "medium",
        taskId: task.taskId,
        baseSha,
        headSha,
        diffResult,
        diffLines: diffResult.diffLines,
        diffSizeBucket: classifyDiffSizeBucket(diffResult.diffLines),
      });
    }
  }

  for (const ctrl of cleanControlSnapshots) {
    const diffResult = normalizeUnifiedDiff(ctrl.diff);
    const headSha = SHA40_PATTERN.test(ctrl.headSha ?? "") ? ctrl.headSha.toLowerCase() : null;
    if (!diffResult || !headSha || revertedShas.has(headSha) || usedPositiveHeads.has(headSha)) continue;
    const baseSha = SHA40_PATTERN.test(ctrl.baseSha ?? "") ? ctrl.baseSha.toLowerCase() : null;
    cleanCandidates.push({
      sortKey: `ctrl:${headSha}`,
      title: ctrl.title ?? "Clean merged change",
      workKind: ctrl.workKind ?? "fix",
      riskTier: ctrl.riskTier ?? "medium",
      taskId: ctrl.taskId ?? null,
      baseSha,
      headSha,
      diffResult,
      diffLines: diffResult.diffLines,
      diffSizeBucket: classifyDiffSizeBucket(diffResult.diffLines),
    });
  }

  return { positives, cleanCandidates, watermark: snapshot.watermark ?? null };
}

function extractFromLiveRepo(options, checkBudget) {
  const { repoRoot, projectionPath, sinceIso, splitSalt, maxPositives, maxTasksScan } = options;
  const gitRoot = resolveCanonicalGitRoot(repoRoot);
  const resolvedProjection = resolveProjectionPath(gitRoot, projectionPath);

  const { reverts, revertedCommitShas } = extractRevertCandidatesFromGit(gitRoot, sinceIso, checkBudget);
  const ledger = resolvedProjection
    ? readTasksFromProjection(resolvedProjection, gitRoot, sinceIso, maxTasksScan, checkBudget)
    : { records: [], watermark: null };

  const candidateShas = reverts.map((r) => r.revertedSha);
  for (const task of ledger.records) {
    for (const rev of task.reviews) if (rev.commitSha) candidateShas.push(rev.commitSha.toLowerCase());
    for (const ex of task.executions) {
      if (ex.submission?.commitSha) candidateShas.push(ex.submission.commitSha.toLowerCase());
      if (ex.deliveryBaseline?.kind === "commit") candidateShas.push(ex.deliveryBaseline.commitSha.toLowerCase());
    }
  }
  const reachable = batchCheckReachableCommits(gitRoot, candidateShas);

  const positives = [];
  const usedPositiveHeads = new Set();
  const cleanTaskRecords = [];

  // 1. Prioritize post-merge reverts (highest-signal escapes).
  // When the original revertedSha was squashed/rebased away, derive the exact reverted diff by
  // inverting the revert commit on main (`git diff <revertCommitSha> <revertCommitSha>^`).
  for (const revert of reverts) {
    if (checkBudget() || positives.length >= maxPositives) break;
    if (usedPositiveHeads.has(revert.revertedSha)) continue;
    let baseSha = null;
    let headSha = revert.revertedSha;
    let diffResult = null;
    if (reachable.has(revert.revertedSha)) {
      baseSha = resolveParentCommit(gitRoot, revert.revertedSha);
      diffResult = baseSha ? extractGitCommitDiff(gitRoot, baseSha, revert.revertedSha) : null;
    } else {
      const revertParent = resolveParentCommit(gitRoot, revert.revertCommitSha);
      if (revertParent) {
        baseSha = revert.revertCommitSha;
        headSha = revertParent;
        diffResult = extractGitCommitDiff(gitRoot, baseSha, headSha);
      }
    }
    if (!diffResult) continue;
    try {
      positives.push(buildGitRevertCase({ ...revert, revertedSha: headSha }, diffResult, baseSha, splitSalt));
      usedPositiveHeads.add(revert.revertedSha);
      usedPositiveHeads.add(headSha);
    } catch (error) {
      if (!(error instanceof SanitizeError)) throw error;
    }
  }

  // 2. Scan ledger tasks for review-execution rejections, task-rework, and clean controls.
  const tryPushPositive = (headSha, builder) => {
    if (usedPositiveHeads.has(headSha)) return;
    try {
      positives.push(builder());
      usedPositiveHeads.add(headSha);
    } catch (error) {
      if (!(error instanceof SanitizeError)) throw error;
    }
  };

  for (const task of ledger.records) {
    if (checkBudget()) break;
    const rejectedReviews = task.reviews.filter(
      (rev) => rev.verdict === "changes_requested" && rev.commitSha && reachable.has(rev.commitSha.toLowerCase()),
    );
    if (rejectedReviews.length > 0 && positives.length < maxPositives) {
      const review = rejectedReviews.find((rev) => (rev.findings?.length ?? 0) > 0) ?? rejectedReviews[0];
      const headSha = review.commitSha.toLowerCase();
      const exec = task.executions.find((ex) => ex.executionId === review.executionId);
      const baseSha = resolveBaselineSha(gitRoot, exec, headSha, reachable);
      const diffResult = baseSha ? extractGitCommitDiff(gitRoot, baseSha, headSha) : null;
      if (diffResult)
        tryPushPositive(headSha, () => buildReviewExecutionCase(task, review, exec, diffResult, baseSha, splitSalt));
      continue;
    }

    const hasAnyRejection = task.reviews.some((rev) => rev.verdict === "changes_requested");
    const reworkedExec = task.executions.find(
      (ex) =>
        ex.state === "changes_requested" &&
        ex.submission?.commitSha &&
        reachable.has(ex.submission.commitSha.toLowerCase()),
    );
    if (!hasAnyRejection && reworkedExec && positives.length < maxPositives) {
      const headSha = reworkedExec.submission.commitSha.toLowerCase();
      const baseSha = resolveBaselineSha(gitRoot, reworkedExec, headSha, reachable);
      const diffResult = baseSha ? extractGitCommitDiff(gitRoot, baseSha, headSha) : null;
      if (diffResult)
        tryPushPositive(headSha, () =>
          buildTaskReworkCase(task, reworkedExec, diffResult, baseSha, headSha, splitSalt),
        );
      continue;
    }

    if (
      task.status === "done" &&
      !hasAnyRejection &&
      task.executions.length === 1 &&
      task.executions[0]?.state === "accepted"
    ) {
      const ex = task.executions[0];
      const headSha = ex.submission?.commitSha?.toLowerCase() ?? null;
      if (headSha && reachable.has(headSha) && !revertedCommitShas.has(headSha)) {
        cleanTaskRecords.push({ task, execution: ex, headSha });
      }
    }
  }

  // 3. Collect clean control candidates from ledger (and git fallback if needed).
  const cleanCandidates = [];
  const usedCleanHeads = new Set();
  const targetCleanPool = Math.max(positives.length * 3, 24);

  for (const { task, execution, headSha } of cleanTaskRecords) {
    if (checkBudget() || cleanCandidates.length >= targetCleanPool) break;
    if (usedPositiveHeads.has(headSha) || usedCleanHeads.has(headSha)) continue;
    const baseSha = resolveBaselineSha(gitRoot, execution, headSha, reachable);
    const diffResult = baseSha ? extractGitCommitDiff(gitRoot, baseSha, headSha) : null;
    if (!diffResult) continue;
    usedCleanHeads.add(headSha);
    cleanCandidates.push({
      sortKey: `ledger:${headSha}`,
      title: task.title,
      workKind: task.workKind,
      riskTier: task.riskTier,
      taskId: task.taskId,
      baseSha,
      headSha,
      diffResult,
      diffLines: diffResult.diffLines,
      diffSizeBucket: classifyDiffSizeBucket(diffResult.diffLines),
    });
  }

  if (cleanCandidates.length < positives.length && !checkBudget()) {
    const exclude = new Set([...usedPositiveHeads, ...usedCleanHeads, ...revertedCommitShas]);
    for (const commit of extractGitCleanFallbackCommits(gitRoot, sinceIso, exclude, positives.length * 4 + 20)) {
      if (checkBudget() || cleanCandidates.length >= targetCleanPool) break;
      const baseSha = resolveParentCommit(gitRoot, commit.commitSha);
      const diffResult = baseSha ? extractGitCommitDiff(gitRoot, baseSha, commit.commitSha) : null;
      if (!diffResult) continue;
      usedCleanHeads.add(commit.commitSha);
      cleanCandidates.push({
        sortKey: `git:${commit.commitSha}`,
        title: commit.subject,
        workKind: "fix",
        riskTier: DEFAULT_RISK_TIER,
        taskId: commit.taskId,
        baseSha,
        headSha: commit.commitSha,
        diffResult,
        diffLines: diffResult.diffLines,
        diffSizeBucket: classifyDiffSizeBucket(diffResult.diffLines),
      });
    }
  }

  return {
    positives,
    cleanCandidates,
    watermark: ledger.watermark,
    projectionSource: resolvedProjection ? "projection-reader" : "git-only",
  };
}

function buildDatasetDocument(split, splitSalt, cases) {
  const ordered = [...cases].sort((a, b) => a.id.localeCompare(b.id, "en"));
  return {
    schema: RETRO_CASES_SCHEMA,
    version: 1,
    split,
    splitSalt,
    sourceSummary: summarizeRetroCases(ordered),
    cases: ordered,
  };
}

/** Core extraction pipeline. Pure and deterministic given identical inputs and `splitSalt`. */
export function runExtract(options = {}) {
  const nowMs = options.nowMs ?? (() => Date.now());
  const startedAtMs = nowMs();
  const maxWallMs = options.maxWallMs ?? null;
  let wallClockTruncated = false;
  const wallClockExceeded = () => {
    if (maxWallMs !== null && nowMs() - startedAtMs >= maxWallMs) {
      wallClockTruncated = true;
      return true;
    }
    return false;
  };

  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const outDir = path.resolve(options.outDir ?? DEFAULT_OUT_DIR);
  const sourceMapPath = path.resolve(options.sourceMapPath ?? DEFAULT_SOURCE_MAP);
  const seedsPath = path.resolve(options.seedsPath ?? DEFAULT_SEEDS_PATH);
  const splitSalt = options.splitSalt ?? DEFAULT_SPLIT_SALT;
  const holdoutRatio = options.holdoutRatio ?? DEFAULT_HOLDOUT_RATIO;
  const maxPositives = options.maxPositives ?? DEFAULT_MAX_POSITIVES;
  const maxTasksScan = options.maxTasksScan ?? DEFAULT_MAX_TASKS_SCAN;
  const sinceIso = resolveSinceIso(options.since);
  const includeSeeds = Boolean(options.includeSeeds);
  const dryRun = Boolean(options.dryRun);
  const strictHoldout = Boolean(options.strictHoldout);

  if (!Number.isFinite(holdoutRatio) || holdoutRatio <= 0 || holdoutRatio >= 1) {
    throw new ExtractError(
      `--holdout-ratio must be strictly between 0 and 1 (got ${String(holdoutRatio)})`,
      EXIT_INVALID_INPUT,
    );
  }

  let extracted;
  if (options.snapshotFile) {
    const snapPath = path.resolve(options.snapshotFile);
    if (!existsSync(snapPath)) throw new ExtractError(`Snapshot file not found: ${snapPath}`, EXIT_INVALID_INPUT);
    let snapshot;
    try {
      snapshot = JSON.parse(readFileSync(snapPath, "utf8"));
    } catch (error) {
      throw new ExtractError(
        `Invalid snapshot JSON (${snapPath}): ${error instanceof Error ? error.message : String(error)}`,
        EXIT_INVALID_INPUT,
      );
    }
    extracted = {
      ...extractFromSnapshot(snapshot, { splitSalt, maxPositives }, wallClockExceeded),
      projectionSource: "snapshot-file",
    };
  } else {
    extracted = extractFromLiveRepo(
      { repoRoot, projectionPath: options.projectionPath, sinceIso, splitSalt, maxPositives, maxTasksScan },
      wallClockExceeded,
    );
  }

  const sourceMap = {};
  const allCasesById = new Map();
  for (const pos of extracted.positives) {
    allCasesById.set(pos.caseObj.id, pos.caseObj);
    sourceMap[pos.caseObj.id] = pos.sourceMapEntry;
  }
  for (const { positive, negative } of matchNegativeControlsBySizeBucket(
    extracted.positives,
    extracted.cleanCandidates,
  )) {
    const builtNeg = buildCleanControlCase(
      negative,
      negative.diffResult,
      negative.baseSha,
      negative.headSha,
      positive.caseObj.id,
      splitSalt,
    );
    if (!allCasesById.has(builtNeg.caseObj.id)) {
      allCasesById.set(builtNeg.caseObj.id, builtNeg.caseObj);
      sourceMap[builtNeg.caseObj.id] = builtNeg.sourceMapEntry;
    }
  }
  if (includeSeeds) {
    for (const seedCase of loadSeedCases(seedsPath)) {
      if (!allCasesById.has(seedCase.id)) {
        allCasesById.set(seedCase.id, seedCase);
        sourceMap[seedCase.id] = { origin: "seed", seedId: seedCase.id };
      }
    }
  }

  const holdoutPath = path.join(outDir, "holdout.json");
  const tuningPath = path.join(outDir, "tuning.json");
  let existingHoldout = null;
  if (existsSync(holdoutPath)) {
    try {
      existingHoldout = JSON.parse(readFileSync(holdoutPath, "utf8"));
    } catch (error) {
      throw new ExtractError(
        `Existing holdout dataset is unreadable (${holdoutPath}): ${error instanceof Error ? error.message : String(error)}`,
        EXIT_INVALID_INPUT,
      );
    }
    const existingIssues = collectRetroCaseIssues(existingHoldout, { allowEmpty: true });
    if (existingIssues.length > 0) {
      throw new ExtractError(`Existing holdout dataset is invalid: ${existingIssues.join("; ")}`, EXIT_GATE_FAILURE);
    }
  }

  const existingHoldoutById = new Map((existingHoldout?.cases ?? []).map((entry) => [entry.id, entry]));
  const holdoutCasesMap = new Map(strictHoldout ? [] : existingHoldoutById.entries());
  const tuningCasesMap = new Map();

  for (const rawEntry of allCasesById.values()) {
    const split = existingHoldoutById.has(rawEntry.id)
      ? "holdout"
      : assignDeterministicSplit(rawEntry.id, splitSalt, holdoutRatio);
    const assigned = { ...rawEntry, split };

    if (split === "holdout") {
      if (
        existingHoldoutById.has(assigned.id) &&
        JSON.stringify(existingHoldoutById.get(assigned.id)) !== JSON.stringify(assigned)
      ) {
        throw new ExtractError(
          `Holdout immutability violation: attempted to modify frozen holdout case ${assigned.id}`,
          EXIT_GATE_FAILURE,
          "holdout_tamper_detected",
        );
      }
      holdoutCasesMap.set(assigned.id, assigned);
    } else {
      tuningCasesMap.set(assigned.id, assigned);
    }
  }

  const tuningDoc = buildDatasetDocument("tuning", splitSalt, [...tuningCasesMap.values()]);
  const holdoutDoc = buildDatasetDocument("holdout", splitSalt, [...holdoutCasesMap.values()]);

  const immutabilityIssues = collectHoldoutImmutabilityIssues(existingHoldout, holdoutDoc);
  if (immutabilityIssues.length > 0) {
    throw new ExtractError(
      `Holdout immutability violation: ${immutabilityIssues.join("; ")}`,
      EXIT_GATE_FAILURE,
      "holdout_tamper_detected",
    );
  }

  const allowEmptySide = tuningDoc.cases.length + holdoutDoc.cases.length > 0;
  const tuningIssues = collectRetroCaseIssues(tuningDoc, { allowEmpty: allowEmptySide });
  const holdoutIssues = collectRetroCaseIssues(holdoutDoc, { allowEmpty: allowEmptySide });
  if (tuningIssues.length > 0 || holdoutIssues.length > 0) {
    const allIssues = [...tuningIssues.map((m) => `tuning: ${m}`), ...holdoutIssues.map((m) => `holdout: ${m}`)];
    throw new ExtractError(`Dataset validation failed:\n- ${allIssues.join("\n- ")}`, EXIT_GATE_FAILURE);
  }

  rejectPrivateLeakage(tuningDoc, "tuning.json");
  rejectPrivateLeakage(holdoutDoc, "holdout.json");

  const tuningJson = `${JSON.stringify(tuningDoc, null, 2)}\n`;
  const holdoutJson = `${JSON.stringify(holdoutDoc, null, 2)}\n`;
  const tuningSha256 = hash("sha256", tuningJson, "hex");
  const holdoutSha256 = hash("sha256", holdoutJson, "hex");

  if (!dryRun) {
    mkdirSync(outDir, { recursive: true });
    persistUtf8FileSync(tuningPath, tuningJson);
    persistUtf8FileSync(holdoutPath, holdoutJson);
    mkdirSync(path.dirname(sourceMapPath), { recursive: true });
    const sortedSourceMap = Object.fromEntries(Object.entries(sourceMap).sort(([a], [b]) => a.localeCompare(b, "en")));
    persistUtf8FileSync(
      sourceMapPath,
      `${JSON.stringify({ schema: "retro-source-map/v1", splitSalt, entries: sortedSourceMap }, null, 2)}\n`,
    );
  }

  const combinedCases = [...tuningDoc.cases, ...holdoutDoc.cases];
  return {
    ok: true,
    exitCode: wallClockTruncated ? EXIT_BUDGET_EXCEEDED : EXIT_OK,
    schema: RETRO_CASES_SCHEMA,
    dryRun,
    budgetTruncated: wallClockTruncated,
    projectionSource: extracted.projectionSource,
    watermark: extracted.watermark,
    splitSalt,
    holdoutRatio,
    privateLeakHits: 0,
    totalCases: combinedCases.length,
    counts: { tuning: tuningDoc.cases.length, holdout: holdoutDoc.cases.length },
    summary: summarizeRetroCases(combinedCases),
    tuningSummary: tuningDoc.sourceSummary,
    holdoutSummary: holdoutDoc.sourceSummary,
    sha256: { tuning: tuningSha256, holdout: holdoutSha256 },
    outputs: {
      tuningPath: path.relative(process.cwd(), tuningPath).split(path.sep).join("/"),
      holdoutPath: path.relative(process.cwd(), holdoutPath).split(path.sep).join("/"),
    },
  };
}

export function formatExtractUsage() {
  return [
    "Usage: node tools/retro/cli.mjs extract [options]",
    "",
    "Options:",
    "  --repo-root <dir>         Repository root (default: cwd)",
    "  --projection-path <file>  Explicit read-only task.sqlite projection path",
    "  --snapshot-file <file>    Offline JSON snapshot input (bypasses live projection/git)",
    "  --out-dir <dir>           Output directory for tuning.json & holdout.json (default: tools/retro/datasets)",
    "  --source-map <file>       Private local source map path (default: .retro-local/source-map.json)",
    "  --since <Nd|ISO>          Lookback window (default: 60d)",
    "  --split-salt <string>     Deterministic hash split salt (default: retro-v1)",
    "  --holdout-ratio <float>   Fraction routed to holdout (default: 0.4)",
    "  --max-positives <int>     Max extracted positive cases (default: 32)",
    "  --max-tasks-scan <int>    Max projection tasks scanned (default: 400)",
    "  --include-seeds           Merge tools/evals/closeout-reviewer/cases.json cold-start seeds",
    "  --seeds-path <file>       Custom seed cases JSON path",
    "  --strict-holdout          Reject if any existing holdout caseId is absent from input",
    "  --verify <file>           Validate & scan a dataset JSON file for private leakage (exit 1 on fail)",
    "  --dry-run                 Validate & compute split without writing files",
    "  --max-wall-ms <ms>        Wall-clock budget; exits 3 on truncation",
    "  --help                    Show this help message",
  ].join("\n");
}

function parsePositiveInt(raw, flagName) {
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new ExtractError(`${flagName} must be a positive integer (got ${String(raw)})`, EXIT_INVALID_INPUT);
  }
  return num;
}

export async function runExtractCli(argv, io = {}) {
  const stdout = io.stdout ?? ((line) => console.log(line));
  const stderr = io.stderr ?? ((line) => console.error(line));

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "repo-root": { type: "string" },
        "projection-path": { type: "string" },
        "snapshot-file": { type: "string" },
        "out-dir": { type: "string" },
        "source-map": { type: "string" },
        since: { type: "string" },
        "split-salt": { type: "string" },
        "holdout-ratio": { type: "string" },
        "max-positives": { type: "string" },
        "max-tasks-scan": { type: "string" },
        "include-seeds": { type: "boolean", default: false },
        "seeds-path": { type: "string" },
        "strict-holdout": { type: "boolean", default: false },
        verify: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "max-wall-ms": { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n\n${formatExtractUsage()}`);
    return EXIT_INVALID_INPUT;
  }

  const { values } = parsed;
  if (values.help) {
    stdout(formatExtractUsage());
    return EXIT_OK;
  }

  try {
    if (values.verify) {
      const report = verifyDatasetFile(values.verify);
      stdout(JSON.stringify(report, null, 2));
      return report.exitCode;
    }
    const result = runExtract({
      repoRoot: values["repo-root"],
      projectionPath: values["projection-path"],
      snapshotFile: values["snapshot-file"],
      outDir: values["out-dir"],
      sourceMapPath: values["source-map"],
      since: values.since,
      splitSalt: values["split-salt"],
      holdoutRatio: values["holdout-ratio"] !== undefined ? Number(values["holdout-ratio"]) : undefined,
      maxPositives:
        values["max-positives"] !== undefined
          ? parsePositiveInt(values["max-positives"], "--max-positives")
          : undefined,
      maxTasksScan:
        values["max-tasks-scan"] !== undefined
          ? parsePositiveInt(values["max-tasks-scan"], "--max-tasks-scan")
          : undefined,
      includeSeeds: values["include-seeds"],
      seedsPath: values["seeds-path"],
      strictHoldout: values["strict-holdout"],
      dryRun: values["dry-run"],
      maxWallMs:
        values["max-wall-ms"] !== undefined ? parsePositiveInt(values["max-wall-ms"], "--max-wall-ms") : undefined,
    });
    stdout(JSON.stringify(result, null, 2));
    return result.exitCode;
  } catch (error) {
    if (error instanceof SanitizeError) {
      stderr(error.message);
      return EXIT_GATE_FAILURE;
    }
    if (error instanceof ExtractError) {
      stderr(error.message);
      return error.exitCode;
    }
    stderr(error instanceof Error ? error.message : String(error));
    return EXIT_GATE_FAILURE;
  }
}
