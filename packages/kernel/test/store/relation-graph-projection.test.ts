import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkTaskProjection, deriveRelationId, formatFactFlowRecord, formatRelationFlowRecord, readDecisionFactCoverage, readRelationGraphProjection, rebuildTaskProjection } from "../../src/index.ts";
import type { EntityRelationRecord, FactRecord } from "../../src/index.ts";
import { withTempStore } from "./helpers.ts";

test("relation graph projection stores decision claim to live fact coverage in SQLite", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-coverage", "Task Coverage");
    writeFacts(rootDir, "task-coverage", [{
      fact_id: "F-DEADBEEF",
      statement: "The live fact supports the decision claim.",
      source: "test",
      observedAt: "2026-07-03T00:00:00.000Z",
      confidence: "high"
    }]);
    const relation = relationRecord({
      source: "decision/dec_COVER/C1",
      target: "fact/task-coverage/F-DEADBEEF",
      type: "supports"
    });
    writeDecision(rootDir, "dec_COVER", "wm-cover", [relation]);

    rebuildTaskProjection({ rootDir });
    const coverage = readDecisionFactCoverage({ rootDir, decisionId: "dec_COVER" });

    assert.deepEqual(coverage.rows, [{
      decisionRef: "decision/dec_COVER",
      claimRef: "decision/dec_COVER/C1",
      status: "covered",
      coveringFactRef: "fact/task-coverage/F-DEADBEEF",
      relationPath: [relation.relation_id]
    }]);
  });
});

test("relation graph projection resolves facts by task_id when task directory has a slug suffix", () => {
  withTempStore((rootDir) => {
    const taskId = "task-slugged";
    const taskDirName = "task-slugged-real-title";
    writeIndex(rootDir, taskDirName, "Task Slugged Real Title", taskId);
    writeFacts(rootDir, taskDirName, [{
      fact_id: "F-DEADBEEF",
      statement: "The live fact is owned by the task_id, not the package directory slug.",
      source: "test",
      observedAt: "2026-07-03T00:00:00.000Z",
      confidence: "high"
    }]);
    const relation = relationRecord({
      source: "decision/dec_SLUGGED/C1",
      target: `fact/${taskId}/F-DEADBEEF`,
      type: "supports"
    });
    writeDecision(rootDir, "dec_SLUGGED", "wm-slugged", [relation]);

    rebuildTaskProjection({ rootDir });
    const graph = readRelationGraphProjection({ rootDir });
    const coverage = readDecisionFactCoverage({ rootDir, decisionId: "dec_SLUGGED" });

    assert.equal(graph.edges.some((edge) => edge.targetRef === `fact/${taskId}/F-DEADBEEF`), true);
    assert.deepEqual(coverage.rows, [{
      decisionRef: "decision/dec_SLUGGED",
      claimRef: "decision/dec_SLUGGED/C1",
      status: "covered",
      coveringFactRef: `fact/${taskId}/F-DEADBEEF`,
      relationPath: [relation.relation_id]
    }]);
  });
});

test("relation graph coverage treats invalidated facts as not live", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-invalidated", "Task Invalidated");
    writeFacts(rootDir, "task-invalidated", [
      {
        fact_id: "F-DEADBEEF",
        statement: "The old fact has been invalidated.",
        source: "test",
        observedAt: "2026-07-03T00:00:00.000Z",
        confidence: "high"
      },
      {
        fact_id: "F-FEEDFACE",
        statement: "The newer fact invalidates the old fact.",
        source: "test",
        observedAt: "2026-07-03T00:00:00.000Z",
        confidence: "high"
      }
    ], [
      relationRecord({
        source: "fact/task-invalidated/F-FEEDFACE",
        target: "fact/task-invalidated/F-DEADBEEF",
        type: "invalidated-by"
      })
    ]);
    writeDecision(rootDir, "dec_INVALIDATED", "wm-invalidated", [relationRecord({
      source: "decision/dec_INVALIDATED/C1",
      target: "fact/task-invalidated/F-DEADBEEF",
      type: "supports"
    })]);

    rebuildTaskProjection({ rootDir });
    const coverage = readDecisionFactCoverage({ rootDir, decisionId: "dec_INVALIDATED" });

    assert.deepEqual(coverage.rows, [{
      decisionRef: "decision/dec_INVALIDATED",
      claimRef: "decision/dec_INVALIDATED/C1",
      status: "uncovered",
      relationPath: []
    }]);
  });
});

test("relation graph projection auto-rebuilds when decision relations change", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-stale", "Task Stale");
    writeFacts(rootDir, "task-stale", [{
      fact_id: "F-DEADBEEF",
      statement: "The fact becomes reachable after the decision relation changes.",
      source: "test",
      observedAt: "2026-07-03T00:00:00.000Z",
      confidence: "high"
    }]);
    writeDecision(rootDir, "dec_STALE", "wm-stale", []);
    rebuildTaskProjection({ rootDir });

    writeDecision(rootDir, "dec_STALE", "wm-stale", [relationRecord({
      source: "decision/dec_STALE/C1",
      target: "fact/task-stale/F-DEADBEEF",
      type: "supports"
    })]);
    const coverage = readDecisionFactCoverage({ rootDir, decisionId: "dec_STALE" });

    assert.equal(coverage.warnings.some((warning) => warning.code === "projection_stale"), true);
    assert.equal(coverage.rows[0]?.status, "covered");
  });
});

test("relation graph projection excludes ghost decisions without coordinator watermark", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-ghost", "Task Ghost");
    writeFacts(rootDir, "task-ghost", [{
      fact_id: "F-DEADBEEF",
      statement: "A valid fact should not make a ghost decision visible.",
      source: "test",
      observedAt: "2026-07-03T00:00:00.000Z",
      confidence: "high"
    }]);
    writeDecision(rootDir, "dec_GHOST", "", [relationRecord({
      source: "decision/dec_GHOST/C1",
      target: "fact/task-ghost/F-DEADBEEF",
      type: "supports"
    })]);

    rebuildTaskProjection({ rootDir });
    const graph = readRelationGraphProjection({ rootDir });
    const coverage = readDecisionFactCoverage({ rootDir, decisionId: "dec_GHOST" });

    assert.equal(graph.edges.some((edge) => edge.sourceRef.startsWith("decision/dec_GHOST")), false);
    assert.deepEqual(coverage.rows, []);
  });
});

test("relation graph projection excludes ghost decisions with duplicate coordinator watermarks", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-duplicate-ghost", "Task Duplicate Ghost");
    writeFacts(rootDir, "task-duplicate-ghost", [{
      fact_id: "F-DEADBEEF",
      statement: "A duplicated watermark should keep copied decisions out of the graph.",
      source: "test",
      observedAt: "2026-07-03T00:00:00.000Z",
      confidence: "high"
    }]);
    writeDecision(rootDir, "dec_DUPLICATE_A", "wm-duplicate", [relationRecord({
      source: "decision/dec_DUPLICATE_A/C1",
      target: "fact/task-duplicate-ghost/F-DEADBEEF",
      type: "supports"
    })]);
    writeDecision(rootDir, "dec_DUPLICATE_B", "wm-duplicate", [relationRecord({
      source: "decision/dec_DUPLICATE_B/C1",
      target: "fact/task-duplicate-ghost/F-DEADBEEF",
      type: "supports"
    })]);

    rebuildTaskProjection({ rootDir });
    const graph = readRelationGraphProjection({ rootDir });
    const coverageA = readDecisionFactCoverage({ rootDir, decisionId: "dec_DUPLICATE_A" });
    const coverageB = readDecisionFactCoverage({ rootDir, decisionId: "dec_DUPLICATE_B" });

    assert.equal(graph.edges.some((edge) => edge.sourceRef.startsWith("decision/dec_DUPLICATE_")), false);
    assert.deepEqual(coverageA.rows, []);
    assert.deepEqual(coverageB.rows, []);
  });
});

test("post-merge typed relation cycle detection terminates across decision and fact nodes", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-cycle", "Task Cycle");
    writeFacts(rootDir, "task-cycle", [{
      fact_id: "F-DEADBEEF",
      statement: "The fact participates in a graph cycle.",
      source: "test",
      observedAt: "2026-07-03T00:00:00.000Z",
      confidence: "high"
    }], [
      relationRecord({
        source: "fact/task-cycle/F-DEADBEEF",
        target: "decision/dec_B/C1",
        type: "relates"
      })
    ]);
    writeDecision(rootDir, "dec_A", "wm-a", [relationRecord({
      source: "decision/dec_A/C1",
      target: "fact/task-cycle/F-DEADBEEF",
      type: "supports"
    })]);
    writeDecision(rootDir, "dec_B", "wm-b", [relationRecord({
      source: "decision/dec_B/C1",
      target: "decision/dec_A/C1",
      type: "relates"
    })]);

    const result = checkTaskProjection({ rootDir, postMerge: true });

    assert.equal(result.ok, false);
    const cycle = result.warnings.find((warning) => warning.code === "relation_cycle_detected");
    assert.ok(cycle);
    assert.match(cycle.message, /decision\/dec_A\/C1/);
    assert.match(cycle.message, /fact\/task-cycle\/F-DEADBEEF/);
    assert.match(cycle.message, /decision\/dec_B\/C1/);
  });
});

test("post-merge relation validation rejects facts.md host drift and provenance inheritance mismatch", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-owner", "Task Owner");
    writeFacts(rootDir, "task-owner", [{
      fact_id: "F-DEADBEEF",
      statement: "The owner fact is local to task-owner.",
      source: "test",
      observedAt: "2026-07-03T00:00:00.000Z",
      confidence: "high"
    }], [
      relationRecord({
        source: "fact/task-other/F-DEADBEEF",
        target: "task/task-owner",
        type: "relates"
      })
    ]);
    writeIndex(rootDir, "task-other", "Task Other");
    writeFacts(rootDir, "task-other", [{
      fact_id: "F-DEADBEEF",
      statement: "The source fact belongs to a different task.",
      source: "test",
      observedAt: "2026-07-03T00:00:00.000Z",
      confidence: "high"
    }]);

    const result = checkTaskProjection({ rootDir, postMerge: true });
    const codes = result.warnings.map((warning) => warning.code);

    assert.equal(result.ok, false);
    assert.equal(codes.includes("relation_host_source_mismatch"), true);
    assert.equal(codes.includes("relation_provenance_inheritance_mismatch"), true);
  });
});

test("post-merge relation validation rejects relation_id mismatches", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-bad-id", "Task Bad Id");
    writeFacts(rootDir, "task-bad-id", [{
      fact_id: "F-DEADBEEF",
      statement: "The fact supports a decision with a bad relation id.",
      source: "test",
      observedAt: "2026-07-03T00:00:00.000Z",
      confidence: "high"
    }]);
    writeDecisionRelationLines(rootDir, "dec_BAD_ID", "wm-bad-id", [
      "- {relation_id: rel_0000000000000000, source: decision/dec_BAD_ID/C1, target: fact/task-bad-id/F-DEADBEEF, type: supports, strength: strong, direction: directed, origin: declared, rationale: \"Fixture relation\", state: active}"
    ]);

    const result = checkTaskProjection({ rootDir, postMerge: true });

    assert.equal(result.ok, false);
    assert.equal(result.warnings.some((warning) => warning.code === "relation_id_mismatch"), true);
  });
});

test("post-merge relation validation rejects divergent duplicate relation_id records", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-duplicate-relation", "Task Duplicate Relation");
    writeFacts(rootDir, "task-duplicate-relation", [{
      fact_id: "F-DEADBEEF",
      statement: "The fact is targeted by divergent duplicate relation records.",
      source: "test",
      observedAt: "2026-07-03T00:00:00.000Z",
      confidence: "high"
    }]);
    const relation = relationRecord({
      source: "decision/dec_DUP_REL/C1",
      target: "fact/task-duplicate-relation/F-DEADBEEF",
      type: "supports"
    });
    writeDecision(rootDir, "dec_DUP_REL", "wm-dup-rel", [
      relation,
      { ...relation, strength: "weak", rationale: "Divergent attributes for the same canonical edge." }
    ]);

    const result = checkTaskProjection({ rootDir, postMerge: true });

    assert.equal(result.ok, false);
    assert.equal(result.warnings.some((warning) => warning.code === "duplicate_relation_id"), true);
  });
});

test("post-merge relation validation allows byte-identical duplicate records to converge", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-identical-relation", "Task Identical Relation");
    writeFacts(rootDir, "task-identical-relation", [{
      fact_id: "F-DEADBEEF",
      statement: "The fact is targeted by identical duplicate relation records.",
      source: "test",
      observedAt: "2026-07-03T00:00:00.000Z",
      confidence: "high"
    }]);
    const relation = relationRecord({
      source: "decision/dec_IDENTICAL_REL/C1",
      target: "fact/task-identical-relation/F-DEADBEEF",
      type: "supports"
    });
    writeDecision(rootDir, "dec_IDENTICAL_REL", "wm-identical-rel", [relation, relation]);

    const result = checkTaskProjection({ rootDir, postMerge: true });
    rebuildTaskProjection({ rootDir });
    const graph = readRelationGraphProjection({ rootDir });

    assert.equal(result.ok, true);
    assert.equal(result.warnings.some((warning) => warning.code === "duplicate_relation_id"), false);
    assert.equal(graph.edges.filter((edge) => edge.relationId === relation.relation_id).length, 1);
  });
});

function writeIndex(rootDir: string, taskDirName: string, title: string, taskId = taskDirName): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskDirName);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
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
    "  bindingCreatedAt: 2026-07-03T00:00:00.000Z",
    "  bindingFingerprint: ",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
}

type FactFixture = Omit<FactRecord, "provenance"> & Partial<Pick<FactRecord, "provenance">>;

function writeFacts(rootDir: string, taskId: string, facts: ReadonlyArray<FactFixture>, relations: ReadonlyArray<EntityRelationRecord> = []): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "facts.md"), [
    "# Facts",
    "",
    ...facts.map((fact) => formatFactFlowRecord({
      ...fact,
      provenance: fact.provenance ?? [{
        runtime: "human",
        sessionId: "human-cli-1783036800000",
        boundAt: "2026-07-03T00:00:00.000Z"
      }]
    })),
    ...(relations.length > 0 ? ["", "relations:", ...relations.map(formatRelationFlowRecord)] : []),
    ""
  ].join("\n"));
}

function writeDecision(rootDir: string, decisionId: string, watermark: string, relations: ReadonlyArray<EntityRelationRecord>): void {
  writeDecisionRelationLines(rootDir, decisionId, watermark, relations.map(formatRelationFlowRecord));
}

function writeDecisionRelationLines(rootDir: string, decisionId: string, watermark: string, relationLines: ReadonlyArray<string>): void {
  const decisionRoot = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    ...(watermark ? [`_coordinatorWatermark: ${watermark}`] : []),
    `title: ${decisionId}`,
    "state: active",
    "riskTier: low",
    "urgency: medium",
    "vertical: test",
    "preset: default",
    "applies_to:",
    "  modules: [\"test\"]",
    "  productLines: []",
    "proposedBy: { kind: \"human\", id: \"tester\" }",
    "proposedAt: \"2026-07-03T00:00:00.000Z\"",
    "arbiter: { kind: \"human\", id: \"arbiter\" }",
    "provenance:",
    "  - { runtime: \"cli\", actor: { kind: \"human\", id: \"tester\" }, capturedAt: \"2026-07-03T00:00:00.000Z\" }",
    `question: ${JSON.stringify(decisionId)}`,
    "chosen:",
    "  - { id: \"O1\", title: \"Chosen\", rationale: \"Fixture\" }",
    "rejected:",
    "  - { id: \"O2\", title: \"Rejected\", rationale: \"Fixture\" }",
    "claims:",
    "  - { id: \"C1\", statement: \"Fixture claim\", required: true }",
    "relations:",
    ...relationLines,
    "---",
    "",
    `# ${decisionId}`,
    ""
  ].join("\n"));
}

function relationRecord(input: {
  readonly source: string;
  readonly target: string;
  readonly type: EntityRelationRecord["type"];
  readonly strength?: EntityRelationRecord["strength"];
  readonly direction?: EntityRelationRecord["direction"];
  readonly origin?: EntityRelationRecord["origin"];
  readonly rationale?: string;
  readonly state?: EntityRelationRecord["state"];
}): EntityRelationRecord {
  const base = {
    source: input.source,
    target: input.target,
    type: input.type,
    direction: input.direction ?? "directed"
  };
  return {
    relation_id: deriveRelationId(base),
    ...base,
    strength: input.strength ?? "strong",
    origin: input.origin ?? "declared",
    rationale: input.rationale ?? "Fixture relation",
    state: input.state ?? "active"
  };
}
