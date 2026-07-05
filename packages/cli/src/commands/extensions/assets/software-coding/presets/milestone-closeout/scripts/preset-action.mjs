#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const criteriaItems = criteria.length > 0
  ? criteria.map((criterion) => evaluateCriterion(criterion, taskEvidence))
  : [{
    status: "red",
    reason: "no_milestone_criteria",
    sourcePath: relative(context.paths.rootDir, context.paths.authoredRoot),
    line: 0,
    text: "No milestone feature-breakdown or exit-criteria markdown was found."
  }];
const decisionCoverageItems = evaluateDecisionCoverage();
const items = [...criteriaItems, ...decisionCoverageItems];
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

function evaluateDecisionCoverage() {
  const decisionsRoot = context.paths.decisionsRoot;
  const factRefs = readFactRefs();
  return walkMarkdown(decisionsRoot)
    .filter((filePath) => path.basename(filePath) === "decision.md")
    .flatMap((filePath) => {
      const body = readFileSync(filePath, "utf8");
      const decisionId = readScalar(body, "decision_id") || path.basename(path.dirname(filePath)).replace(/^decision-/u, "");
      if (readScalar(body, "state") !== "active") return [];
      const relations = readDecisionRelations(body);
      return readDecisionClaims(body)
        .filter((claim) => claim.loadBearing)
        .map((claim) => {
          const claimRef = `decision/${decisionId}/${claim.id}`;
          const covered = relations.some((relation) => relation.source === claimRef && relation.target.startsWith("fact/") && factRefs.has(relation.target));
          return covered ? {
            status: "green",
            reason: "load_bearing_decision_claim_covered",
            sourcePath: relative(context.paths.rootDir, filePath),
            line: 0,
            text: `${claimRef} is covered by a live fact.`
          } : {
            status: "red",
            reason: "load_bearing_decision_claim_uncovered",
            sourcePath: relative(context.paths.rootDir, filePath),
            line: 0,
            text: `${claimRef} is uncovered at milestone exit.`
          };
        });
    });
}

function readFactRefs() {
  const refs = new Set();
  for (const factsPath of factSearchRoots().flatMap((root) => walkMarkdown(root)).filter((filePath) => path.basename(filePath) === "facts.md")) {
    const taskDir = path.dirname(factsPath);
    const taskId = readTaskId(taskDir);
    for (const match of readFileSync(factsPath, "utf8").matchAll(/\bfact_id:\s*"?([A-Za-z0-9_-]+)"?/gu)) {
      refs.add(`fact/${taskId}/${match[1]}`);
    }
  }
  return refs;
}

function factSearchRoots() {
  const tasksRoot = path.resolve(context.paths.tasksRoot);
  const outputRoot = path.resolve(context.outputRoot);
  const roots = new Set([outputRoot]);
  for (const scope of context.readScopes ?? []) {
    const resolved = path.resolve(scope);
    if (resolved !== tasksRoot && path.dirname(resolved) === tasksRoot) roots.add(resolved);
  }
  return [...roots];
}

function readTaskId(taskDir) {
  const indexPath = path.join(taskDir, "INDEX.md");
  try {
    return readScalar(readFileSync(indexPath, "utf8"), "task_id") || path.basename(taskDir);
  } catch {
    return path.basename(taskDir);
  }
}

function readDecisionClaims(body) {
  return readFlowBlock(body, "claims").flatMap((line) => {
    const object = parseFlowObjectLine(line);
    if (!object.id) return [];
    return [{ id: object.id, loadBearing: object.load_bearing !== "false" }];
  });
}

function readDecisionRelations(body) {
  return readFlowBlock(body, "relations").flatMap((line) => {
    const object = parseFlowObjectLine(line);
    return object.source && object.target ? [{ source: object.source, target: object.target }] : [];
  });
}

function readFlowBlock(body, key) {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start < 0) return [];
  const output = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    if (/^\s*-\s*\{/u.test(line)) output.push(line.trim());
  }
  return output;
}

function parseFlowObjectLine(line) {
  const body = line.replace(/^\s*-\s*\{\s*/u, "").replace(/\s*\}\s*$/u, "");
  const object = {};
  for (const part of splitTopLevel(body)) {
    const separator = part.indexOf(":");
    if (separator <= 0) continue;
    object[part.slice(0, separator).trim()] = unquote(part.slice(separator + 1).trim());
  }
  return object;
}

function splitTopLevel(value) {
  const parts = [];
  let inString = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (char === "\"" && previous !== "\\") inString = !inString;
    if (!inString && char === ",") {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function readScalar(body, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "mu").exec(body);
  return match ? unquote(match[1].trim()) : "";
}

function unquote(value) {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
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
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
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
