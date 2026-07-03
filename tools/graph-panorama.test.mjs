import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { generateGraphPanorama } from "./graph-panorama.mjs";

test("graph panorama reads relation graph SQLite and writes self-contained HTML", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "graph-panorama-"));
  const projectionPath = path.join(rootDir, "projection.sqlite");
  const outputPath = path.join(rootDir, "graph-panorama.html");
  writeProjectionFixture(projectionPath);

  const report = generateGraphPanorama({ rootDir, projectionPath, outputPath });
  const html = readFileSync(outputPath, "utf8");

  assert.equal(report.summary.edges, 1);
  assert.equal(report.summary.coverageRows, 2);
  assert.equal(report.summary.uncoveredClaims, 1);
  assert.equal(report.statusCounts.covered, 1);
  assert.equal(report.statusCounts.uncovered, 1);
  assert.match(html, /Relation Graph Panorama/u);
  assert.match(html, /relation-1/u);
  assert.match(html, /decision\/dec_M4\/C2/u);
  assert.doesNotMatch(html, /mermaid|digraph/iu);
});

test("graph panorama fails closed when the projection database is absent", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "graph-panorama-missing-"));

  assert.throws(
    () => generateGraphPanorama({ rootDir, projectionPath: "missing.sqlite" }),
    /Projection database not found/u
  );
});

function writeProjectionFixture(projectionPath) {
  const db = new DatabaseSync(projectionPath);
  try {
    db.exec([
      "CREATE TABLE relation_edges (relation_id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, target_ref TEXT NOT NULL, relation_type TEXT NOT NULL, direction TEXT NOT NULL, state TEXT NOT NULL, row_json TEXT NOT NULL)",
      "CREATE TABLE relation_coverage (claim_ref TEXT PRIMARY KEY, decision_ref TEXT NOT NULL, status TEXT NOT NULL, covering_fact_ref TEXT, row_json TEXT NOT NULL)"
    ].join(";\n"));
    const edge = {
      relationId: "relation-1",
      sourceRef: "decision/dec_M4/C1",
      targetRef: "fact/task-m4/F-12345678",
      relationType: "supports",
      direction: "forward",
      strength: "strong",
      origin: "authored",
      state: "active",
      rationale: "Fixture edge",
      ownerRef: "decision/dec_M4",
      sourcePath: "context/decisions/dec_M4.md",
      recordIndex: 0
    };
    const covered = {
      decisionRef: "decision/dec_M4",
      claimRef: "decision/dec_M4/C1",
      status: "covered",
      coveringFactRef: "fact/task-m4/F-12345678",
      relationPath: ["relation-1"]
    };
    const uncovered = {
      decisionRef: "decision/dec_M4",
      claimRef: "decision/dec_M4/C2",
      status: "uncovered",
      relationPath: []
    };
    db.prepare([
      "INSERT INTO relation_edges",
      "(relation_id, source_ref, target_ref, relation_type, direction, state, row_json)",
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")).run(
      edge.relationId,
      edge.sourceRef,
      edge.targetRef,
      edge.relationType,
      edge.direction,
      edge.state,
      JSON.stringify(edge)
    );
    const insertCoverage = db.prepare([
      "INSERT INTO relation_coverage",
      "(claim_ref, decision_ref, status, covering_fact_ref, row_json)",
      "VALUES (?, ?, ?, ?, ?)"
    ].join(" "));
    insertCoverage.run(covered.claimRef, covered.decisionRef, covered.status, covered.coveringFactRef, JSON.stringify(covered));
    insertCoverage.run(uncovered.claimRef, uncovered.decisionRef, uncovered.status, null, JSON.stringify(uncovered));
  } finally {
    db.close();
  }
}
