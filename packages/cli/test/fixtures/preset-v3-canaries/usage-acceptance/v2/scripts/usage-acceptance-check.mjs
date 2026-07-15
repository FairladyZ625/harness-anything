#!/usr/bin/env node
// usage-acceptance :: check
//
// Deterministic gate-readable validator over the eyes-agent's findings. It is
// the anti-foam lock: a run only passes when the report shows a real, evidenced,
// user-angle walkthrough with every blocker resolved. This is what a future
// `usage-acceptance` completion-gate axis (application layer) would invoke to
// hard-block a feature task's completion.
//
// Pass conditions (ALL required):
//   - findings.json exists and parses,
//   - verdict === "pass",
//   - zero blockers left unresolved (a blocker needs a non-empty `resolution`),
//   - every finding carries at least one evidence anchor,
//   - at least one finding OR one escalated semantic question exists
//     (a zero-friction, zero-question report is treated as "did not really look").

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT ?? process.env.HARNESS_SCRIPT_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");
const context = JSON.parse(readFileSync(contextPath, "utf8"));
const outputRoot = context.outputRoot;
const artifactsDir = path.join(outputRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const findingsPath = path.join(artifactsDir, "usage-acceptance-findings.json");
const violations = [];
const smokeMode = context.validationSmoke === true;
let findings = smokeMode ? smokeFindings(context.taskId) : null;

if (smokeMode) {
  writeFileSync(path.join(artifactsDir, "usage-acceptance-smoke-evidence.txt"), "isolated usage-acceptance checker smoke\n", "utf8");
} else if (!existsSync(findingsPath)) {
  violations.push({ code: "findings_missing", detail: "run `scaffold` first, then have the eyes-agent fill it" });
} else {
  try {
    findings = JSON.parse(readFileSync(findingsPath, "utf8"));
  } catch (error) {
    violations.push({ code: "findings_unparseable", detail: String(error?.message ?? error) });
  }
}

if (findings) {
  const list = Array.isArray(findings.findings) ? findings.findings : [];
  const questions = Array.isArray(findings.semanticQuestions) ? findings.semanticQuestions : [];

  if (findings.verdict !== "pass") {
    violations.push({ code: "verdict_not_pass", detail: `verdict is "${findings.verdict ?? "missing"}"` });
  }

  const openBlockers = list.filter((item) => item.severity === "blocker" && !String(item.resolution ?? "").trim());
  for (const blocker of openBlockers) {
    violations.push({ code: "blocker_unresolved", detail: blocker.id ?? blocker.expected ?? "unnamed blocker" });
  }

  const noEvidence = list.filter((item) => !Array.isArray(item.evidence) || item.evidence.length === 0);
  for (const item of noEvidence) {
    violations.push({ code: "finding_without_evidence", detail: item.id ?? item.expected ?? "unnamed finding" });
  }

  const escalated = questions.filter((question) => question.escalate === true);
  if (list.length === 0 && escalated.length === 0) {
    violations.push({ code: "empty_walkthrough", detail: "zero findings and zero escalated questions — treated as 'did not really use it'" });
  }
}

const status = violations.length === 0 ? "passed" : "blocked";
const report = {
  schema: "usage-acceptance-check/v1",
  taskId: context.taskId,
  featureTaskId: findings?.featureTaskId ?? resolveInput(context.inputs?.featureTaskId, context.taskId),
  status,
  generatedAt: new Date().toISOString(),
  summary: {
    findings: Array.isArray(findings?.findings) ? findings.findings.length : 0,
    openBlockers: violations.filter((violation) => violation.code === "blocker_unresolved").length,
    violations: violations.length
  },
  violations
};

writeFileSync(path.join(artifactsDir, "usage-acceptance-check.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
  ok: status === "passed",
  rows: report.summary.findings,
  report,
  error: status === "passed" ? undefined : {
    code: "usage_acceptance_not_satisfied",
    hint: `Usage acceptance is blocked: ${violations.map((violation) => violation.code).join(", ") || "unknown"}`
  }
}, null, 2)}\n`, "utf8");

function resolveInput(value, fallback) {
  if (typeof value !== "string") return fallback;
  return /^\{\{.+\}\}$/u.test(value.trim()) || value.trim() === "" ? fallback : value.trim();
}

function smokeFindings(taskId) {
  return {
    schema: "usage-acceptance-findings/v1",
    featureTaskId: taskId,
    persona: "preset checker smoke",
    surface: "cli",
    scenario: "validate a passing, evidenced finding through the real checker",
    intentSources: [],
    findings: [{
      id: "smoke-evidenced-friction",
      severity: "friction",
      expected: "the checker accepts an evidenced and resolved walkthrough",
      actual: "the isolated fixture reached the validator",
      evidence: ["artifacts/usage-acceptance-smoke-evidence.txt"],
      resolution: "verified by the preset check smoke"
    }],
    semanticQuestions: [],
    verdict: "pass",
    capturedAt: new Date().toISOString()
  };
}
