// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readLegacyMigrationSource } from "../../src/index.ts";
import { readColdRebuildSource } from "../../src/projection/cold-rebuild-source.ts";
import { readRelationGraphProjection } from "../../src/projection/relation-graph-projection.ts";
import { withTempStore } from "./helpers.ts";

import {
  fact,
  migrationFactEvent,
  migrationRelationEvent,
  relation,
  seedRelationProjection,
  writeColdHistory,
  writeFactEvent,
  writeLegacyFactEvent,
  writeMigrationEvent,
} from "./relation-graph-projection.fixtures.ts";

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
    assert.equal(graph.facts[0]?.invalidated, false, "invalidated is derived from the projected liveness verdict");
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

test("cold source derives Decision, relation, and Fact truth from authored L1", () => {
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
    assert.equal(existsSync(path.join(rootDir, ".harness/cache/task.sqlite")), false);
    const source = readColdRebuildSource(rootDir);
    assert.deepEqual(
      source.decisions.map(({ decisionId, state, title }) => ({ decisionId, state, title })),
      [{ decisionId: "dec_COLD", state: "active", title: "Cold truth" }],
    );
    assert.deepEqual(
      source.truth.edges.map(({ relationId }) => relationId).sort(),
      [
        derived.relation_id,
        evidenced.relation_id,
        superseded.relation_id,
        relation({ source: "task/task-cold", target: factRef, type: "produces" }).relation_id,
        relation({ source: "task/task-cold", target: migratedRef, type: "produces" }).relation_id,
      ].sort(),
    );
    assert.deepEqual(
      source.facts.map(({ ref, statement }) => ({ ref, statement })),
      [
        { ref: migratedRef, statement: "Event-backed evidence" },
        { ref: factRef, statement: "Event-backed evidence" },
      ],
    );
    // dec_6B963E9B83AE4AC73FB0A61E81 CH1: `invalidated` is factLiveness's verdict as a boolean,
    // so no read surface has to compare the liveness word itself.
    assert.deepEqual(
      source.facts.map(({ ref, liveness, invalidated }) => ({ ref, liveness, invalidated })),
      [
        { ref: migratedRef, liveness: "superseded_fact", invalidated: true },
        { ref: factRef, liveness: "standing", invalidated: false },
      ],
    );
    assert.deepEqual(
      source.truth.factAnchors.map(({ factRef: ref }) => ref),
      [migratedRef, factRef],
    );
    assert.equal(source.complete, true);
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

    const source = readLegacyMigrationSource(rootDir);
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

test("legacy relation type normalization stays confined to the migration reader", () => {
  withTempStore((rootDir) => {
    const legacyEvidence = relation({
      source: "decision/dec_COLD/C1",
      target: "fact/F-DEADBEEF",
      type: "supports",
    });
    writeColdHistory(
      rootDir,
      legacyEvidence,
      relation({ source: "decision/dec_COLD/CH1", target: "task/task-cold", type: "derives" }),
      relation({ source: "fact/F-DEADBEEF", target: "fact/F-ABCDEFGH", type: "supersedes-fact" }),
    );
    const ordinary = readColdRebuildSource(rootDir),
      migration = readLegacyMigrationSource(rootDir);
    assert.equal(
      ordinary.truth.edges.some(({ relationId }) => relationId === legacyEvidence.relation_id),
      false,
    );
    assert.equal(
      ordinary.issues.some(({ reason }) => reason.includes("type supports is not allowed for decision->fact")),
      true,
    );
    assert.equal(
      migration.truth.edges.some(
        ({ sourceRef, targetRef, relationType }) =>
          sourceRef === legacyEvidence.source && targetRef === legacyEvidence.target && relationType === "evidenced-by",
      ),
      true,
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
    const source = readColdRebuildSource(rootDir);
    assert.equal(
      source.facts.some(({ ref, statement }) => ref === migratedFact && statement === "Migrated event fact"),
      true,
    );
    assert.equal(
      source.truth.edges.some(({ relationId }) => relationId === migratedEdge.relation_id),
      true,
    );
    assert.equal(
      source.truth.edges.find(({ relationId }) => relationId === existingEdge.relation_id)?.origin,
      "imported_snapshot",
      "canonical event fields win over a duplicated Markdown snapshot",
    );
    assert.equal(source.complete, true);
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
    const source = readColdRebuildSource(rootDir);
    assert.equal(
      source.truth.edges.some(
        ({ relationId, sourceRef, targetRef, relationType }) =>
          relationId === edge.relation_id &&
          sourceRef === replacement &&
          targetRef === target &&
          relationType === "supersedes-fact",
      ),
      true,
    );
    assert.equal(source.complete, true);
  });
});

test("cold source marks relation truth incomplete when an authored source is malformed", () => {
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
    const factsPath = path.join(rootDir, "harness/tasks/task-cold/facts.md");
    writeFileSync(factsPath, readFileSync(factsPath, "utf8").replace("confidence: high", "confidence: invalid"));
    const source = readColdRebuildSource(rootDir);
    assert.equal(source.complete, false);
    assert.equal(
      source.issues.some(({ sourcePath, reason }) => sourcePath.endsWith("facts.md") && reason.length > 0),
      true,
    );
  });
});
