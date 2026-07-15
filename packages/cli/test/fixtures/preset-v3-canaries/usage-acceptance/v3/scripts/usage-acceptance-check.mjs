#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const context = readContext();
const artifacts = readCapability("task-artifacts").artifacts;
const findingsHandle = artifacts.find((artifact) => artifact.id === "usage-acceptance-findings" && artifact.mediaType === "application/json");
const violations = [];
let findings = null;
if (!findingsHandle) {
  violations.push({ code: "findings_missing", detail: "run `scaffold` first, then have the eyes-agent fill it" });
} else {
  try {
    findings = JSON.parse(readFileSync(findingsHandle.path, "utf8"));
  } catch (error) {
    violations.push({ code: "findings_unparseable", detail: String(error?.message ?? error) });
  }
}
if (findings) {
  const list = Array.isArray(findings.findings) ? findings.findings : [];
  const questions = Array.isArray(findings.semanticQuestions) ? findings.semanticQuestions : [];
  if (findings.verdict !== "pass") violations.push({ code: "verdict_not_pass", detail: `verdict is "${findings.verdict ?? "missing"}"` });
  for (const blocker of list.filter((item) => item.severity === "blocker" && !String(item.resolution ?? "").trim())) {
    violations.push({ code: "blocker_unresolved", detail: blocker.id ?? blocker.expected ?? "unnamed blocker" });
  }
  for (const item of list.filter((candidate) => !Array.isArray(candidate.evidence) || candidate.evidence.length === 0)) {
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
  taskId: context.run.taskId,
  featureTaskId: findings?.featureTaskId ?? context.inputs.featureTaskId,
  status,
  generatedAt: new Date().toISOString(),
  summary: {
    findings: Array.isArray(findings?.findings) ? findings.findings.length : 0,
    openBlockers: violations.filter((violation) => violation.code === "blocker_unresolved").length,
    violations: violations.length
  },
  violations
};
writeFileSync(outputPath("usage-acceptance-check", "application/json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeResult({
  schema: "script-result/v1",
  ok: status === "passed",
  rows: report.summary.findings,
  report,
  produced: ["usage-acceptance-check"],
  error: status === "passed" ? undefined : {
    code: "usage_acceptance_not_satisfied",
    hint: `Usage acceptance is blocked: ${violations.map((violation) => violation.code).join(", ") || "unknown"}`
  }
});

function readContext() {
  const filename = process.env.HARNESS_PRESET_CONTEXT;
  if (!filename) throw new Error("HARNESS_PRESET_CONTEXT is required");
  return JSON.parse(readFileSync(filename, "utf8"));
}

function readCapability(id) {
  const handle = context.capabilities.reads[id]?.[0];
  if (!handle) throw new Error(`missing ${id} capability handle`);
  return JSON.parse(readFileSync(handle.path, "utf8"));
}

function outputPath(id, mediaType) {
  const writer = context.capabilities.writes["task-artifacts"]?.[0];
  const representation = writer?.artifacts?.[id]?.representations?.find((entry) => entry.mediaType === mediaType);
  if (!representation) throw new Error(`missing ${id} ${mediaType} writer`);
  return representation.path;
}

function writeResult(value) {
  writeFileSync(context.result.path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
