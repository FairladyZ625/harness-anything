#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import process from "node:process";

const defaultProjectionPath = ".harness/cache/projections.sqlite";
const defaultOutputPath = ".harness/generated/graph-panorama/index.html";

export function generateGraphPanorama(input = {}) {
  const rootDir = path.resolve(input.rootDir ?? process.cwd());
  const projectionPath = path.resolve(rootDir, input.projectionPath ?? defaultProjectionPath);
  const outputPath = path.resolve(rootDir, input.outputPath ?? defaultOutputPath);
  const graphRows = readGraphRows(projectionPath);
  const model = buildPanoramaModel(graphRows);
  const html = renderPanoramaHtml(model);

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html);
  return {
    outputPath,
    projectionPath,
    summary: model.summary,
    statusCounts: model.statusCounts
  };
}

function readGraphRows(projectionPath) {
  if (!existsSync(projectionPath)) {
    throw new Error(`Projection database not found: ${projectionPath}`);
  }
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const relationEdges = db
      .prepare("SELECT row_json FROM relation_edges ORDER BY source_ref, target_ref, relation_id")
      .all()
      .map((record) => JSON.parse(record.row_json));
    const coverageRows = db
      .prepare("SELECT row_json FROM relation_coverage ORDER BY claim_ref")
      .all()
      .map((record) => JSON.parse(record.row_json));
    return { relationEdges, coverageRows };
  } finally {
    db.close();
  }
}

function buildPanoramaModel({ relationEdges, coverageRows }) {
  const refs = new Map();
  for (const edge of relationEdges) {
    addRef(refs, edge.sourceRef, "source");
    addRef(refs, edge.targetRef, "target");
  }
  for (const row of coverageRows) {
    addRef(refs, row.decisionRef, "decision");
    addRef(refs, row.claimRef, "claim");
    if (row.coveringFactRef) addRef(refs, row.coveringFactRef, "fact");
  }

  const statusCounts = {};
  for (const row of coverageRows) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  }

  const uncoveredClaims = coverageRows.filter((row) => row.status !== "covered");
  const activeEdges = relationEdges.filter((edge) => edge.state === "active");
  const inactiveEdges = relationEdges.filter((edge) => edge.state !== "active");
  return {
    generatedAt: new Date().toISOString(),
    refs: Array.from(refs.values()).sort((left, right) => left.ref.localeCompare(right.ref)),
    relationEdges,
    coverageRows,
    uncoveredClaims,
    activeEdges,
    inactiveEdges,
    statusCounts,
    summary: {
      refs: refs.size,
      edges: relationEdges.length,
      activeEdges: activeEdges.length,
      inactiveEdges: inactiveEdges.length,
      coverageRows: coverageRows.length,
      uncoveredClaims: uncoveredClaims.length
    }
  };
}

function addRef(refs, ref, role) {
  const existing = refs.get(ref);
  if (existing) {
    existing.roles.add(role);
    return;
  }
  refs.set(ref, { ref, roles: new Set([role]) });
}

function renderPanoramaHtml(model) {
  const statusCards = Object.entries(model.statusCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => statCard(status, count))
    .join("");
  const edgeRows = model.relationEdges.map(renderEdgeRow).join("");
  const coverageRows = model.coverageRows.map(renderCoverageRow).join("");
  const refRows = model.refs.map(renderRefRow).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relation Graph Panorama</title>
<style>
:root { color-scheme: light; --ink: #17202a; --muted: #5b6776; --line: #d8dee8; --panel: #f7f9fc; --accent: #0b6bcb; --warn: #b42318; }
* { box-sizing: border-box; }
body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: #fff; }
header { padding: 28px 32px 20px; border-bottom: 1px solid var(--line); }
main { padding: 24px 32px 40px; display: grid; gap: 24px; }
h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; letter-spacing: 0; }
h2 { margin: 0 0 12px; font-size: 18px; line-height: 1.3; letter-spacing: 0; }
p { margin: 0; color: var(--muted); line-height: 1.5; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: var(--panel); }
.stat strong { display: block; font-size: 24px; line-height: 1.1; }
.stat span { color: var(--muted); font-size: 13px; }
section { display: grid; gap: 10px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px; }
th, td { border: 1px solid var(--line); padding: 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: var(--panel); color: #344054; }
.covered { color: #027a48; font-weight: 700; }
.uncovered { color: var(--warn); font-weight: 700; }
.empty { border: 1px dashed var(--line); border-radius: 8px; padding: 14px; color: var(--muted); }
</style>
</head>
<body>
<header>
<h1>Relation Graph Panorama</h1>
<p>Generated ${escapeHtml(model.generatedAt)} from SQLite relation_edges and relation_coverage. HTML is for human inspection; automation should read SQLite directly.</p>
</header>
<main>
<section>
<h2>Summary</h2>
<div class="stats">
${statCard("refs", model.summary.refs)}
${statCard("edges", model.summary.edges)}
${statCard("active edges", model.summary.activeEdges)}
${statCard("coverage rows", model.summary.coverageRows)}
${statCard("uncovered claims", model.summary.uncoveredClaims)}
${statusCards}
</div>
</section>
<section>
<h2>Coverage</h2>
${coverageRows ? `<table><thead><tr><th>Claim</th><th>Status</th><th>Covering Fact</th><th>Relation Path</th></tr></thead><tbody>${coverageRows}</tbody></table>` : `<div class="empty">No relation coverage rows.</div>`}
</section>
<section>
<h2>Edges</h2>
${edgeRows ? `<table><thead><tr><th>Relation</th><th>Source</th><th>Target</th><th>Type</th><th>State</th><th>Owner</th></tr></thead><tbody>${edgeRows}</tbody></table>` : `<div class="empty">No relation edge rows.</div>`}
</section>
<section>
<h2>Refs</h2>
${refRows ? `<table><thead><tr><th>Ref</th><th>Roles</th></tr></thead><tbody>${refRows}</tbody></table>` : `<div class="empty">No graph refs.</div>`}
</section>
</main>
</body>
</html>
`;
}

function statCard(label, value) {
  return `<div class="stat"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}

function renderCoverageRow(row) {
  const statusClass = row.status === "covered" ? "covered" : "uncovered";
  return [
    "<tr>",
    `<td>${escapeHtml(row.claimRef)}</td>`,
    `<td class="${statusClass}">${escapeHtml(row.status)}</td>`,
    `<td>${escapeHtml(row.coveringFactRef ?? "")}</td>`,
    `<td>${escapeHtml((row.relationPath ?? []).join(" -> "))}</td>`,
    "</tr>"
  ].join("");
}

function renderEdgeRow(edge) {
  return [
    "<tr>",
    `<td>${escapeHtml(edge.relationId)}</td>`,
    `<td>${escapeHtml(edge.sourceRef)}</td>`,
    `<td>${escapeHtml(edge.targetRef)}</td>`,
    `<td>${escapeHtml(edge.relationType)}</td>`,
    `<td>${escapeHtml(edge.state)}</td>`,
    `<td>${escapeHtml(edge.ownerRef)}</td>`,
    "</tr>"
  ].join("");
}

function renderRefRow(row) {
  return `<tr><td>${escapeHtml(row.ref)}</td><td>${escapeHtml(Array.from(row.roles).sort().join(", "))}</td></tr>`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--root" || token === "--projection" || token === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      index += 1;
      if (token === "--root") options.rootDir = value;
      if (token === "--projection") options.projectionPath = value;
      if (token === "--out") options.outputPath = value;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const report = generateGraphPanorama(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`Graph panorama written to ${report.outputPath}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
