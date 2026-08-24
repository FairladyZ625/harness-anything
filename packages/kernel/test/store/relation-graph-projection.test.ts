// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  REPLAY_TASK_GRAPH,
  checkTaskProjection,
  compileDecisionWrite,
  compileFactWrite,
  decisionWritePlan,
  deriveRelationId,
  formatRelationFlowRecord,
  makeTaskProjection,
  projectDecisionReadiness,
  readRelationGraphProjection,
  rebuildTaskProjection,
  renderDecisionDocument,
  serializeCanonicalEvent,
  sha256Text,
  taskLifecycleWritePlan,
  type DecisionEventDraftV1,
  type EntityRelationRecord,
  type FactEventDraftV1,
  type MigrationImportEventV1,
  type TaskEventV1,
} from "../../src/index.ts";
import {
  createDecisionProjectionTables,
  readDecisionDocumentState,
  reduceDecisionEvent,
} from "../../src/projection/decision-event-projection.ts";
import { createFactProjectionTables } from "../../src/projection/fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import { withTempStore } from "./helpers.ts";

import {
  accepted,
  actor,
  applyDecision,
  applyFact,
  claim,
  compileCurrent,
  decisionProjectionDatabase,
  fact,
  git,
  migrationFactEvent,
  migrationRelationEvent,
  projectionFixture,
  proposal,
  related,
  relation,
  seedRelationProjection,
  taskCreated,
  testReadinessSource,
  writeColdHistory,
  writeFactEvent,
  writeMigrationEvent,
  writeTask,
} from "./relation-graph-projection.fixtures.ts";
test("real post-merge entry resolves event-backed Decision anchors and rejects unknown anchors", () => {
  withTempStore((rootDir) => {
    const fixture = projectionFixture(rootDir);
    applyDecision(fixture, proposal(1, "dec_KNOWN"));
    writeTask(
      rootDir,
      "task-authored",
      relation({
        source: "task/task-authored",
        target: "decision/dec_KNOWN/CH1",
        type: "implements",
      }),
    );
    const pass = checkTaskProjection({
      rootDir,
      postMerge: true,
      eventRelationTruth: fixture.projection.readRelationTruth(),
    });
    assert.equal(pass.ok, true, JSON.stringify(pass.warnings));
    writeTask(
      rootDir,
      "task-authored",
      relation({
        source: "task/task-authored",
        target: "decision/dec_KNOWN/CH404",
        type: "implements",
      }),
    );
    const fail = checkTaskProjection({
      rootDir,
      postMerge: true,
      eventRelationTruth: fixture.projection.readRelationTruth(),
    });
    assert.equal(fail.ok, false);
    assert.equal(
      fail.warnings.some(({ code }) => code === "relation_endpoint_unknown"),
      true,
    );
  });
});

test("GUI graph reads task and relation truth from one read-only L2 database", () => {
  withTempStore((rootDir) => {
    const projectionPath = path.join(
      rootDir,
      ".harness/cache/projections.sqlite",
    );
    seedRelationProjection(projectionPath);
    const before = readFileSync(projectionPath),
      graph = readRelationGraphProjection({ rootDir });
    assert.deepEqual(
      graph.edges.map(({ relationId }) => relationId),
      ["rel_positive"],
    );
    assert.deepEqual(
      graph.taskRows.map(({ taskId }) => taskId),
      ["task-positive"],
    );
    assert.equal(graph.facts[0]?.schema, "task-fact-row/v1");
    assert.deepEqual(
      readFileSync(projectionPath),
      before,
      "read path must not rebuild or mutate canonical L2",
    );
  });
});

test("GUI graph distinguishes unavailable truth from an empty relation set without creating a cache", () => {
  withTempStore((rootDir) => {
    const projectionPath = path.join(
        rootDir,
        ".harness/cache/projections.sqlite",
      ),
      graph = readRelationGraphProjection({ rootDir });
    assert.deepEqual(graph.edges, []);
    assert.equal(
      graph.warnings.some(
        ({ code, severity }) =>
          code === "relation_truth_unavailable" && severity === "hard-fail",
      ),
      true,
    );
    assert.equal(existsSync(projectionPath), false);
  });
});

test("GUI graph rejects structurally complete relation tables without a truth-source marker", () => {
  withTempStore((rootDir) => {
    const projectionPath = path.join(
      rootDir,
      ".harness/cache/projections.sqlite",
    );
    seedRelationProjection(projectionPath, false);
    const graph = readRelationGraphProjection({ rootDir });
    assert.deepEqual(graph.edges, []);
    assert.equal(
      graph.warnings.some(
        ({ code, message }) =>
          code === "relation_truth_unavailable" &&
          message.includes("truth source"),
      ),
      true,
    );
  });
});

test("explicit cold rebuild derives Decision, relation, coverage, and Fact truth from authored L1", () => {
  withTempStore((rootDir) => {
    const factRef = "fact/task-cold/F-DEADBEEF",
      migratedRef = "fact/task-cold/F-ABCDEFGH",
      evidenced = relation({
        source: "decision/dec_COLD/C1",
        target: factRef,
        type: "evidenced-by",
      }),
      derived = relation({
        source: "decision/dec_COLD/CH1",
        target: "task/task-cold",
        type: "derives",
      }),
      superseded = relation({
        source: factRef,
        target: migratedRef,
        type: "supersedes-fact",
      });
    writeColdHistory(rootDir, evidenced, derived, superseded);
    const projectionPath = path.join(
      rootDir,
      ".harness/cache/projections.sqlite",
    );
    assert.equal(
      existsSync(path.join(rootDir, ".harness/cache/task.sqlite")),
      false,
    );
    rebuildTaskProjection({ rootDir, projectionPath });
    const graph = readRelationGraphProjection({ rootDir, projectionPath }),
      db = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT count(*) AS count FROM decision_projection").get()!
          .count,
        1,
      );
      assert.deepEqual(
        {
          ...db
            .prepare(
              "SELECT decision_id, state, title FROM decision_projection",
            )
            .get()!,
        },
        { decision_id: "dec_COLD", state: "active", title: "Cold truth" },
      );
    } finally {
      db.close();
    }
    assert.deepEqual(
      graph.edges.map(({ relationId }) => relationId).sort(),
      [
        derived.relation_id,
        evidenced.relation_id,
        superseded.relation_id,
      ].sort(),
    );
    assert.deepEqual(
      graph.facts.map(({ ref, statement }) => ({ ref, statement })),
      [{ ref: factRef, statement: "Cold rebuild evidence" }],
    );
    assert.deepEqual(
      graph.factAnchors.map(({ factRef: ref }) => ref),
      [factRef],
    );
    assert.deepEqual(
      graph.coverageRows.map(
        ({ claimRef, status, fulfillment, coveringFactRef }) => ({
          claimRef,
          status,
          fulfillment,
          coveringFactRef,
        }),
      ),
      [
        {
          claimRef: "decision/dec_COLD/C1",
          status: "covered",
          fulfillment: "evidenced",
          coveringFactRef: factRef,
        },
      ],
    );
    assert.deepEqual(graph.warnings, []);
  });
});

test("cold rebuild replays migrated Fact and relation truth from canonical L1 events", () => {
  withTempStore((rootDir) => {
    const existingFact = "fact/task-cold/F-DEADBEEF",
      migratedFact = "fact/task-cold/F-3VSTHPDM",
      existingEdge = relation({
        source: "decision/dec_COLD/C1",
        target: existingFact,
        type: "evidenced-by",
      }),
      migratedEdge = relation({
        source: "decision/dec_COLD/C1",
        target: migratedFact,
        type: "evidenced-by",
      });
    writeColdHistory(
      rootDir,
      existingEdge,
      relation({
        source: "decision/dec_COLD/CH1",
        target: "task/task-cold",
        type: "derives",
      }),
      relation({
        source: existingFact,
        target: "fact/task-cold/F-ABCDEFGH",
        type: "supersedes-fact",
      }),
    );
    writeMigrationEvent(rootDir, migrationFactEvent(1));
    writeMigrationEvent(rootDir, migrationRelationEvent(2, migratedEdge));
    writeMigrationEvent(rootDir, migrationRelationEvent(3, existingEdge));
    const projectionPath = path.join(
      rootDir,
      ".harness/cache/projections.sqlite",
    );
    rebuildTaskProjection({ rootDir, projectionPath });
    const graph = readRelationGraphProjection({ rootDir, projectionPath });
    assert.equal(
      graph.facts.some(
        ({ ref, statement }) =>
          ref === migratedFact && statement === "Migrated event fact",
      ),
      true,
    );
    assert.equal(
      graph.edges.some(
        ({ relationId }) => relationId === migratedEdge.relation_id,
      ),
      true,
    );
    assert.equal(
      graph.edges.find(
        ({ relationId }) => relationId === existingEdge.relation_id,
      )?.origin,
      "imported_snapshot",
      "canonical event fields win over a duplicated Markdown snapshot",
    );
    assert.deepEqual(graph.warnings, []);
  });
});

test("cold rebuild derives supersedes-fact edges from native Fact events", () => {
  withTempStore((rootDir) => {
    const target = "fact/task-cold/F-DEADBEEF",
      replacement = "fact/task-cold/F-BCDEFGHJ",
      edge = relation({ source: replacement, target, type: "supersedes-fact" });
    writeColdHistory(
      rootDir,
      relation({
        source: "decision/dec_COLD/C1",
        target,
        type: "evidenced-by",
      }),
      relation({
        source: "decision/dec_COLD/CH1",
        target: "task/task-cold",
        type: "derives",
      }),
      relation({
        source: target,
        target: "fact/task-cold/F-ABCDEFGH",
        type: "supersedes-fact",
      }),
    );
    writeFactEvent(rootDir, {
      ...fact(1),
      taskId: "task-cold",
      factId: "F-BCDEFGHJ",
      payload: {
        ...fact(1).payload,
        statement: "Replacement fact",
        supersedes: { factRef: target, rationale: edge.rationale },
      },
    });
    const projectionPath = path.join(
      rootDir,
      ".harness/cache/projections.sqlite",
    );
    rebuildTaskProjection({ rootDir, projectionPath });
    const graph = readRelationGraphProjection({ rootDir, projectionPath });
    assert.equal(
      graph.edges.some(
        ({ relationId, sourceRef, targetRef, relationType }) =>
          relationId === edge.relation_id &&
          sourceRef === replacement &&
          targetRef === target &&
          relationType === "supersedes-fact",
      ),
      true,
    );
    assert.deepEqual(graph.warnings, []);
  });
});

test("cold rebuild marks structurally present relation truth unavailable when an authored source is incomplete", () => {
  withTempStore((rootDir) => {
    const evidenced = relation({
        source: "decision/dec_COLD/C1",
        target: "fact/task-cold/F-DEADBEEF",
        type: "evidenced-by",
      }),
      derived = relation({
        source: "decision/dec_COLD/CH1",
        target: "task/task-cold",
        type: "derives",
      }),
      superseded = relation({
        source: "fact/task-cold/F-DEADBEEF",
        target: "fact/task-cold/F-ABCDEFGH",
        type: "supersedes-fact",
      });
    writeColdHistory(rootDir, evidenced, derived, superseded);
    const factsPath = path.join(rootDir, "harness/tasks/task-cold/facts.md"),
      projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    writeFileSync(
      factsPath,
      readFileSync(factsPath, "utf8").replace(
        "confidence: high",
        "confidence: invalid",
      ),
    );
    rebuildTaskProjection({ rootDir, projectionPath });
    const db = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT count(*) AS count FROM relation_edges").get()!.count,
        1,
      );
      assert.equal(
        db
          .prepare(
            "SELECT value FROM projection_meta WHERE key = 'relationTruthSource'",
          )
          .get(),
        undefined,
      );
    } finally {
      db.close();
    }
    const graph = readRelationGraphProjection({ rootDir, projectionPath });
    assert.deepEqual(graph.edges, []);
    assert.equal(
      graph.warnings.some(
        ({ code, severity }) =>
          code === "relation_truth_unavailable" && severity === "hard-fail",
      ),
      true,
    );
  });
});
