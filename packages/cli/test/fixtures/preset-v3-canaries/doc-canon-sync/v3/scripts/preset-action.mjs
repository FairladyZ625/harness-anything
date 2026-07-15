#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const context = readContext();
const decisionsProjection = readCapability("decisions");
const adrsProjection = readCapability("adrs");
const docsProjection = readCapability("operating-docs");
const operatingDocs = docsProjection.documents;
const operatingCorpus = operatingDocs.map((doc) => doc.body).join("\n\n");
const watermark = readSyncWatermark(operatingDocs.find((doc) => doc.relativePath.endsWith("/AGENTS.md"))?.body ?? "");
const decisions = decisionsProjection.decisions.map((entry) => ({
  ...entry,
  recommendedDocs: recommendDocs("decision", entry.title)
}));
const adrs = adrsProjection.adrs.map((entry) => ({
  ...entry,
  recommendedDocs: recommendDocs("adr", entry.title)
}));
const canonical = [...decisions, ...adrs].sort(compareCanonical);
const drift = canonical.flatMap((entry) => evaluateCanonical(entry, operatingCorpus, watermark));
const warnings = detectWorkflowSmells(operatingDocs);
const summary = {
  green: drift.length === 0 ? canonical.length : Math.max(0, canonical.length - drift.length),
  yellow: warnings.length,
  red: drift.length,
  total: canonical.length + warnings.length
};
const report = {
  schema: "doc-canon-drift/v1",
  taskId: context.run.taskId,
  status: drift.length === 0 ? "passed" : "blocked",
  generatedAt: new Date().toISOString(),
  watermark,
  summary,
  sources: {
    canonicalCount: canonical.length,
    decisionCount: decisions.length,
    adrCount: adrs.length,
    operatingDocCount: operatingDocs.length
  },
  drift,
  warnings
};
writeFileSync(outputPath("doc-canon-drift", "application/json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(outputPath("doc-canon-drift", "text/markdown"), renderMarkdown(report), "utf8");
writeResult({
  schema: "script-result/v1",
  ok: drift.length === 0,
  report,
  produced: ["doc-canon-drift"],
  error: drift.length === 0 ? undefined : {
    code: "preset_script_result_failed",
    hint: "Document canon drift found red items. Update operating docs or advance canon-synced-through after reconciliation."
  }
});

function evaluateCanonical(entry, corpus, syncWatermark) {
  const referenced = corpus.includes(entry.canonicalId);
  const newerThanWatermark = isAfter(entry.date, syncWatermark.syncedAt);
  if (referenced && !newerThanWatermark) return [];
  const reasons = [];
  if (!referenced) reasons.push("missing_operating_reference");
  if (newerThanWatermark) reasons.push("newer_than_sync_watermark");
  return [{
    canonicalId: entry.canonicalId,
    kind: entry.kind,
    title: entry.title,
    date: entry.date,
    sourcePath: entry.sourcePath,
    recommendedDocs: entry.recommendedDocs,
    reasons,
    rationale: "Canonical item is not reflected by operating docs or is newer than the declared canon sync watermark."
  }];
}

function detectWorkflowSmells(docs) {
  return docs.filter((doc) => !/(?:^|\/)(?:archive|generated)(?:\/|$)/u.test(doc.relativePath)).flatMap((doc) => {
    const warnings = [];
    const lower = doc.body.toLowerCase();
    if (/\bharness write <opid>\b/iu.test(doc.body)) warnings.push({
      code: "stale_write_coordinator_commit_message",
      sourcePath: doc.relativePath,
      rationale: "Operating doc still describes opaque WriteCoordinator commit messages."
    });
    if (lower.includes("task") && !/\b(decision|fact|relation)\b/iu.test(doc.body)) warnings.push({
      code: "task_only_workflow_smell",
      sourcePath: doc.relativePath,
      rationale: "Operating doc mentions task workflow without decision/fact/relation circulation."
    });
    return warnings;
  });
}

function recommendDocs(kind, text) {
  if (kind === "adr") return ["governance/standards/architecture-conformance-standard.md"];
  if (/\b(cli|command|json|input|output|receipt|report|agent|ha)\b/iu.test(text)) return ["AGENTS.md"];
  if (/\b(schema|crud|coordinator|write|projection|repository|model|delete|field)\b/iu.test(text)) {
    return ["governance/standards/implementation-contract-standard.md"];
  }
  return ["AGENTS.md"];
}

function readSyncWatermark(body) {
  const match = /<!--\s*canon-synced-through:\s*([^\s]+)\s+@\s*([^>]+?)\s*-->/u.exec(body);
  return { canonicalId: match?.[1] ?? null, syncedAt: normalizeScalar(match?.[2] ?? "1970-01-01T00:00:00.000Z") };
}

function renderMarkdown(value) {
  const lines = [
    "# Document Canon Drift", "", `Status: ${value.status}`, `Generated: ${value.generatedAt}`,
    `Watermark: ${value.watermark.canonicalId ?? "none"} @ ${value.watermark.syncedAt}`, "",
    `Summary: ${value.summary.red} red, ${value.summary.yellow} yellow, ${value.summary.green} green`, "", "## Drift", ""
  ];
  if (value.drift.length === 0) lines.push("- None");
  else for (const item of value.drift) {
    lines.push(`- ${item.canonicalId} (${item.kind}) - ${item.title}`);
    lines.push(`  - source: ${item.sourcePath}`);
    lines.push(`  - update: ${item.recommendedDocs.join(", ")}`);
    lines.push(`  - reasons: ${item.reasons.join(", ")}`);
  }
  lines.push("", "## Old Workflow Warnings", "");
  if (value.warnings.length === 0) lines.push("- None");
  else for (const warning of value.warnings) lines.push(`- ${warning.code} in ${warning.sourcePath}: ${warning.rationale}`);
  lines.push("");
  return lines.join("\n");
}

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

function compareCanonical(left, right) {
  const byDate = (Date.parse(right.date) || 0) - (Date.parse(left.date) || 0);
  return byDate !== 0 ? byDate : left.canonicalId.localeCompare(right.canonicalId);
}

function isAfter(date, watermarkDate) {
  const value = Date.parse(date);
  const watermarkValue = Date.parse(watermarkDate);
  return Number.isFinite(value) && Number.isFinite(watermarkValue) && value > watermarkValue;
}

function normalizeScalar(value) {
  return String(value ?? "").trim().replace(/^["']|["']$/gu, "");
}
