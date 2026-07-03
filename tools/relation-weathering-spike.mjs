#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultProjectionPath = ".harness/cache/projections.sqlite";

export function generateRelationWeatheringReport(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const projectionPath = path.resolve(rootDir, options.projectionPath ?? defaultProjectionPath);
  if (!existsSync(projectionPath)) {
    throw new Error(`Relation projection database not found: ${projectionPath}`);
  }

  const { edges, coverageRows } = readRelationProjectionRows(projectionPath);
  const edgeById = new Map(edges.map((edge) => [edge.relationId, edge]));
  const statusCounts = countBy(coverageRows, (row) => row.status || "unknown");
  const staleCandidates = buildStaleCandidates(coverageRows, edgeById);
  const relationGaps = buildRelationGaps(coverageRows, edges, edgeById);

  return {
    projectionPath,
    generatedAt: new Date().toISOString(),
    summary: {
      edgeCount: edges.length,
      coverageRowCount: coverageRows.length,
      statusCounts,
      staleCandidateCount: staleCandidates.length,
      relationGapCount: relationGaps.length
    },
    aggregation: {
      decisions: aggregateByDecision(coverageRows, staleCandidates),
      facts: aggregateByFact(coverageRows, edgeById)
    },
    staleCandidates,
    relationGaps
  };
}

function readRelationProjectionRows(projectionPath) {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const edgeRecords = db.prepare("SELECT row_json FROM relation_edges ORDER BY source_ref, target_ref, relation_id").all();
    const coverageRecords = db.prepare("SELECT row_json FROM relation_coverage ORDER BY claim_ref").all();
    return {
      edges: edgeRecords.map((record) => normalizeEdge(parseRowJson(record.row_json, "relation_edges"))),
      coverageRows: coverageRecords.map((record) => normalizeCoverageRow(parseRowJson(record.row_json, "relation_coverage")))
    };
  } finally {
    db.close();
  }
}

function parseRowJson(rowJson, tableName) {
  try {
    return JSON.parse(rowJson);
  } catch (error) {
    throw new Error(`Invalid row_json in ${tableName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeEdge(row) {
  return {
    relationId: String(row.relationId ?? ""),
    sourceRef: String(row.sourceRef ?? ""),
    targetRef: String(row.targetRef ?? ""),
    relationType: String(row.relationType ?? ""),
    strength: String(row.strength ?? ""),
    state: String(row.state ?? "")
  };
}

function normalizeCoverageRow(row) {
  return {
    decisionRef: String(row.decisionRef ?? ""),
    claimRef: String(row.claimRef ?? ""),
    status: String(row.status ?? "unknown"),
    coveringFactRef: row.coveringFactRef ? String(row.coveringFactRef) : undefined,
    relationPath: Array.isArray(row.relationPath) ? row.relationPath.map(String) : []
  };
}

function buildStaleCandidates(coverageRows, edgeById) {
  return coverageRows
    .map((row) => {
      const reasonCodes = [];
      if (row.status !== "covered") reasonCodes.push("coverage_status_not_covered");
      if (!row.coveringFactRef) reasonCodes.push("missing_covering_fact");
      if (row.status === "covered" && row.relationPath.length === 0) reasonCodes.push("empty_relation_path");
      const missingPathEdges = row.relationPath.filter((relationId) => !edgeById.has(relationId));
      if (missingPathEdges.length > 0) reasonCodes.push("missing_relation_path_edge");
      const pathEdges = row.relationPath.map((relationId) => edgeById.get(relationId)).filter(Boolean);
      if (pathEdges.length > 0 && pathEdges.every((edge) => edge.strength !== "strong")) {
        reasonCodes.push("weak_relation_path");
      }
      if (reasonCodes.length === 0) return null;
      return {
        claimRef: row.claimRef,
        decisionRef: row.decisionRef,
        status: row.status,
        coveringFactRef: row.coveringFactRef,
        relationPath: row.relationPath,
        reasonCodes,
        missingPathEdges
      };
    })
    .filter(Boolean)
    .sort(compareByClaimRef);
}

function buildRelationGaps(coverageRows, edges, edgeById) {
  const gaps = [];
  const coverageRefs = new Set();
  for (const row of coverageRows) {
    if (row.decisionRef) coverageRefs.add(row.decisionRef);
    if (row.claimRef) coverageRefs.add(row.claimRef);
    if (row.coveringFactRef) coverageRefs.add(row.coveringFactRef);
    for (const relationId of row.relationPath) {
      if (!edgeById.has(relationId)) {
        gaps.push({
          code: "coverage_path_missing_edge",
          claimRef: row.claimRef,
          decisionRef: row.decisionRef,
          relationId
        });
      }
    }
  }

  for (const edge of edges) {
    for (const [field, ref] of [["sourceRef", edge.sourceRef], ["targetRef", edge.targetRef]]) {
      if (!isCoverageEndpointRef(ref) || coverageRefs.has(ref)) continue;
      gaps.push({
        code: field === "sourceRef" ? "edge_source_not_in_coverage" : "edge_target_not_in_coverage",
        relationId: edge.relationId,
        ref
      });
    }
  }

  return gaps.sort((a, b) => `${a.code}\0${a.claimRef ?? ""}\0${a.relationId ?? ""}\0${a.ref ?? ""}`.localeCompare(`${b.code}\0${b.claimRef ?? ""}\0${b.relationId ?? ""}\0${b.ref ?? ""}`));
}

function isCoverageEndpointRef(ref) {
  return /^decision\/[^/]+(?:\/[^/]+)?$/u.test(ref) || /^fact\/[^/]+\/[^/]+$/u.test(ref);
}

function aggregateByDecision(coverageRows, staleCandidates) {
  const staleByClaim = new Set(staleCandidates.map((candidate) => candidate.claimRef));
  const decisions = new Map();
  for (const row of coverageRows) {
    const current = decisions.get(row.decisionRef) ?? {
      decisionRef: row.decisionRef,
      coverageRowCount: 0,
      statusCounts: {},
      staleCandidateCount: 0
    };
    current.coverageRowCount += 1;
    current.statusCounts[row.status] = (current.statusCounts[row.status] ?? 0) + 1;
    if (staleByClaim.has(row.claimRef)) current.staleCandidateCount += 1;
    decisions.set(row.decisionRef, current);
  }
  return [...decisions.values()].sort((a, b) => a.decisionRef.localeCompare(b.decisionRef));
}

function aggregateByFact(coverageRows, edgeById) {
  const facts = new Map();
  for (const row of coverageRows) {
    if (!row.coveringFactRef) continue;
    const current = facts.get(row.coveringFactRef) ?? {
      factRef: row.coveringFactRef,
      coveredClaimCount: 0,
      weakPathClaimCount: 0
    };
    current.coveredClaimCount += 1;
    const pathEdges = row.relationPath.map((relationId) => edgeById.get(relationId)).filter(Boolean);
    if (pathEdges.length > 0 && pathEdges.every((edge) => edge.strength !== "strong")) {
      current.weakPathClaimCount += 1;
    }
    facts.set(row.coveringFactRef, current);
  }
  return [...facts.values()].sort((a, b) => a.factRef.localeCompare(b.factRef));
}

function countBy(rows, getKey) {
  const counts = {};
  for (const row of rows) {
    const key = getKey(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function compareByClaimRef(a, b) {
  return `${a.claimRef}\0${a.decisionRef}`.localeCompare(`${b.claimRef}\0${b.decisionRef}`);
}

function parseArgs(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--root" || arg === "--projection" || arg === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--root") options.rootDir = value;
      if (arg === "--projection") options.projectionPath = value;
      if (arg === "--out") options.outPath = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function formatTextReport(report) {
  const lines = [
    "Relation weathering spike report",
    `Projection: ${report.projectionPath}`,
    `Edges: ${report.summary.edgeCount}`,
    `Coverage rows: ${report.summary.coverageRowCount}`,
    `Status counts: ${JSON.stringify(report.summary.statusCounts)}`,
    `Stale candidates: ${report.summary.staleCandidateCount}`,
    `Relation gaps: ${report.summary.relationGapCount}`
  ];
  for (const candidate of report.staleCandidates.slice(0, 20)) {
    lines.push(`- stale ${candidate.claimRef}: ${candidate.reasonCodes.join(", ")}`);
  }
  for (const gap of report.relationGaps.slice(0, 20)) {
    lines.push(`- gap ${gap.code}: ${gap.claimRef ?? gap.relationId ?? gap.ref}`);
  }
  return `${lines.join("\n")}\n`;
}

function printHelp() {
  process.stdout.write([
    "Usage: node tools/relation-weathering-spike.mjs [--root <dir>] [--projection <path>] [--json] [--out <path>]",
    "",
    "Reads relation_edges and relation_coverage from the generated SQLite projection.",
    "Default projection path: .harness/cache/projections.sqlite",
    ""
  ].join("\n"));
}

export function runRelationWeatheringCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const report = generateRelationWeatheringReport(options);
  const body = options.json ? `${JSON.stringify(report, null, 2)}\n` : formatTextReport(report);
  if (options.outPath) {
    const outputPath = path.resolve(options.rootDir ?? process.cwd(), options.outPath);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(body);
  return 0;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  try {
    process.exitCode = runRelationWeatheringCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
