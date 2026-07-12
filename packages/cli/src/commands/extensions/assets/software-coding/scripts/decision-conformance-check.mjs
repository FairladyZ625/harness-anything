#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const {
  detectRelationGraphCycles,
  queryDecisionProjection,
  queryTaskProjection,
  readDecisionFactCoverage,
  readRelationGraphProjection
} = await importKernelProjectionApi();

const contextPath = process.env.HARNESS_SCRIPT_CONTEXT;
const resultPath = process.env.HARNESS_SCRIPT_RESULT;
if (!contextPath || !resultPath) {
  throw new Error("script context and result paths are required");
}

const context = JSON.parse(readFileSync(contextPath, "utf8"));
const rootDir = context.paths.rootDir;
const policyRules = context.policy?.presetId === "decision-conformance" ? context.policy.rules : {};
const enforcement = policyRules.enforcement === "fail" ? "fail" : "report";
const adoptionCutoff = policyRules.adoptionCutoff ? Date.parse(policyRules.adoptionCutoff) : undefined;
const legacyExemptions = new Set(
  Array.isArray(policyRules.legacyExemptions)
    ? policyRules.legacyExemptions.map((exemption) => exemption.kind)
    : []
);
const decisionProjection = queryDecisionProjection({ rootDir, filters: {} });
const taskProjection = queryTaskProjection({ rootDir, filters: { includeArchived: true } });
const relationProjection = readRelationGraphProjection({ rootDir });

const decisions = decisionProjection.rows;
const tasks = taskProjection.rows;
const activeEdges = relationProjection.edges.filter((edge) => edge.state === "active");
const proposedMaxAgeDays = readPositiveInteger(policyRules.proposedMaxAgeDays ?? context.inputs?.proposedMaxAgeDays, 14);
const decisionIds = new Set(decisions.map((decision) => decision.decisionId));
const taskIds = new Set(tasks.map((task) => task.taskId));
const factRefs = new Set(relationProjection.factAnchors.map((fact) => fact.factRef));
const violations = [];

for (const decision of decisions) {
  const decisionRef = `decision/${decision.decisionId}`;
  if (!existsSync(path.join(rootDir, decision.path))) {
    finding(
      "decision-document-missing",
      decisionRef,
      `Decision projection points at missing document ${decision.path}.`,
      "Restore the decision.md package or rebuild the projection from authored decisions."
    );
  }

  if (decision.state === "active" && !isPreRuleLegacyDecision(decision) && !hasTaskOrDeferEdge(decisionRef)) {
    finding(
      "accepted-decision-missing-task-or-defer",
      decisionRef,
      "Accepted decision has no active task/defer edge.",
      "Add an active decision->task derives edge, add an active task->decision implements edge, or defer the decision explicitly."
    );
  }

  if (decision.state === "active" && !isPreRuleLegacyDecision(decision)) {
    const coverage = readDecisionFactCoverage({ rootDir, decisionId: decision.decisionId });
    for (const row of coverage.rows) {
      if (row.status === "covered") continue;
      finding(
        "decision-claim-uncovered",
        row.claimRef,
        "Load-bearing decision claim has no reachable live fact.",
        "Relate the claim to a valid fact with evidenced-by/supporting relation flow, or mark the claim non-load-bearing when appropriate."
      );
      if (row.refutingFactRefs?.length > 0) {
        finding(
          "decision-claim-refuted",
          row.claimRef,
          `Load-bearing decision claim is refuted by active fact evidence: ${row.refutingFactRefs.join(", ")}.`,
          "Revise or mark the claim non-load-bearing, then retire the refutation only if later evidence resolves it."
        );
      }
    }
  }

  if (decision.state === "proposed" && isStaleDecisionDocument(decision.path, proposedMaxAgeDays)) {
    finding(
      "decision-proposed-stale",
      decisionRef,
      `Decision remains proposed beyond ${proposedMaxAgeDays} days.`,
      "Transition the decision, or keep the conformance finding as the explicit explanation for pending scope."
    );
  }

  if (decision.state === "retired" && !hasIncomingSupersedes(decisionRef)) {
    finding(
      "retired-decision-missing-superseder",
      decisionRef,
      "Retired decision is not connected to an active superseding decision.",
      "Add an active decision->decision supersedes edge from the replacement decision, or document why retirement was not supersession."
    );
  }
}

for (const edge of activeEdges) {
  checkEndpoint(edge.sourceRef, edge.relationId, edge.sourcePath);
  checkEndpoint(edge.targetRef, edge.relationId, edge.sourcePath);
}

for (const cycle of detectRelationGraphCycles(activeEdges)) {
  finding(
    "relation-cycle",
    cycle[0] ?? "relation-cycle",
    `Active relation graph contains a cycle: ${cycle.join(" -> ")}.`,
    "Break the cyclic active relation records before relying on conformance output."
  );
}

const report = {
  schema: "decision-conformance-report/v1",
  scriptId: context.scriptId,
  source: context.source,
  verticalId: context.verticalId,
  enforcement,
  summary: {
    decisionCount: decisions.length,
    taskCount: tasks.length,
    relationCount: relationProjection.edges.length,
    factCount: factRefs.size,
    violationCount: violations.length,
    findingCount: enforcement === "fail" ? violations.length : 0
  },
  violations,
  findings: enforcement === "fail" ? violations : [],
  projectionWarnings: [
    ...decisionProjection.warnings,
    ...taskProjection.warnings,
    ...relationProjection.warnings
  ]
};

writeFileSync(resultPath, JSON.stringify({
  schema: "script-result/v1",
  ok: enforcement !== "fail" || violations.length === 0,
  rows: violations.length,
  report,
  produced: []
}, null, 2), "utf8");

function hasTaskOrDeferEdge(decisionRef) {
  if (decisions.some((decision) => decision.state === "deferred" && `decision/${decision.decisionId}` === decisionRef)) return true;
  return activeEdges.some((edge) => (
    isSameDecisionOrAnchor(edge.sourceRef, decisionRef) &&
    edge.targetRef.startsWith("task/") &&
    edge.relationType === "derives"
  ) || (
    isSameDecisionOrAnchor(edge.targetRef, decisionRef) &&
    edge.sourceRef.startsWith("task/") &&
    edge.relationType === "implements"
  ));
}

function hasIncomingSupersedes(decisionRef) {
  return activeEdges.some((edge) => (
    isSameDecisionOrAnchor(edge.targetRef, decisionRef) &&
    edge.sourceRef.startsWith("decision/") &&
    edge.relationType === "supersedes"
  ));
}

function isSameDecisionOrAnchor(ref, decisionRef) {
  return ref === decisionRef || ref.startsWith(`${decisionRef}/`);
}

function checkEndpoint(ref, relationId, sourcePath) {
  if (ref.startsWith("task/")) {
    const taskId = ref.slice("task/".length).split("/")[0];
    if (!taskIds.has(taskId)) {
      finding(
        "decision-relation-dangling-task",
        ref,
        `Relation ${relationId} references missing task ${ref} from ${sourcePath}.`,
        "Update the relation endpoint to an existing task package or retire the stale relation."
      );
    }
  }
  if (ref.startsWith("decision/")) {
    const decisionId = ref.slice("decision/".length).split("/")[0];
    if (!decisionIds.has(decisionId)) {
      finding(
        "decision-relation-dangling-decision",
        ref,
        `Relation ${relationId} references missing decision ${ref} from ${sourcePath}.`,
        "Update the relation endpoint to an existing decision package or retire the stale relation."
      );
    }
  }
  if (ref.startsWith("fact/") && !factRefs.has(ref)) {
    finding(
      "decision-relation-dangling-fact",
      ref,
      `Relation ${relationId} references missing fact ${ref} from ${sourcePath}.`,
      "Restore the task-local fact record or retire the stale relation."
    );
  }
}

function finding(type, ref, message, hint) {
  violations.push({ type, ref, message, hint });
}

function isPreRuleLegacyDecision(decision) {
  if (legacyExemptions.has("decided-before-cutoff") && adoptionCutoff !== undefined && decision.decidedAt) {
    const t = Date.parse(decision.decidedAt);
    if (Number.isFinite(t) && t < adoptionCutoff) return true;
  }
  if (legacyExemptions.has("missing-decided-at-with-legacy-id") && !decision.decidedAt && decision.legacyId) return true;
  return false;
}

function isStaleDecisionDocument(relativeDecisionPath, maxAgeDays) {
  const fullPath = path.join(rootDir, relativeDecisionPath);
  if (!existsSync(fullPath)) return false;
  const ageMs = Date.now() - statSync(fullPath).mtimeMs;
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function importKernelProjectionApi() {
  const candidates = [
    new URL("../../../../../../../kernel/src/index.ts", import.meta.url),
    new URL("../../../../../../../kernel/src/index.js", import.meta.url)
  ];
  let lastError;
  for (const candidate of candidates) {
    try {
      return await import(candidate.href);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Unable to import kernel projection API");
}
