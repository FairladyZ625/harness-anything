#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");
const context = JSON.parse(readFileSync(contextPath, "utf8"));
const taskRoot = context.outputRoot;
const artifactsDir = path.join(taskRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const criteriaRoots = [
  context.paths.milestonesRoot
];
const criteria = criteriaRoots
  .flatMap((root) => walkMarkdown(root))
  .filter((filePath) => /(?:^|\/)(?:feature-breakdown|milestone-closeout|exit-criteria)\.md$/u.test(toSlash(filePath)))
  .flatMap((filePath) => readCriteria(filePath, "milestone"));
const taskEvidence = walkMarkdown(taskRoot)
  .filter((filePath) => !toSlash(path.relative(taskRoot, filePath)).startsWith("artifacts/"))
  .map((filePath) => ({
    sourcePath: relative(context.paths.rootDir, filePath),
    body: readFileSync(filePath, "utf8")
  }));
const items = criteria.length > 0
  ? criteria.map((criterion) => evaluateCriterion(criterion, taskEvidence))
  : [{
    status: "red",
    reason: "no_milestone_criteria",
    sourcePath: relative(context.paths.rootDir, context.paths.authoredRoot),
    line: 0,
    text: "No milestone feature-breakdown or exit-criteria markdown was found."
  }];
const summary = {
  green: items.filter((item) => item.status === "green").length,
  yellow: 0,
  red: items.filter((item) => item.status === "red").length,
  total: items.length
};
const report = {
  schema: "milestone-closeout-parity/v1",
  taskId: context.taskId,
  status: summary.red === 0 ? "passed" : "blocked",
  summary,
  criteriaSource: "milestone-feature-breakdown",
  items
};
writeFileSync(path.join(artifactsDir, "milestone-closeout-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
  ok: summary.red === 0,
  report,
  error: summary.red === 0 ? undefined : {
    code: "milestone_closeout_blocked",
    hint: "Milestone closeout parity found red items."
  }
}, null, 2)}\n`, "utf8");

function evaluateCriterion(criterion, taskEvidence) {
  if (!criterion.checked) return { ...criterion, status: "red", reason: "milestone_criterion_unchecked" };
  if (hasStubMarker(criterion.text)) return { ...criterion, status: "red", reason: "milestone_criterion_stub_or_placeholder" };
  const needle = normalize(criterion.text);
  const matchedEvidence = taskEvidence.find((evidence) => normalize(evidence.body).includes(needle) && hasCheckedLine(evidence.body, criterion.text));
  if (!matchedEvidence) {
    return { ...criterion, status: "red", reason: "missing_task_evidence_for_milestone_criterion" };
  }
  return { ...criterion, status: "green", reason: "task_evidence_matches_milestone_criterion", evidencePath: matchedEvidence.sourcePath };
}

function readCriteria(filePath) {
  const relativePath = relative(context.paths.rootDir, filePath);
  return readFileSync(filePath, "utf8").split(/\r?\n/u).flatMap((line, index) => {
    const match = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/u.exec(line);
    if (!match) return [];
    return [{
      status: "red",
      reason: "unclassified",
      sourcePath: relativePath,
      line: index + 1,
      checked: match[1] !== " ",
      text: match[2].trim()
    }];
  });
}

function hasCheckedLine(body, text) {
  const expected = normalize(text);
  return body.split(/\r?\n/u).some((line) => {
    const match = /^\s*[-*]\s+\[[xX]\]\s+(.+)$/u.exec(line);
    return Boolean(match) && normalize(match[1]).includes(expected) && !hasStubMarker(match[1]);
  });
}

function hasStubMarker(value) {
  return /\b(?:stub|skeleton|todo|placeholder|pending)\b/iu.test(value);
}

function normalize(value) {
  return value.toLowerCase().replace(/[`*_~[\]()#.,:;!"']/gu, "").replace(/\s+/gu, " ").trim();
}

function walkMarkdown(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return walkMarkdown(entryPath);
    if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
    return [entryPath];
  }).sort();
}

function relative(rootDir, targetPath) {
  return toSlash(path.relative(rootDir, targetPath));
}

function toSlash(value) {
  return value.split(path.sep).join("/");
}
