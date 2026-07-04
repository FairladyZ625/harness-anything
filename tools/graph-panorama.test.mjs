import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { rebuildTaskProjection } from "../packages/kernel/src/projection/sqlite-task-projection.ts";
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
  assert.equal(report.summary.islands, 2);
  assert.equal(report.statusCounts.covered, 1);
  assert.equal(report.statusCounts.uncovered, 1);
  assert.match(html, /Relation Graph Panorama/u);
  assert.match(html, /Island Audit/u);
  assert.match(html, /relation-1/u);
  assert.match(html, /decision\/dec_M4\/C2/u);
  assert.match(html, /task\/task-island/u);
  assert.doesNotMatch(html, /mermaid|digraph/iu);
});

test("graph panorama embeds F5 cascade impact for a focused entity", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "graph-panorama-focus-"));
  const outputPath = path.join(rootDir, ".harness/generated/graph-panorama/index.html");
  writeTask(rootDir, "task-one", "Task One");
  writeDecision(rootDir, "dec_OLD", []);
  writeDecision(rootDir, "dec_NEW", [
    "- {relation_id: rel_3c299a8958c5c2c1, source: decision/dec_NEW/CH1, target: decision/dec_OLD, type: supersedes, strength: strong, direction: directed, origin: declared, rationale: \"focus cascade\", state: active}"
  ]);
  rebuildTaskProjection({ rootDir });

  const report = generateGraphPanorama({ rootDir, outputPath, focus: "decision/dec_NEW" });
  const html = readFileSync(outputPath, "utf8");

  assert.equal(report.focus.entityRef, "decision/dec_NEW");
  assert.equal(report.focus.outgoing.length, 1);
  assert.deepEqual(report.focus.impactedRefs, ["decision/dec_OLD"]);
  assert.match(html, /Focused Cascade/u);
  assert.match(html, /rel_3c299a8958c5c2c1/u);
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
      "CREATE TABLE relation_coverage (claim_ref TEXT PRIMARY KEY, decision_ref TEXT NOT NULL, status TEXT NOT NULL, covering_fact_ref TEXT, row_json TEXT NOT NULL)",
      "CREATE TABLE task_projection (task_id TEXT PRIMARY KEY, title TEXT NOT NULL, canonical_status TEXT NOT NULL)",
      "CREATE TABLE decision_projection (decision_id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL)"
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
    db.prepare("INSERT INTO task_projection (task_id, title, canonical_status) VALUES (?, ?, ?)").run("task-island", "Island Task", "active");
    db.prepare("INSERT INTO decision_projection (decision_id, title, state) VALUES (?, ?, ?)").run("dec_ISLAND", "Island Decision", "active");
  } finally {
    db.close();
  }
}

function writeTask(rootDir, taskId, title) {
  const taskDir = path.join(rootDir, "harness/tasks", `${taskId}-fixture`);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-04T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: standard-task",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
}

function writeDecision(rootDir, decisionId, relations) {
  const decisionDir = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionDir, { recursive: true });
  writeFileSync(path.join(decisionDir, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    `_coordinatorWatermark: wm-${decisionId}`,
    `title: "${decisionId}"`,
    "state: active",
    "riskTier: low",
    "urgency: low",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: []",
    "  productLines: []",
    "proposedBy: { kind: \"agent\", id: \"fixture\" }",
    "proposedAt: \"2026-07-04T00:00:00.000Z\"",
    "arbiter: { kind: \"human\", id: \"fixture\" }",
    "decidedAt: \"2026-07-04T00:00:00.000Z\"",
    "provenance:",
    "  - {runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-04T00:00:00.000Z\"}",
    `question: "Should ${decisionId} exist?"`,
    "chosen:",
    "  - { id: \"CH1\", text: \"Yes\" }",
    "rejected:",
    "  - { id: \"RJ1\", text: \"No\", why_not: \"Fixture\" }",
    "claims:",
    "  - { id: \"C1\", text: \"Fixture claim\" }",
    "relations:",
    ...relations.map((relation) => `  ${relation}`),
    "---",
    "",
    `# ${decisionId}`,
    ""
  ].join("\n"), "utf8");
}
