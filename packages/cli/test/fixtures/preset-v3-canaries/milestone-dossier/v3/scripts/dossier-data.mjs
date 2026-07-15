#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const context = readContext();
const projection = readCapability("relation-graph");
const coordinationTaskId = context.inputs.coordinationTaskId;
const decisionId = context.inputs.decisionId || undefined;
const decisions = projection.decisions;
const tasks = projection.tasks;
const facts = projection.facts;
const relationEdges = projection.relationEdges;
const coverageRows = projection.coverageRows;
const data = {
  schema: "milestone-dossier-data/v1",
  generatedAt: new Date().toISOString(),
  presetId: context.preset.id,
  entrypoint: context.preset.entrypoint,
  coordinationTaskId,
  decisionId: decisionId ?? null,
  output: {
    dossierHtml: "artifacts/dossier.html",
    dossierScaffoldHtml: "artifacts/dossier.scaffold.html",
    dataJson: "artifacts/dossier.data.json"
  },
  projection: {
    path: "capability://relation-graph/v1/dossier",
    tables: ["task_projection", "decision_projection", "relation_edges", "relation_coverage", "task_fact_anchors"]
  },
  summary: {
    decisions: decisions.length,
    tasks: tasks.length,
    facts: facts.length,
    relationEdges: relationEdges.length,
    coverageRows: coverageRows.length,
    uncoveredClaims: coverageRows.filter((row) => row.status !== "covered").length
  },
  decisions,
  tasks,
  facts,
  relationEdges,
  coverageRows,
  provenanceRefs: projection.provenanceRefs
};
const dataRepresentation = outputRepresentation("milestone-dossier-data", "application/json");
writeFileSync(dataRepresentation.path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
writeResult({
  schema: "script-result/v1",
  ok: true,
  rows: data.summary.coverageRows,
  report: {
    schema: "milestone-dossier-gather-report/v1",
    coordinationTaskId,
    decisionId: decisionId ?? null,
    dataPath: dataRepresentation.logicalPath,
    summary: data.summary
  },
  produced: ["milestone-dossier-data"]
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

function outputRepresentation(id, mediaType) {
  const writer = context.capabilities.writes["task-artifacts"]?.[0];
  const representation = writer?.artifacts?.[id]?.representations?.find((entry) => entry.mediaType === mediaType);
  if (!representation) throw new Error(`missing ${id} ${mediaType} writer`);
  return representation;
}

function writeResult(value) {
  writeFileSync(context.result.path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
