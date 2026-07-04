#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import process from "node:process";
import { readEntityCascadeImpact } from "../packages/kernel/src/entity/disposition.ts";
import { readRelationGraphProjection } from "../packages/kernel/src/projection/sqlite-task-projection.ts";

const defaultProjectionPath = ".harness/cache/projections.sqlite";
const defaultOutputPath = ".harness/generated/graph-panorama/index.html";

export function generateGraphPanorama(input = {}) {
  const rootDir = path.resolve(input.rootDir ?? process.cwd());
  const projectionPath = path.resolve(rootDir, input.projectionPath ?? defaultProjectionPath);
  const outputPath = path.resolve(rootDir, input.outputPath ?? defaultOutputPath);
  const graphRows = readFreshGraphRows({ rootDir, projectionPath, usesDefaultProjection: !input.projectionPath });
  const projectedEntities = readProjectedEntities(projectionPath);
  const cascade = input.focus ? readEntityCascadeImpact({ rootDir, projectionPath, entityRef: input.focus }) : undefined;
  const model = buildPanoramaModel(graphRows, projectedEntities, { focus: input.focus, cascade });
  const html = renderPanoramaHtml(model);

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html);
  return {
    schema: "graph-panorama-report/v1",
    outputPath,
    projectionPath,
    summary: model.summary,
    statusCounts: model.statusCounts,
    focus: model.focus,
    islands: model.islands
  };
}

function readFreshGraphRows({ rootDir, projectionPath, usesDefaultProjection }) {
  if (!existsSync(projectionPath)) {
    throw new Error(`Projection database not found: ${projectionPath}`);
  }
  if (!usesDefaultProjection) return readGraphRows(projectionPath);
  const projection = readRelationGraphProjection({ rootDir, projectionPath });
  return {
    relationEdges: projection.edges,
    coverageRows: projection.coverageRows
  };
}

function readGraphRows(projectionPath) {
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

function readProjectedEntities(projectionPath) {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const tasks = safeAll(db, "SELECT task_id, title, canonical_status AS state FROM task_projection ORDER BY task_id")
      .map((row) => ({ kind: "task", ref: `task/${row.task_id}`, title: String(row.title ?? ""), state: String(row.state ?? "") }));
    const decisions = safeAll(db, "SELECT decision_id, title, state FROM decision_projection ORDER BY decision_id")
      .map((row) => ({ kind: "decision", ref: `decision/${row.decision_id}`, title: String(row.title ?? ""), state: String(row.state ?? "") }));
    return [...tasks, ...decisions];
  } finally {
    db.close();
  }
}

function safeAll(db, sql) {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
}

function buildPanoramaModel({ relationEdges, coverageRows }, projectedEntities, options = {}) {
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
  const islands = collectIslands(projectedEntities, activeEdges);
  const focus = options.focus ? {
    entityRef: options.focus,
    incoming: options.cascade?.incoming ?? [],
    outgoing: options.cascade?.outgoing ?? [],
    impactedRefs: options.cascade?.impactedRefs ?? []
  } : undefined;
  return {
    generatedAt: new Date().toISOString(),
    refs: Array.from(refs.values()).sort((left, right) => left.ref.localeCompare(right.ref)),
    relationEdges,
    coverageRows,
    uncoveredClaims,
    activeEdges,
    inactiveEdges,
    statusCounts,
    focus,
    islands,
    summary: {
      refs: refs.size,
      edges: relationEdges.length,
      activeEdges: activeEdges.length,
      inactiveEdges: inactiveEdges.length,
      coverageRows: coverageRows.length,
      uncoveredClaims: uncoveredClaims.length,
      islands: islands.length,
      ...(focus ? { focusIncoming: focus.incoming.length, focusOutgoing: focus.outgoing.length, focusImpactedRefs: focus.impactedRefs.length } : {})
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
  const islandRows = model.islands.map(renderIslandRow).join("");
  const focusRows = model.focus ? renderFocus(model.focus) : "";

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
${statCard("islands", model.summary.islands)}
${statusCards}
</div>
</section>
${model.focus ? `<section>
<h2>Focused Cascade</h2>
${focusRows}
</section>` : ""}
<section>
<h2>Island Audit</h2>
${islandRows ? `<table><thead><tr><th>Entity</th><th>Kind</th><th>State</th><th>Title</th></tr></thead><tbody>${islandRows}</tbody></table>` : `<div class="empty">No projected task or decision islands.</div>`}
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

function renderIslandRow(row) {
  return `<tr><td>${escapeHtml(row.ref)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(row.state)}</td><td>${escapeHtml(row.title)}</td></tr>`;
}

function renderFocus(focus) {
  const incoming = focus.incoming.map(renderEdgeRow).join("");
  const outgoing = focus.outgoing.map(renderEdgeRow).join("");
  return [
    `<p>Focus: <strong>${escapeHtml(focus.entityRef)}</strong>. Impacted refs: ${escapeHtml(focus.impactedRefs.join(", ") || "none")}.</p>`,
    `<h2>Incoming</h2>`,
    incoming ? `<table><thead><tr><th>Relation</th><th>Source</th><th>Target</th><th>Type</th><th>State</th><th>Owner</th></tr></thead><tbody>${incoming}</tbody></table>` : `<div class="empty">No active incoming edges.</div>`,
    `<h2>Outgoing</h2>`,
    outgoing ? `<table><thead><tr><th>Relation</th><th>Source</th><th>Target</th><th>Type</th><th>State</th><th>Owner</th></tr></thead><tbody>${outgoing}</tbody></table>` : `<div class="empty">No active outgoing edges.</div>`
  ].join("\n");
}

function collectIslands(projectedEntities, activeEdges) {
  const incident = new Set();
  for (const edge of activeEdges) {
    incident.add(baseEntityRef(edge.sourceRef));
    incident.add(baseEntityRef(edge.targetRef));
  }
  return projectedEntities
    .filter((entity) => !incident.has(entity.ref))
    .sort((left, right) => `${left.kind}\0${left.ref}`.localeCompare(`${right.kind}\0${right.ref}`));
}

function baseEntityRef(ref) {
  const parts = String(ref).split("/");
  if (parts[0] === "decision" && parts[1]) return `decision/${parts[1]}`;
  if (parts[0] === "task" && parts[1]) return `task/${parts[1]}`;
  if (parts[0] === "fact" && parts[1] && parts[2]) return `fact/${parts[1]}/${parts[2]}`;
  return String(ref);
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
    if (token === "--root" || token === "--projection" || token === "--out" || token === "--focus") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      index += 1;
      if (token === "--root") options.rootDir = value;
      if (token === "--projection") options.projectionPath = value;
      if (token === "--out") options.outputPath = value;
      if (token === "--focus") options.focus = value;
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
