import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { generateRelationWeatheringReport } from "./relation-weathering-spike.mjs";

test("relation weathering spike summarizes coverage and stale candidates from SQLite", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "relation-weathering-"));
  try {
    const projectionPath = path.join(rootDir, "projection.sqlite");
    writeProjectionFixture(projectionPath);

    const report = generateRelationWeatheringReport({ rootDir, projectionPath });

    assert.equal(report.summary.edgeCount, 4);
    assert.equal(report.summary.coverageRowCount, 4);
    assert.deepEqual(report.summary.statusCounts, { covered: 3, uncovered: 1 });
    assert.equal(report.summary.staleCandidateCount, 3);
    assert.equal(report.summary.relationGapCount, 3);
    assert.deepEqual(
      report.staleCandidates.map((candidate) => [candidate.claimRef, candidate.reasonCodes]),
      [
        ["decision/D-1/c2", ["weak_relation_path"]],
        ["decision/D-1/c3", ["missing_relation_path_edge"]],
        ["decision/D-1/c4", ["coverage_status_not_covered", "missing_covering_fact"]]
      ]
    );
    assert.deepEqual(report.aggregation.decisions, [
      {
        decisionRef: "decision/D-1",
        coverageRowCount: 4,
        statusCounts: { covered: 3, uncovered: 1 },
        staleCandidateCount: 3
      }
    ]);
    assert.deepEqual(report.aggregation.facts, [
      { factRef: "fact/T-1/F-1", coveredClaimCount: 1, weakPathClaimCount: 0 },
      { factRef: "fact/T-1/F-2", coveredClaimCount: 1, weakPathClaimCount: 1 },
      { factRef: "fact/T-1/F-3", coveredClaimCount: 1, weakPathClaimCount: 0 }
    ]);
    assert.deepEqual(
      report.relationGaps.map((gap) => gap.code),
      ["coverage_path_missing_edge", "edge_source_not_in_coverage", "edge_target_not_in_coverage"]
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("relation weathering spike reads the projection without mutating it", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "relation-weathering-readonly-"));
  try {
    const projectionPath = path.join(rootDir, "projection.sqlite");
    writeProjectionFixture(projectionPath);
    const beforeBytes = readFileSync(projectionPath);
    const beforeStat = statSync(projectionPath);

    generateRelationWeatheringReport({ rootDir, projectionPath });

    const afterStat = statSync(projectionPath);
    assert.deepEqual(readFileSync(projectionPath), beforeBytes);
    assert.equal(afterStat.size, beforeStat.size);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("relation weathering spike fails closed when the projection is absent", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "relation-weathering-missing-"));
  try {
    assert.throws(
      () => generateRelationWeatheringReport({ rootDir, projectionPath: "missing.sqlite" }),
      /Relation projection database not found/u
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

function writeProjectionFixture(projectionPath) {
  const db = new DatabaseSync(projectionPath);
  try {
    db.exec([
      [
        "CREATE TABLE relation_edges (",
        "  relation_id TEXT PRIMARY KEY,",
        "  source_ref TEXT NOT NULL,",
        "  target_ref TEXT NOT NULL,",
        "  relation_type TEXT NOT NULL,",
        "  direction TEXT NOT NULL,",
        "  state TEXT NOT NULL,",
        "  row_json TEXT NOT NULL",
        ")"
      ].join("\n"),
      [
        "CREATE TABLE relation_coverage (",
        "  claim_ref TEXT PRIMARY KEY,",
        "  decision_ref TEXT NOT NULL,",
        "  status TEXT NOT NULL,",
        "  covering_fact_ref TEXT,",
        "  row_json TEXT NOT NULL",
        ")"
      ].join("\n")
    ].join(";\n"));
    const insertEdge = db.prepare([
      "INSERT INTO relation_edges",
      "(relation_id, source_ref, target_ref, relation_type, direction, state, row_json)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" "));
    for (const row of [
      edge("R-strong", "decision/D-1/c1", "fact/T-1/F-1", "strong"),
      edge("R-weak", "decision/D-1/c2", "fact/T-1/F-2", "weak"),
      edge("R-orphan-source", "decision/D-1/c-missing", "fact/T-1/F-1", "strong"),
      edge("R-orphan-target", "decision/D-1/c1", "fact/T-1/F-missing", "strong")
    ]) {
      insertEdge.run(row.relationId, row.sourceRef, row.targetRef, row.relationType, "forward", row.state, JSON.stringify(row));
    }
    const insertCoverage = db.prepare([
      "INSERT INTO relation_coverage",
      "(claim_ref, decision_ref, status, covering_fact_ref, row_json)",
      "VALUES (?, ?, ?, ?, ?)"
    ].join(" "));
    for (const row of [
      coverage("decision/D-1/c1", "covered", "fact/T-1/F-1", ["R-strong"]),
      coverage("decision/D-1/c2", "covered", "fact/T-1/F-2", ["R-weak"]),
      coverage("decision/D-1/c3", "covered", "fact/T-1/F-3", ["R-missing"]),
      coverage("decision/D-1/c4", "uncovered", undefined, [])
    ]) {
      insertCoverage.run(row.claimRef, row.decisionRef, row.status, row.coveringFactRef ?? null, JSON.stringify(row));
    }
  } finally {
    db.close();
  }
}

function edge(relationId, sourceRef, targetRef, strength) {
  return {
    relationId,
    sourceRef,
    targetRef,
    relationType: "supports",
    direction: "forward",
    strength,
    state: "active"
  };
}

function coverage(claimRef, status, coveringFactRef, relationPath) {
  return {
    decisionRef: "decision/D-1",
    claimRef,
    status,
    coveringFactRef,
    relationPath
  };
}
