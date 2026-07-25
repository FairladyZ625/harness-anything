#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultRepoRoot = path.resolve(import.meta.dirname, "..");
const limitSourcePath = "packages/cli/src/commands/core/decision-writing-standard.ts";
const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const flowTextPattern = /\btext: ("(?:\\.|[^"\\])*")(?=\s*[,}])/u;

export function checkDecisionChosenLength(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const baselinePath = options.baselinePath ?? path.join(repoRoot, "tools/decision-chosen-length-baseline.json");
  const limit = readChosenLimit(repoRoot);
  const baseline = readBaseline(baselinePath, limit);
  const decisionsResolution = options.decisionsRoot
    ? { status: "checked", decisionsRoot: options.decisionsRoot }
    : resolveDecisionsRoot(repoRoot);

  if (decisionsResolution.status !== "checked") {
    return {
      status: decisionsResolution.status,
      reason: decisionsResolution.reason,
      limit,
      scannedDecisions: 0,
      scannedChoices: 0,
      baselineEntries: baseline.entries.length,
      violations: []
    };
  }

  try {
    const choices = readDecisionChoices(decisionsResolution.decisionsRoot);
    const overlong = choices.filter((choice) => choice.length > limit);
    const currentByKey = new Map(overlong.map((choice) => [choice.key, choice]));
    const baselineByKey = new Map(baseline.entries.map((entry) => [entry.key, entry]));
    const violations = [];

    for (const choice of overlong) {
      const entry = baselineByKey.get(choice.key);
      if (!entry) {
        violations.push(`${choice.key} is ${choice.length} characters; new chosen entries may not exceed ${limit}`);
        continue;
      }
      if (entry.length !== choice.length || entry.sha256 !== choice.sha256) {
        violations.push(`${choice.key} changed while still over limit; baseline content must not drift`);
      }
    }
    for (const entry of baseline.entries) {
      if (!currentByKey.has(entry.key)) {
        violations.push(`${entry.key} no longer exceeds ${limit}; remove its stale baseline entry`);
      }
    }

    return {
      status: "checked",
      reason: null,
      limit,
      scannedDecisions: new Set(choices.map((choice) => choice.decisionId)).size,
      scannedChoices: choices.length,
      baselineEntries: baseline.entries.length,
      violations
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
      limit,
      scannedDecisions: 0,
      scannedChoices: 0,
      baselineEntries: baseline.entries.length,
      violations: []
    };
  }
}

export function formatDecisionChosenLengthReport(result) {
  if (result.status === "not-applicable") {
    return `Decision chosen length check not applicable: ${result.reason}. Baseline validated (${result.baselineEntries} entry/entries, limit ${result.limit}).`;
  }
  if (result.status === "unavailable") {
    return `Decision chosen length check failed: decision ledger unavailable: ${result.reason}.`;
  }
  if (result.violations.length === 0) {
    return `Decision chosen length check passed: ${result.scannedDecisions} decisions, ${result.scannedChoices} chosen entries, ${result.baselineEntries} exact historical exemptions, limit ${result.limit}.`;
  }
  return [
    "Decision chosen length check failed.",
    ...result.violations.map((violation) => `- ${violation}`),
    "Repair each new or changed entry: split parallel judgments into separate chosen entries, move reasons to the body, and move implementation requirements to tasks.",
    "Read harness/standards/decision-writing.md."
  ].join("\n");
}

export function readDecisionChoices(decisionsRoot) {
  const choices = [];
  for (const entry of readdirSync(decisionsRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const documentPath = path.join(decisionsRoot, entry.name, "decision.md");
    if (!existsSync(documentPath) || !statSync(documentPath).isFile()) continue;
    const source = readFileSync(documentPath, "utf8");
    const frontmatter = frontmatterPattern.exec(source)?.[1];
    if (!frontmatter) throw new Error(`${documentPath} has no decision frontmatter`);
    const decisionId = readScalar(frontmatter, "decision_id");
    if (!decisionId) throw new Error(`${documentPath} has no decision_id`);
    const chosenBlock = /^chosen:\r?\n([\s\S]*?)(?=^[A-Za-z_][A-Za-z0-9_]*:)/mu.exec(frontmatter)?.[1];
    if (!chosenBlock) throw new Error(`${documentPath} has no chosen block`);
    const lines = chosenBlock.split(/\r?\n/u).filter((line) => /^  - /u.test(line));
    for (const [index, line] of lines.entries()) {
      const encodedText = flowTextPattern.exec(line)?.[1];
      if (!encodedText) throw new Error(`${documentPath} chosen entry ${index + 1} has no parseable text`);
      const text = JSON.parse(encodedText);
      if (typeof text !== "string") throw new Error(`${documentPath} chosen entry ${index + 1} text is not a string`);
      const anchor = readFlowScalar(line, "id") ?? `CH${index + 1}`;
      choices.push({
        key: `${decisionId}/${anchor}`,
        decisionId,
        anchor,
        length: [...text].length,
        sha256: `sha256:${createHash("sha256").update(text).digest("hex")}`,
        text
      });
    }
  }
  return choices;
}

function readChosenLimit(repoRoot) {
  const source = readFileSync(path.join(repoRoot, limitSourcePath), "utf8");
  const match = /export const decisionChosenTextMaxLength = (\d+);/u.exec(source);
  const value = Number(match?.[1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${limitSourcePath} must declare a positive decisionChosenTextMaxLength`);
  return value;
}

function readBaseline(baselinePath, limit) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (baseline.schema !== "harness-anything/decision-chosen-length-baseline/v1") {
    throw new Error(`${baselinePath} has an unsupported schema`);
  }
  if (baseline.maxChosenTextLength !== limit || !Array.isArray(baseline.entries)) {
    throw new Error(`${baselinePath} must match chosen limit ${limit} and declare entries`);
  }
  const keys = new Set();
  for (const entry of baseline.entries) {
    if (!entry || typeof entry.key !== "string" || !Number.isInteger(entry.length) || entry.length <= limit
      || typeof entry.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error(`${baselinePath} contains an invalid exemption`);
    }
    if (keys.has(entry.key)) throw new Error(`${baselinePath} contains duplicate ${entry.key}`);
    keys.add(entry.key);
  }
  return baseline;
}

function resolveDecisionsRoot(repoRoot) {
  const direct = inspectLayout(repoRoot);
  if (direct.status !== "not-self-hosted") return direct;
  const commonRoot = resolveCommonCheckoutRoot(repoRoot);
  if (commonRoot === null || commonRoot === repoRoot) {
    return { status: "not-applicable", reason: direct.reason };
  }
  const canonical = inspectLayout(commonRoot);
  return canonical.status === "not-self-hosted"
    ? { status: "not-applicable", reason: `neither checkout nor common Git checkout declares harness/harness.yaml (${repoRoot}; ${commonRoot})` }
    : canonical;
}

function inspectLayout(repoRoot) {
  const configPath = path.join(repoRoot, "harness", "harness.yaml");
  if (!existsSync(configPath)) {
    return { status: "not-self-hosted", reason: "checkout does not declare harness/harness.yaml" };
  }
  const config = readFileSync(configPath, "utf8");
  const authoredRoot = readNestedScalar(config, "layout", "authoredRoot") ?? "harness";
  if (!safeRelativePath(authoredRoot)) {
    return { status: "unavailable", reason: `${configPath} layout.authoredRoot must stay inside the checkout` };
  }
  const decisionsRoot = path.join(repoRoot, authoredRoot, "decisions");
  if (!existsSync(decisionsRoot) || !statSync(decisionsRoot).isDirectory()) {
    return { status: "unavailable", reason: `decisions root is not a directory: ${decisionsRoot}` };
  }
  return { status: "checked", decisionsRoot };
}

function resolveCommonCheckoutRoot(repoRoot) {
  const dotGitPath = path.join(repoRoot, ".git");
  try {
    if (!existsSync(dotGitPath) || !statSync(dotGitPath).isFile()) return null;
    const gitDirMatch = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(dotGitPath, "utf8"));
    if (!gitDirMatch) return null;
    const gitDir = path.resolve(repoRoot, gitDirMatch[1]);
    const commonDirPath = path.join(gitDir, "commondir");
    if (!existsSync(commonDirPath) || !statSync(commonDirPath).isFile()) return null;
    return path.dirname(path.resolve(gitDir, readFileSync(commonDirPath, "utf8").trim()));
  } catch {
    return null;
  }
}

function readNestedScalar(source, sectionName, keyName) {
  let section = "";
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "");
    const topLevel = /^([A-Za-z][A-Za-z0-9]*):/u.exec(line);
    if (topLevel) {
      section = topLevel[1];
      continue;
    }
    if (section !== sectionName) continue;
    const nested = new RegExp(`^\\s+${keyName}:\\s*(.*?)\\s*$`, "u").exec(line);
    if (nested) return decodeScalar(nested[1] ?? "");
  }
  return null;
}

function readScalar(source, key) {
  const match = new RegExp(`^${key}:\\s*(.*?)\\s*$`, "mu").exec(source);
  return match ? decodeScalar(match[1] ?? "") : null;
}

function readFlowScalar(source, key) {
  const match = new RegExp(`\\b${key}:\\s*("(?:\\\\.|[^"\\\\])*")`, "u").exec(source);
  return match ? JSON.parse(match[1]) : null;
}

function decodeScalar(raw) {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      const decoded = JSON.parse(value);
      return typeof decoded === "string" && decoded ? decoded : null;
    } catch {
      return null;
    }
  }
  return value;
}

function safeRelativePath(value) {
  const normalized = path.normalize(value);
  return !path.isAbsolute(value) && normalized !== "." && !normalized.startsWith("..") && !normalized.includes(`..${path.sep}`);
}

export function main(options = {}) {
  const result = checkDecisionChosenLength(options);
  console.log(formatDecisionChosenLengthReport(result));
  if (result.status === "not-applicable") return 0;
  return result.status === "checked" && result.violations.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
