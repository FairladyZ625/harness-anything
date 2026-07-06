#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");
const context = JSON.parse(readFileSync(contextPath, "utf8"));
const taskRoot = context.outputRoot;
const artifactsDir = path.join(taskRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const criteria = Array.isArray(context.milestoneCriteria) ? context.milestoneCriteria : [];
const taskEvidence = Array.isArray(context.taskEvidence) ? context.taskEvidence : [];
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
  const factRefs = new Set(Array.isArray(context.factRefs) ? context.factRefs : []);
  return (Array.isArray(context.decisions) ? context.decisions : [])
    .flatMap((decision) => {
      if (decision.state !== "active") return [];
      const relations = Array.isArray(decision.relations) ? decision.relations : [];
      return (Array.isArray(decision.claims) ? decision.claims : [])
        .filter((claim) => claim.loadBearing)
        .map((claim) => {
          const claimRef = `decision/${decision.decisionId}/${claim.id}`;
          const covered = relations.some((relation) => relation.source === claimRef && relation.target.startsWith("fact/") && factRefs.has(relation.target));
          return covered ? {
            status: "green",
            reason: "load_bearing_decision_claim_covered",
            sourcePath: decision.sourcePath,
            line: 0,
            text: `${claimRef} is covered by a live fact.`
          } : {
            status: "red",
            reason: "load_bearing_decision_claim_uncovered",
            sourcePath: decision.sourcePath,
            line: 0,
            text: `${claimRef} is uncovered at milestone exit.`
          };
        });
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

function relative(rootDir, targetPath) {
  return toSlash(path.relative(rootDir, targetPath));
}

function toSlash(value) {
  return value.split(path.sep).join("/");
}
