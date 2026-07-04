#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");
const context = JSON.parse(readFileSync(contextPath, "utf8"));
const artifactsDir = path.join(context.outputRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const operatingDocs = readOperatingDocs();
const operatingCorpus = operatingDocs.map((doc) => doc.body).join("\n\n");
const watermark = readSyncWatermark(operatingDocs.find((doc) => doc.relativePath === "harness/AGENTS.md")?.body ?? "");
const decisions = walkFiles(context.paths.decisionsRoot)
  .filter((filePath) => path.basename(filePath) === "decision.md")
  .map(readDecision)
  .filter((entry) => entry && entry.state === "active");
const adrRoots = uniquePaths([
  context.paths.adrRoot,
  path.join(context.paths.authoredRoot, "context/architecture/adr")
]);
const adrs = adrRoots.flatMap((root) => walkFiles(root))
  .filter((filePath) => filePath.endsWith(".md"))
  .map(readAdr)
  .filter((entry) => entry && ["accepted", "active", "approved"].includes(entry.status));
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
  taskId: context.taskId,
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
writeFileSync(path.join(artifactsDir, "doc-canon-drift.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(path.join(artifactsDir, "doc-canon-drift.md"), renderMarkdown(report), "utf8");
writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
  ok: drift.length === 0,
  report,
  error: drift.length === 0 ? undefined : {
    code: "preset_script_result_failed",
    hint: "Document canon drift found red items. Update operating docs or advance canon-synced-through after reconciliation."
  }
}, null, 2)}\n`, "utf8");

function readOperatingDocs() {
  const roots = [
    path.join(context.paths.authoredRoot, "AGENTS.md"),
    path.join(context.paths.authoredRoot, "governance"),
    path.join(context.paths.authoredRoot, "standards")
  ];
  return roots.flatMap((root) => walkFiles(root))
    .filter((filePath) => /\.(?:md|mdx|txt|ya?ml|json)$/iu.test(filePath))
    .map((filePath) => ({
      path: filePath,
      relativePath: relative(filePath),
      body: readFileSync(filePath, "utf8")
    }));
}

function readDecision(filePath) {
  const body = readFileSync(filePath, "utf8");
  const frontmatter = parseFrontmatter(body);
  const id = frontmatter.decision_id ?? frontmatter.id;
  if (!id) return undefined;
  return {
    kind: "decision",
    canonicalId: id,
    title: frontmatter.title ?? firstMarkdownHeading(body) ?? id,
    state: normalizeScalar(frontmatter.state ?? "unknown").toLowerCase(),
    date: normalizeScalar(frontmatter.decidedAt ?? frontmatter.proposedAt ?? ""),
    sourcePath: relative(filePath),
    recommendedDocs: recommendDocs("decision", `${frontmatter.title ?? ""} ${body}`)
  };
}

function readAdr(filePath) {
  const body = readFileSync(filePath, "utf8");
  const frontmatter = parseFrontmatter(body);
  const status = readAdrStatus(body);
  const id = frontmatter.id ?? /(?:^|\/)(ADR-\d{4,})/u.exec(toSlash(filePath))?.[1];
  if (!id) return undefined;
  return {
    kind: "adr",
    canonicalId: id,
    title: frontmatter.title ?? firstMarkdownHeading(body) ?? id,
    status: normalizeScalar(frontmatter.status ?? status.status ?? "unknown").toLowerCase(),
    date: normalizeScalar(frontmatter.date ?? status.date ?? ""),
    sourcePath: relative(filePath),
    recommendedDocs: recommendDocs("adr", `${frontmatter.title ?? ""} ${body}`)
  };
}

function evaluateCanonical(entry, corpus, watermark) {
  const referenced = corpus.includes(entry.canonicalId);
  const newerThanWatermark = isAfter(entry.date, watermark.syncedAt);
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
    if (/\bharness write <opid>\b/iu.test(doc.body)) {
      warnings.push({
        code: "stale_write_coordinator_commit_message",
        sourcePath: doc.relativePath,
        rationale: "Operating doc still describes opaque WriteCoordinator commit messages."
      });
    }
    if (lower.includes("task") && !/\b(decision|fact|relation)\b/iu.test(doc.body)) {
      warnings.push({
        code: "task_only_workflow_smell",
        sourcePath: doc.relativePath,
        rationale: "Operating doc mentions task workflow without decision/fact/relation circulation."
      });
    }
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

function parseFrontmatter(body) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(body);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const scalar = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
    if (!scalar) continue;
    result[scalar[1]] = normalizeScalar(scalar[2]);
  }
  return result;
}

function readSyncWatermark(body) {
  const match = /<!--\s*canon-synced-through:\s*([^\s]+)\s+@\s*([^>]+?)\s*-->/u.exec(body);
  return {
    canonicalId: match?.[1] ?? null,
    syncedAt: normalizeScalar(match?.[2] ?? "1970-01-01T00:00:00.000Z")
  };
}

function readAdrStatus(body) {
  const statusSection = /^##\s+Status\s*\r?\n+([\s\S]*?)(?:\r?\n##\s+|\s*$)/imu.exec(body)?.[1] ?? "";
  const firstStatusLine = statusSection.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
  const match = /^(Accepted|Active|Approved|Proposed|Deprecated|Superseded|Rejected)\b(?:\s+(\d{4}-\d{2}-\d{2}))?/iu.exec(firstStatusLine);
  return {
    status: match?.[1],
    date: match?.[2]
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Document Canon Drift",
    "",
    `Status: ${report.status}`,
    `Generated: ${report.generatedAt}`,
    `Watermark: ${report.watermark.canonicalId ?? "none"} @ ${report.watermark.syncedAt}`,
    "",
    `Summary: ${report.summary.red} red, ${report.summary.yellow} yellow, ${report.summary.green} green`,
    "",
    "## Drift",
    ""
  ];
  if (report.drift.length === 0) {
    lines.push("- None");
  } else {
    for (const item of report.drift) {
      lines.push(`- ${item.canonicalId} (${item.kind}) - ${item.title}`);
      lines.push(`  - source: ${item.sourcePath}`);
      lines.push(`  - update: ${item.recommendedDocs.join(", ")}`);
      lines.push(`  - reasons: ${item.reasons.join(", ")}`);
    }
  }
  lines.push("", "## Old Workflow Warnings", "");
  if (report.warnings.length === 0) {
    lines.push("- None");
  } else {
    for (const warning of report.warnings) {
      lines.push(`- ${warning.code} in ${warning.sourcePath}: ${warning.rationale}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function firstMarkdownHeading(body) {
  return /^#\s+(.+)$/mu.exec(body)?.[1]?.trim();
}

function walkFiles(targetPath) {
  if (!targetPath || !existsSync(targetPath)) return [];
  const stats = statSync(targetPath);
  if (stats.isFile()) return [targetPath];
  if (!stats.isDirectory()) return [];
  return readdirSync(targetPath, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    return walkFiles(path.join(targetPath, entry.name));
  }).sort();
}

function compareCanonical(a, b) {
  const byDate = (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);
  if (byDate !== 0) return byDate;
  return a.canonicalId.localeCompare(b.canonicalId);
}

function isAfter(date, watermarkDate) {
  const value = Date.parse(date);
  const watermarkValue = Date.parse(watermarkDate);
  return Number.isFinite(value) && Number.isFinite(watermarkValue) && value > watermarkValue;
}

function normalizeScalar(value) {
  return String(value ?? "").trim().replace(/^["']|["']$/gu, "");
}

function uniquePaths(values) {
  return [...new Set(values.filter(Boolean))];
}

function relative(filePath) {
  return toSlash(path.relative(context.paths.rootDir, filePath));
}

function toSlash(value) {
  return value.split(path.sep).join("/");
}
