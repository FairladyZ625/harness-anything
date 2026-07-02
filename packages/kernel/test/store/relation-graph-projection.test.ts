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

function writeIndex(rootDir: string, taskId: string, title: string): void {
  const taskRoot = path.join(rootDir, "harness/planning/tasks", taskId);
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
    "  bindingFingerprint: sha256:fixture",
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
  const taskRoot = path.join(rootDir, "harness/planning/tasks", taskId);
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
    ...relations.map(formatRelationFlowRecord),
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
