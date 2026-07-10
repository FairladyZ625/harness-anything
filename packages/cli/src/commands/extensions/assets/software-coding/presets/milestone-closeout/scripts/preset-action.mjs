#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");
const context = JSON.parse(readFileSync(contextPath, "utf8"));
const taskRoot = context.outputRoot;
const artifactsDir = path.join(taskRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const policyRules = context.policy?.rules ?? {};
const requiresStrongEvidence = policyRules.evidenceMode === "typed-canonical-projection";
const milestoneBoundary = resolveMilestoneBoundary();
const canonicalEvidenceRefs = resolveCanonicalEvidenceRefs();
const criteria = Array.isArray(context.milestoneCriteria) ? context.milestoneCriteria : [];
const taskEvidence = Array.isArray(context.taskEvidence) ? context.taskEvidence : [];
const criteriaItems = criteria.length > 0
  ? criteria.map((criterion) => evaluateCriterion(criterion, taskEvidence))
  : [{
    status: "red",
    reason: "no_milestone_criteria",
    sourcePath: relative(context.paths.rootDir, context.paths.authoredRoot),
    line: 0,
    text: "No milestone feature-breakdown or exit-criteria markdown was found.",
    evidenceStrength: "none"
  }];
const decisionCoverageItems = policyRules.requireLoadBearingClaimCoverage === true ? evaluateDecisionCoverage() : [];
const items = [...criteriaItems, ...decisionCoverageItems];
const summary = {
  green: items.filter((item) => item.status === "green").length,
  yellow: 0,
  red: items.filter((item) => item.status === "red").length,
  weak: items.filter((item) => item.evidenceStrength === "weak").length,
  strong: items.filter((item) => item.evidenceStrength === "strong").length,
  none: items.filter((item) => item.evidenceStrength === "none").length,
  total: items.length
};
const report = {
  schema: "milestone-closeout-parity/v1",
  taskId: context.taskId,
  status: summary.red === 0 ? "passed" : "blocked",
  summary,
  criteriaSource: "milestone-feature-breakdown",
  evidencePolicy: {
    mode: requiresStrongEvidence ? "typed-canonical-projection" : "checkbox-self-report",
    requiredStrength: requiresStrongEvidence ? "strong" : "weak",
    source: context.policy?.sourcePath ?? "public-default"
  },
  items
};
writeFileSync(path.join(artifactsDir, "milestone-closeout-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
  ok: summary.red === 0,
  report,
  error: summary.red === 0 ? undefined : {
    code: "milestone_closeout_blocked",
    hint: "Milestone closeout found red items."
  }
}, null, 2)}\n`, "utf8");

function evaluateCriterion(criterion, taskEvidence) {
  if (!criterion.checked) return { ...criterion, status: "red", reason: "milestone_criterion_unchecked", evidenceStrength: "none" };
  if (hasStubMarker(criterion.text)) return { ...criterion, status: "red", reason: "milestone_criterion_stub_or_placeholder", evidenceStrength: "none" };
  const matchedEvidence = taskEvidence
    .map((evidence) => ({ evidence, line: matchingCheckedLine(evidence.body, criterion.text) }))
    .find((candidate) => candidate.line !== null);
  if (!matchedEvidence) {
    return { ...criterion, status: "red", reason: "missing_task_evidence_for_milestone_criterion", evidenceStrength: "none" };
  }
  if (requiresStrongEvidence) {
    const declaredRefs = typedEvidenceRefs(matchedEvidence.line);
    const resolvedRefs = declaredRefs.filter((ref) => canonicalEvidenceRefs.has(ref));
    if (resolvedRefs.length === 0) {
      return {
        ...criterion,
        status: "red",
        reason: declaredRefs.length === 0 ? "typed_evidence_ref_required" : "typed_evidence_ref_unresolved",
        evidencePath: matchedEvidence.evidence.sourcePath,
        evidenceMode: "checkbox-self-report",
        evidenceStrength: "weak",
        evidenceRefs: declaredRefs
      };
    }
    return {
      ...criterion,
      status: "green",
      reason: "typed_evidence_ref_resolved",
      evidencePath: matchedEvidence.evidence.sourcePath,
      evidenceMode: "typed-canonical-projection",
      evidenceStrength: "strong",
      evidenceRefs: resolvedRefs
    };
  }
  return {
    ...criterion,
    status: "green",
    reason: "task_evidence_matches_milestone_criterion",
    evidencePath: matchedEvidence.evidence.sourcePath,
    evidenceMode: "checkbox-self-report",
    evidenceStrength: "weak"
  };
}

function evaluateDecisionCoverage() {
  if (!milestoneBoundary.ok) {
    return [{
      status: "red",
      reason: milestoneBoundary.reason,
      sourcePath: context.policy?.sourcePath ?? "",
      line: 0,
      text: milestoneBoundary.text,
      evidenceStrength: "none"
    }];
  }
  const factRefs = new Set(Array.isArray(context.factRefs) ? context.factRefs : []);
  const boundaryTaskRefs = new Set([...milestoneBoundary.taskIds].map((taskId) => `task/${taskId}`));
  const boundaryFactRefs = new Set([...factRefs].filter((ref) => milestoneBoundary.taskIds.has(taskIdFromFactRef(ref))));
  return (Array.isArray(context.decisions) ? context.decisions : [])
    .flatMap((decision) => {
      if (decision.state !== "active") return [];
      const relations = Array.isArray(decision.relations) ? decision.relations : [];
      if (!relations.some((relation) => boundaryTaskRefs.has(relation.target) || boundaryFactRefs.has(relation.target))) return [];
      return (Array.isArray(decision.claims) ? decision.claims : [])
        .filter((claim) => claim.loadBearing)
        .map((claim) => {
          const claimRef = `decision/${decision.decisionId}/${claim.id}`;
          const evidenceRef = relations.find((relation) => relation.source === claimRef && boundaryFactRefs.has(relation.target))?.target;
          return evidenceRef ? {
            status: "green",
            reason: "load_bearing_decision_claim_covered",
            sourcePath: decision.sourcePath,
            line: 0,
            text: `${claimRef} is covered by a live fact in the milestone boundary.`,
            evidenceStrength: "strong",
            evidenceRefs: [evidenceRef]
          } : {
            status: "red",
            reason: "load_bearing_decision_claim_uncovered",
            sourcePath: decision.sourcePath,
            line: 0,
            text: `${claimRef} is uncovered at milestone exit.`,
            evidenceStrength: "none"
          };
        });
    });
}

function matchingCheckedLine(body, text) {
  const expected = normalize(text);
  return body.split(/\r?\n/u).find((line) => {
    const match = /^\s*[-*]\s+\[[xX]\]\s+(.+)$/u.exec(line);
    return Boolean(match) && normalize(match[1]).includes(expected) && !hasStubMarker(match[1]);
  }) ?? null;
}

function typedEvidenceRefs(value) {
  return [...new Set(value.match(/\bfact\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\b/gu) ?? [])];
}

function resolveCanonicalEvidenceRefs() {
  const factRefs = Array.isArray(context.factRefs) ? context.factRefs : [];
  if (!requiresStrongEvidence || !policyRules.boundary) return new Set(factRefs);
  if (!milestoneBoundary.ok) return new Set();
  return new Set(factRefs.filter((ref) => milestoneBoundary.taskIds.has(taskIdFromFactRef(ref))));
}

function resolveMilestoneBoundary() {
  if (!policyRules.boundary) {
    const taskIds = (Array.isArray(context.taskIndex) ? context.taskIndex : [])
      .map((task) => task.taskId)
      .filter((taskId) => typeof taskId === "string");
    const factTaskIds = (Array.isArray(context.factRefs) ? context.factRefs : []).map(taskIdFromFactRef).filter(Boolean);
    return { ok: true, taskIds: new Set([...taskIds, ...factTaskIds]) };
  }
  const inputName = policyRules.boundary.rootTaskInput;
  const rootTaskId = context.inputs?.[inputName];
  if (typeof rootTaskId !== "string" || rootTaskId.trim() === "") {
    return {
      ok: false,
      reason: "milestone_boundary_root_missing",
      text: `Policy requires runtime input ${inputName}.`
    };
  }
  const taskIds = new Set([rootTaskId]);
  const tasks = Array.isArray(context.taskIndex) ? context.taskIndex : [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (typeof task.taskId === "string" && taskIds.has(task.parent) && !taskIds.has(task.taskId)) {
        taskIds.add(task.taskId);
        changed = true;
      }
    }
  }
  return { ok: true, taskIds };
}

function taskIdFromFactRef(ref) {
  return /^fact\/([^/]+)\//u.exec(ref)?.[1] ?? "";
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
