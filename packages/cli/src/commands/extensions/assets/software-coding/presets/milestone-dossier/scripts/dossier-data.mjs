#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const contextPath = process.env.HARNESS_SCRIPT_CONTEXT ?? process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_SCRIPT_CONTEXT or HARNESS_PRESET_CONTEXT is required");

const context = JSON.parse(readFileSync(contextPath, "utf8"));
const paths = context.paths ?? {};
const inputs = context.inputs ?? {};
const outputRoot = context.outputRoot;
const coordinationTaskId = inputs.coordinationTaskId && inputs.coordinationTaskId !== "{{taskId}}"
  ? inputs.coordinationTaskId
  : context.taskId;
const decisionId = inputs.decisionId || undefined;

if (!outputRoot) throw new Error("context.outputRoot is required");
if (!coordinationTaskId) throw new Error("coordinationTaskId input or task context is required");

const artifactsDir = path.join(outputRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const projectionPath = path.join(paths.localRoot ?? ".harness", "cache", "projections.sqlite");
if (!existsSync(projectionPath)) {
  throw new Error(`Relation graph projection database not found: ${projectionPath}`);
}

const projection = readProjection(projectionPath);
const focusDecisionRef = decisionId ? `decision/${decisionId}` : undefined;
const selectedCoverage = focusDecisionRef
  ? projection.coverageRows.filter((row) => row.decisionRef === focusDecisionRef)
  : projection.coverageRows;
const selectedDecisionRefs = new Set(selectedCoverage.map((row) => row.decisionRef));
if (focusDecisionRef) selectedDecisionRefs.add(focusDecisionRef);

const relationIds = new Set(selectedCoverage.flatMap((row) => Array.isArray(row.relationPath) ? row.relationPath : []));
const selectedEdges = projection.relationEdges.filter((edge) =>
  relationIds.has(edge.relationId) ||
  selectedDecisionRefs.has(baseDecisionRef(edge.sourceRef)) ||
  selectedDecisionRefs.has(baseDecisionRef(edge.targetRef))
);

const selectedRefs = new Set();
for (const row of selectedCoverage) {
  selectedRefs.add(row.decisionRef);
  selectedRefs.add(row.claimRef);
  if (row.coveringFactRef) selectedRefs.add(row.coveringFactRef);
}
for (const edge of selectedEdges) {
  selectedRefs.add(edge.sourceRef);
  selectedRefs.add(edge.targetRef);
  selectedRefs.add(edge.ownerRef);
}

const tasks = projection.tasks.filter((task) => selectedRefs.has(`task/${task.taskId}`));
const decisions = projection.decisions.filter((decision) => selectedDecisionRefs.has(`decision/${decision.decisionId}`));
const facts = projection.factAnchors.filter((fact) => selectedRefs.has(fact.factRef));

const data = {
  schema: "milestone-dossier-data/v1",
  generatedAt: new Date().toISOString(),
  presetId: context.presetId ?? "milestone-dossier",
  entrypoint: context.entrypoint ?? "gather",
  coordinationTaskId,
  decisionId: decisionId ?? null,
  output: {
    dossierHtml: "artifacts/dossier.html",
    dossierScaffoldHtml: "artifacts/dossier.scaffold.html",
    dataJson: "artifacts/dossier.data.json"
  },
  projection: {
    path: projectionPath,
    tables: ["task_projection", "decision_projection", "relation_edges", "relation_coverage", "task_fact_anchors"]
  },
  summary: {
    decisions: decisions.length,
    tasks: tasks.length,
    facts: facts.length,
    relationEdges: selectedEdges.length,
    coverageRows: selectedCoverage.length,
    uncoveredClaims: selectedCoverage.filter((row) => row.status !== "covered").length
  },
  decisions,
  tasks,
  facts,
  relationEdges: selectedEdges,
  coverageRows: selectedCoverage,
  provenanceRefs: [...selectedRefs].sort()
};

const dataPath = path.join(artifactsDir, "dossier.data.json");
writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
  schema: "script-result/v1",
  ok: true,
  rows: data.summary.coverageRows,
  report: {
    schema: "milestone-dossier-gather-report/v1",
    coordinationTaskId,
    decisionId: decisionId ?? null,
    dataPath: path.relative(paths.rootDir ?? process.cwd(), dataPath).split(path.sep).join("/"),
    summary: data.summary
  },
  produced: ["artifacts/dossier.data.json"]
}, null, 2)}\n`, "utf8");

function readProjection(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return {
      tasks: safeAll(db, "SELECT task_id, title, canonical_status, coordination_status, source_path, vertical, preset, profile FROM task_projection ORDER BY task_id")
        .map((row) => ({
          taskId: String(row.task_id ?? ""),
          title: String(row.title ?? ""),
          canonicalStatus: String(row.canonical_status ?? ""),
          coordinationStatus: String(row.coordination_status ?? ""),
          sourcePath: String(row.source_path ?? ""),
          vertical: nullableString(row.vertical),
          preset: nullableString(row.preset),
          profile: nullableString(row.profile)
        })),
      decisions: safeAll(db, "SELECT decision_id, title, state, question, path, chosen_json, rejected_json, decided_at FROM decision_projection ORDER BY decision_id")
        .map((row) => ({
          decisionId: String(row.decision_id ?? ""),
          title: String(row.title ?? ""),
          state: String(row.state ?? ""),
          question: String(row.question ?? ""),
          path: String(row.path ?? ""),
          chosen: parseJson(row.chosen_json, []),
          rejected: parseJson(row.rejected_json, []),
          decidedAt: nullableString(row.decided_at)
        })),
      relationEdges: safeJsonRows(db, "SELECT row_json FROM relation_edges ORDER BY source_ref, target_ref, relation_id"),
      coverageRows: safeJsonRows(db, "SELECT row_json FROM relation_coverage ORDER BY claim_ref"),
      factAnchors: safeJsonRows(db, "SELECT row_json FROM task_fact_anchors ORDER BY fact_ref")
    };
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

function safeJsonRows(db, sql) {
  return safeAll(db, sql).map((row) => parseJson(row.row_json, {}));
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function nullableString(value) {
  return value === null || value === undefined ? null : String(value);
}

function baseDecisionRef(ref) {
  const match = /^decision\/[A-Za-z0-9_-]+/u.exec(String(ref ?? ""));
  return match ? match[0] : "";
}
