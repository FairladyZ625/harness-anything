import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { readEntityCascadeImpact } from "../../../kernel/src/index.ts";
import { readRelationGraphProjection } from "../../../kernel/src/index.ts";

const defaultProjectionPath = ".harness/cache/projections.sqlite";
const defaultOutputPath = ".harness/generated/graph-panorama/index.html";

interface GenerateGraphPanoramaInput {
  readonly rootDir?: string;
  readonly projectionPath?: string;
  readonly outputPath?: string;
  readonly focus?: string;
}

interface GraphRows {
  readonly relationEdges: ReadonlyArray<Record<string, any>>;
  readonly coverageRows: ReadonlyArray<Record<string, any>>;
}

export function generateGraphPanorama(input: GenerateGraphPanoramaInput = {}): Record<string, any> {
  const rootDir = path.resolve(input.rootDir ?? process.cwd());
  const projectionPath = path.resolve(rootDir, input.projectionPath ?? defaultProjectionPath);
  const outputPath = path.resolve(rootDir, input.outputPath ?? defaultOutputPath);
  const graphRows = readFreshGraphRows({ rootDir, projectionPath, usesDefaultProjection: !input.projectionPath });
  const projectedEntities = readProjectedEntities(projectionPath);
  const cascade = input.focus ? readEntityCascadeImpact({ rootDir, projectionPath, entityRef: input.focus }) : undefined;
  const model = buildPanoramaModel(graphRows, projectedEntities, { focus: input.focus, cascade });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, renderPanoramaHtml(model), "utf8");
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

function readFreshGraphRows(input: { readonly rootDir: string; readonly projectionPath: string; readonly usesDefaultProjection: boolean }): GraphRows {
  if (!existsSync(input.projectionPath)) {
    throw new Error(`Projection database not found: ${input.projectionPath}`);
  }
  if (!input.usesDefaultProjection) return readGraphRows(input.projectionPath);
  const projection = readRelationGraphProjection({ rootDir: input.rootDir, projectionPath: input.projectionPath });
  return {
    relationEdges: projection.edges,
    coverageRows: projection.coverageRows
  };
}

function readGraphRows(projectionPath: string): GraphRows {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const relationEdges = db
      .prepare("SELECT row_json FROM relation_edges ORDER BY source_ref, target_ref, relation_id")
      .all()
      .map((record) => JSON.parse(String((record as { row_json: unknown }).row_json)) as Record<string, any>);
    const coverageRows = db
      .prepare("SELECT row_json FROM relation_coverage ORDER BY claim_ref")
      .all()
      .map((record) => JSON.parse(String((record as { row_json: unknown }).row_json)) as Record<string, any>);
    return { relationEdges, coverageRows };
  } finally {
    db.close();
  }
}

function readProjectedEntities(projectionPath: string): ReadonlyArray<Record<string, string>> {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const tasks = safeAll(db, "SELECT task_id, title, canonical_status AS state FROM task_projection ORDER BY task_id")
      .map((row) => ({ kind: "task", ref: `task/${String(row.task_id ?? "")}`, title: String(row.title ?? ""), state: String(row.state ?? "") }));
    const decisions = safeAll(db, "SELECT decision_id, title, state FROM decision_projection ORDER BY decision_id")
      .map((row) => ({ kind: "decision", ref: `decision/${String(row.decision_id ?? "")}`, title: String(row.title ?? ""), state: String(row.state ?? "") }));
    return [...tasks, ...decisions];
  } finally {
    db.close();
  }
}

function safeAll(db: DatabaseSync, sql: string): ReadonlyArray<Record<string, unknown>> {
  try {
    return db.prepare(sql).all() as ReadonlyArray<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function buildPanoramaModel(rows: GraphRows, projectedEntities: ReadonlyArray<Record<string, string>>, options: { readonly focus?: string; readonly cascade?: any }): Record<string, any> {
  const refs = new Map<string, { readonly ref: string; readonly roles: Set<string> }>();
  for (const edge of rows.relationEdges) {
    addRef(refs, String(edge.sourceRef), "source");
    addRef(refs, String(edge.targetRef), "target");
  }
  for (const row of rows.coverageRows) {
    addRef(refs, String(row.decisionRef), "decision");
    addRef(refs, String(row.claimRef), "claim");
    if (row.coveringFactRef) addRef(refs, String(row.coveringFactRef), "fact");
  }

  const statusCounts: Record<string, number> = {};
  for (const row of rows.coverageRows) {
    const status = String(row.status ?? "unknown");
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  const uncoveredClaims = rows.coverageRows.filter((row) => row.status !== "covered");
  const activeEdges = rows.relationEdges.filter((edge) => edge.state === "active");
  const inactiveEdges = rows.relationEdges.filter((edge) => edge.state !== "active");
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
    relationEdges: rows.relationEdges,
    coverageRows: rows.coverageRows,
    uncoveredClaims,
    activeEdges,
    inactiveEdges,
    statusCounts,
    focus,
    islands,
    summary: {
      refs: refs.size,
      edges: rows.relationEdges.length,
      activeEdges: activeEdges.length,
      inactiveEdges: inactiveEdges.length,
      coverageRows: rows.coverageRows.length,
      uncoveredClaims: uncoveredClaims.length,
      islands: islands.length,
      ...(focus ? { focusIncoming: focus.incoming.length, focusOutgoing: focus.outgoing.length, focusImpactedRefs: focus.impactedRefs.length } : {})
    }
  };
}

function addRef(refs: Map<string, { readonly ref: string; readonly roles: Set<string> }>, ref: string, role: string): void {
  const existing = refs.get(ref);
  if (existing) {
    existing.roles.add(role);
    return;
  }
  refs.set(ref, { ref, roles: new Set([role]) });
}

function renderPanoramaHtml(model: Record<string, any>): string {
  const statusCards = Object.entries(model.statusCounts as Record<string, number>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => statCard(status, count))
    .join("");
  const edgeRows = (model.relationEdges as ReadonlyArray<Record<string, any>>).map(renderEdgeRow).join("");
  const coverageRows = (model.coverageRows as ReadonlyArray<Record<string, any>>).map(renderCoverageRow).join("");
  const refRows = (model.refs as ReadonlyArray<{ readonly ref: string; readonly roles: Set<string> }>).map(renderRefRow).join("");
  const islandRows = (model.islands as ReadonlyArray<Record<string, string>>).map(renderIslandRow).join("");
  const focusRows = model.focus ? renderFocus(model.focus as Record<string, any>) : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relation Graph Panorama</title>
<style>
body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #fff; }
header { padding: 28px 32px 20px; border-bottom: 1px solid #d8dee8; }
main { padding: 24px 32px 40px; display: grid; gap: 24px; }
h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; letter-spacing: 0; }
h2 { margin: 0 0 12px; font-size: 18px; line-height: 1.3; letter-spacing: 0; }
p { margin: 0; color: #5b6776; line-height: 1.5; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat { border: 1px solid #d8dee8; border-radius: 8px; padding: 12px; background: #f7f9fc; }
.stat strong { display: block; font-size: 24px; line-height: 1.1; }
.stat span { color: #5b6776; font-size: 13px; }
section { display: grid; gap: 10px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px; }
th, td { border: 1px solid #d8dee8; padding: 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: #f7f9fc; color: #344054; }
.covered { color: #027a48; font-weight: 700; }
.uncovered { color: #b42318; font-weight: 700; }
.empty { border: 1px dashed #d8dee8; border-radius: 8px; padding: 14px; color: #5b6776; }
</style>
</head>
<body>
<header>
<h1>Relation Graph Panorama</h1>
<p>Generated ${escapeHtml(String(model.generatedAt))} from SQLite relation_edges and relation_coverage. HTML is for human inspection; automation should read SQLite directly.</p>
</header>
<main>
<section><h2>Summary</h2><div class="stats">
${statCard("refs", model.summary.refs)}
${statCard("edges", model.summary.edges)}
${statCard("active edges", model.summary.activeEdges)}
${statCard("coverage rows", model.summary.coverageRows)}
${statCard("uncovered claims", model.summary.uncoveredClaims)}
${statCard("islands", model.summary.islands)}
${statusCards}
</div></section>
${model.focus ? `<section><h2>Focused Cascade</h2>${focusRows}</section>` : ""}
<section><h2>Island Audit</h2>${islandRows ? `<table><thead><tr><th>Entity</th><th>Kind</th><th>State</th><th>Title</th></tr></thead><tbody>${islandRows}</tbody></table>` : `<div class="empty">No projected task or decision islands.</div>`}</section>
<section><h2>Coverage</h2>${coverageRows ? `<table><thead><tr><th>Claim</th><th>Status</th><th>Covering Fact</th><th>Relation Path</th></tr></thead><tbody>${coverageRows}</tbody></table>` : `<div class="empty">No relation coverage rows.</div>`}</section>
<section><h2>Edges</h2>${edgeRows ? `<table><thead><tr><th>Relation</th><th>Source</th><th>Target</th><th>Type</th><th>State</th><th>Owner</th></tr></thead><tbody>${edgeRows}</tbody></table>` : `<div class="empty">No relation edge rows.</div>`}</section>
<section><h2>Refs</h2>${refRows ? `<table><thead><tr><th>Ref</th><th>Roles</th></tr></thead><tbody>${refRows}</tbody></table>` : `<div class="empty">No graph refs.</div>`}</section>
</main>
</body>
</html>
`;
}

function statCard(label: string, value: unknown): string {
  return `<div class="stat"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}

function renderCoverageRow(row: Record<string, any>): string {
  const statusClass = row.status === "covered" ? "covered" : "uncovered";
  return `<tr><td>${escapeHtml(String(row.claimRef ?? ""))}</td><td class="${statusClass}">${escapeHtml(String(row.status ?? ""))}</td><td>${escapeHtml(String(row.coveringFactRef ?? ""))}</td><td>${escapeHtml((row.relationPath ?? []).join(" -> "))}</td></tr>`;
}

function renderEdgeRow(edge: Record<string, any>): string {
  return `<tr><td>${escapeHtml(String(edge.relationId ?? ""))}</td><td>${escapeHtml(String(edge.sourceRef ?? ""))}</td><td>${escapeHtml(String(edge.targetRef ?? ""))}</td><td>${escapeHtml(String(edge.relationType ?? ""))}</td><td>${escapeHtml(String(edge.state ?? ""))}</td><td>${escapeHtml(String(edge.ownerRef ?? ""))}</td></tr>`;
}

function renderRefRow(row: { readonly ref: string; readonly roles: Set<string> }): string {
  return `<tr><td>${escapeHtml(row.ref)}</td><td>${escapeHtml(Array.from(row.roles).sort().join(", "))}</td></tr>`;
}

function renderIslandRow(row: Record<string, string>): string {
  return `<tr><td>${escapeHtml(row.ref)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(row.state)}</td><td>${escapeHtml(row.title)}</td></tr>`;
}

function renderFocus(focus: Record<string, any>): string {
  const incoming = (focus.incoming as ReadonlyArray<Record<string, any>>).map(renderEdgeRow).join("");
  const outgoing = (focus.outgoing as ReadonlyArray<Record<string, any>>).map(renderEdgeRow).join("");
  return [
    `<p>Focus: <strong>${escapeHtml(String(focus.entityRef))}</strong>. Impacted refs: ${escapeHtml((focus.impactedRefs as ReadonlyArray<string>).join(", ") || "none")}.</p>`,
    "<h2>Incoming</h2>",
    incoming ? `<table><thead><tr><th>Relation</th><th>Source</th><th>Target</th><th>Type</th><th>State</th><th>Owner</th></tr></thead><tbody>${incoming}</tbody></table>` : `<div class="empty">No active incoming edges.</div>`,
    "<h2>Outgoing</h2>",
    outgoing ? `<table><thead><tr><th>Relation</th><th>Source</th><th>Target</th><th>Type</th><th>State</th><th>Owner</th></tr></thead><tbody>${outgoing}</tbody></table>` : `<div class="empty">No active outgoing edges.</div>`
  ].join("\n");
}

function collectIslands(projectedEntities: ReadonlyArray<Record<string, string>>, activeEdges: ReadonlyArray<Record<string, any>>): ReadonlyArray<Record<string, string>> {
  const incident = new Set<string>();
  for (const edge of activeEdges) {
    incident.add(baseEntityRef(String(edge.sourceRef ?? "")));
    incident.add(baseEntityRef(String(edge.targetRef ?? "")));
  }
  return projectedEntities
    .filter((entity) => !incident.has(entity.ref))
    .sort((left, right) => `${left.kind}\0${left.ref}`.localeCompare(`${right.kind}\0${right.ref}`));
}

function baseEntityRef(ref: string): string {
  const parts = ref.split("/");
  if (parts[0] === "decision" && parts[1]) return `decision/${parts[1]}`;
  if (parts[0] === "task" && parts[1]) return `task/${parts[1]}`;
  if (parts[0] === "fact" && parts[1] && parts[2]) return `fact/${parts[1]}/${parts[2]}`;
  return ref;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
