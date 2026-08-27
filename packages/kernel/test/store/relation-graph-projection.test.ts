// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  checkTaskProjection,
  readColdRebuildSource,
  readRelationGraphProjection,
  rebuildTaskProjection,
} from "../../src/index.ts";
import { withTempStore } from "./helpers.ts";

import {
  applyDecision,
  fact,
  migrationFactEvent,
  migrationRelationEvent,
  projectionFixture,
  proposal,
  relation,
  seedRelationProjection,
  writeColdHistory,
  writeFactEvent,
  writeLegacyFactEvent,
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
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
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
    assert.deepEqual(readFileSync(projectionPath), before, "read path must not rebuild or mutate canonical L2");
  });
});

test("GUI graph distinguishes unavailable truth from an empty relation set without creating a cache", () => {
  withTempStore((rootDir) => {
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite"),
      graph = readRelationGraphProjection({ rootDir });
    assert.deepEqual(graph.edges, []);
    assert.equal(
      graph.warnings.some(({ code, severity }) => code === "relation_truth_unavailable" && severity === "hard-fail"),
      true,
    );
    assert.equal(existsSync(projectionPath), false);
  });
});

test("GUI graph rejects structurally complete relation tables without a truth-source marker", () => {
  withTempStore((rootDir) => {
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    seedRelationProjection(projectionPath, false);
    const graph = readRelationGraphProjection({ rootDir });
    assert.deepEqual(graph.edges, []);
    assert.equal(
      graph.warnings.some(
        ({ code, message }) => code === "relation_truth_unavailable" && message.includes("truth source"),
      ),
      true,
    );
  });
});

test("explicit cold rebuild derives Decision, relation, coverage, and Fact truth from authored L1", () => {
  withTempStore((rootDir) => {
    const factRef = "fact/F-DEADBEEF",
      migratedRef = "fact/F-ABCDEFGH",
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
    writeFactEvent(rootDir, {
      ...fact(1),
      taskId: "task-cold",
      factId: "F-DEADBEEF",
      payload: {
        ...fact(1).payload,
        supersedes: { factRef: migratedRef, rationale: "Replaces the historical observation." },
      },
    });
    writeFactEvent(rootDir, { ...fact(2), taskId: "task-cold", factId: "F-ABCDEFGH" });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    assert.equal(existsSync(path.join(rootDir, ".harness/cache/task.sqlite")), false);
    rebuildTaskProjection({ rootDir, projectionPath });
    const graph = readRelationGraphProjection({ rootDir, projectionPath }),
      db = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS count FROM decision_projection").get()!.count, 1);
      assert.deepEqual(
        {
          ...db.prepare("SELECT decision_id, state, title FROM decision_projection").get()!,
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
        relation({ source: "task/task-cold", target: factRef, type: "produces" }).relation_id,
        relation({ source: "task/task-cold", target: migratedRef, type: "produces" }).relation_id,
      ].sort(),
    );
    assert.deepEqual(
      graph.facts.map(({ ref, statement }) => ({ ref, statement })),
      [
        { ref: migratedRef, statement: "Event-backed evidence" },
        { ref: factRef, statement: "Event-backed evidence" },
      ],
    );
    assert.deepEqual(
      graph.factAnchors.map(({ factRef: ref }) => ref),
      [migratedRef, factRef],
    );
    assert.deepEqual(
      graph.coverageRows.map(({ claimRef, status, fulfillment, coveringFactRef }) => ({
        claimRef,
        status,
        fulfillment,
        coveringFactRef,
      })),
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

test("equal legacy Fact ids in documents and events both reach deterministic migration re-keying", () => {
  withTempStore((rootDir) => {
    const factRef = "fact/F-DEADBEEF",
      migratedRef = "fact/F-ABCDEFGH";
    writeColdHistory(
      rootDir,
      relation({ source: "decision/dec_COLD/C1", target: factRef, type: "evidenced-by" }),
      relation({ source: "decision/dec_COLD/CH1", target: "task/task-cold", type: "derives" }),
      relation({ source: factRef, target: migratedRef, type: "supersedes-fact" }),
    );
    const firstTaskRoot = path.join(rootDir, "harness/tasks/task-cold"),
      secondTaskRoot = path.join(rootDir, "harness/tasks/task-second");
    mkdirSync(secondTaskRoot, { recursive: true });
    writeFileSync(
      path.join(secondTaskRoot, "INDEX.md"),
      readFileSync(path.join(firstTaskRoot, "INDEX.md"), "utf8").replaceAll("task-cold", "task-second"),
    );
    writeFileSync(
      path.join(secondTaskRoot, "facts.md"),
      readFileSync(path.join(firstTaskRoot, "facts.md"), "utf8").replace(
        "Cold rebuild evidence",
        "Second source observation",
      ),
    );
    for (const [revision, taskId] of [
      [20, "task-cold"],
      [21, "task-second"],
    ] as const)
      writeLegacyFactEvent(rootDir, {
        ...fact(revision),
        eventId: `event-collision-${taskId}`,
        opId: `op-collision-${taskId}`,
        taskId,
        factId: "F-C0FFEE00",
        payload: {
          ...fact(revision).payload,
          statement: `${taskId} event observation`,
        },
      });

    const source = readColdRebuildSource(rootDir, { includeLegacyTaskFacts: true });
    assert.deepEqual(
      source.facts
        .filter(({ factId }) => factId === "F-DEADBEEF")
        .map(({ taskId }) => taskId)
        .sort(),
      ["task-cold", "task-second"],
    );
    assert.deepEqual(
      source.facts
        .filter(({ factId }) => factId === "F-C0FFEE00")
        .map(({ taskId }) => taskId)
        .sort(),
      ["task-cold", "task-second"],
    );
  });
});

test("cold rebuild replays migrated Fact and relation truth from canonical L1 events", () => {
  withTempStore((rootDir) => {
    const existingFact = "fact/F-DEADBEEF",
      migratedFact = "fact/F-3VSTHPDM",
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
        target: "fact/F-ABCDEFGH",
        type: "supersedes-fact",
      }),
    );
    writeFactEvent(rootDir, {
      ...fact(1),
      eventId: "event-existing-fact",
      opId: "op-existing-fact",
      taskId: "task-cold",
      factId: "F-DEADBEEF",
    });
    writeMigrationEvent(rootDir, migrationFactEvent(1));
    writeMigrationEvent(rootDir, migrationRelationEvent(2, migratedEdge));
    writeMigrationEvent(rootDir, migrationRelationEvent(3, existingEdge));
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    rebuildTaskProjection({ rootDir, projectionPath });
    const graph = readRelationGraphProjection({ rootDir, projectionPath });
    assert.equal(
      graph.facts.some(({ ref, statement }) => ref === migratedFact && statement === "Migrated event fact"),
      true,
    );
    assert.equal(
      graph.edges.some(({ relationId }) => relationId === migratedEdge.relation_id),
      true,
    );
    assert.equal(
      graph.edges.find(({ relationId }) => relationId === existingEdge.relation_id)?.origin,
      "imported_snapshot",
      "canonical event fields win over a duplicated Markdown snapshot",
    );
    assert.deepEqual(graph.warnings, []);
  });
});

test("cold rebuild derives supersedes-fact edges from native Fact events", () => {
  withTempStore((rootDir) => {
    const target = "fact/F-DEADBEEF",
      replacement = "fact/F-BCDEFGHJ",
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
        target: "fact/F-ABCDEFGH",
        type: "supersedes-fact",
      }),
    );
    writeFactEvent(rootDir, { ...fact(1), taskId: "task-cold", factId: "F-DEADBEEF" });
    writeFactEvent(rootDir, {
      ...fact(1),
      taskId: "task-cold",
      factId: "F-BCDEFGHJ",
      eventId: "event-2",
      opId: "op-2",
      workspaceRevision: 2,
      payload: {
        ...fact(1).payload,
        statement: "Replacement fact",
        supersedes: { factRef: target, rationale: edge.rationale },
      },
    });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
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
        target: "fact/F-DEADBEEF",
        type: "evidenced-by",
      }),
      derived = relation({
        source: "decision/dec_COLD/CH1",
        target: "task/task-cold",
        type: "derives",
      }),
      superseded = relation({
        source: "fact/F-DEADBEEF",
        target: "fact/F-ABCDEFGH",
        type: "supersedes-fact",
      });
    writeColdHistory(rootDir, evidenced, derived, superseded);
    const factsPath = path.join(rootDir, "harness/tasks/task-cold/facts.md"),
      projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    writeFileSync(factsPath, readFileSync(factsPath, "utf8").replace("confidence: high", "confidence: invalid"));
    rebuildTaskProjection({ rootDir, projectionPath });
    const db = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS count FROM relation_edges").get()!.count, 1);
      assert.equal(db.prepare("SELECT value FROM projection_meta WHERE key = 'relationTruthSource'").get(), undefined);
    } finally {
      db.close();
    }
    const graph = readRelationGraphProjection({ rootDir, projectionPath });
    assert.deepEqual(graph.edges, []);
    assert.equal(
      graph.warnings.some(({ code, severity }) => code === "relation_truth_unavailable" && severity === "hard-fail"),
      true,
    );
  });
});
