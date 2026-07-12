// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  deriveRelationId,
  formatFactFlowRecord,
  formatRelationFlowRecord,
  readDecisionFactCoverage,
  rebuildTaskProjection
} from "../../src/index.ts";
import type { EntityRelationRecord } from "../../src/index.ts";
import { withTempStore } from "./helpers.ts";

test("relation graph coverage rejects non-evidence paths and supersession edges", () => {
  withTempStore((rootDir) => {
    writeTask(rootDir, "task-non-evidence", [relationRecord({
      source: "task/task-non-evidence",
      target: "fact/task-non-evidence/F-DEADBEEF",
      type: "produces"
    })]);
    writeDecision(rootDir, "dec_RELATES_PATH", [relationRecord({
      source: "decision/dec_RELATES_PATH/C1",
      target: "task/task-non-evidence",
      type: "relates"
    })]);
    writeDecision(rootDir, "dec_DERIVES_PATH", [relationRecord({
      source: "decision/dec_DERIVES_PATH/C1",
      target: "task/task-non-evidence",
      type: "derives"
    })]);
    writeDecision(rootDir, "dec_SUPERSEDES_PATH", [relationRecord({
      source: "decision/dec_SUPERSEDES_PATH/C1",
      target: "fact/task-non-evidence/F-DEADBEEF",
      type: "supersedes-fact"
    })]);

    rebuildTaskProjection({ rootDir });

    for (const decisionId of ["dec_RELATES_PATH", "dec_DERIVES_PATH", "dec_SUPERSEDES_PATH"]) {
      assert.deepEqual(readDecisionFactCoverage({ rootDir, decisionId }).rows, [{
        decisionRef: `decision/${decisionId}`,
        claimRef: `decision/${decisionId}/C1`,
        status: "uncovered",
        relationPath: []
      }]);
    }
  });
});

test("relation graph coverage records active fact refutations and keeps the claim uncovered", () => {
  withTempStore((rootDir) => {
    const supportingFactRef = "fact/task-refutation/F-DEADBEEF";
    const refutingFactRef = "fact/task-refutation/F-FEEDFACE";
    writeTask(rootDir, "task-refutation", [relationRecord({
      source: refutingFactRef,
      target: "decision/dec_REFUTED/C1",
      type: "refutes"
    })], true);
    writeDecision(rootDir, "dec_REFUTED", [relationRecord({
      source: "decision/dec_REFUTED/C1",
      target: supportingFactRef,
      type: "evidenced-by"
    })]);

    rebuildTaskProjection({ rootDir });

    assert.deepEqual(readDecisionFactCoverage({ rootDir, decisionId: "dec_REFUTED" }).rows, [{
      decisionRef: "decision/dec_REFUTED",
      claimRef: "decision/dec_REFUTED/C1",
      status: "uncovered",
      refutingFactRefs: [refutingFactRef],
      relationPath: []
    }]);
  });
});

function writeTask(
  rootDir: string,
  taskId: string,
  relations: ReadonlyArray<EntityRelationRecord>,
  includeRefutingFact = false
): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "---",
    ""
  ].join("\n"));
  const facts = [
    formatFact("F-DEADBEEF", "The reachable fact."),
    ...(includeRefutingFact ? [formatFact("F-FEEDFACE", "The refuting fact.")] : [])
  ];
  writeFileSync(path.join(taskRoot, "facts.md"), [
    ...facts,
    "",
    "relations:",
    ...relations.map(formatRelationFlowRecord),
    ""
  ].join("\n"));
}

function formatFact(factId: string, statement: string): string {
  return formatFactFlowRecord({
    fact_id: factId,
    statement,
    source: "test",
    observedAt: "2026-07-03T00:00:00.000Z",
    confidence: "high",
    memoryClass: "episodic",
    memoryTags: [],
    provenance: [{ runtime: "human", sessionId: "fixture", boundAt: "2026-07-03T00:00:00.000Z" }]
  });
}

function writeDecision(rootDir: string, decisionId: string, relations: ReadonlyArray<EntityRelationRecord>): void {
  const decisionRoot = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    `_coordinatorWatermark: wm-${decisionId}`,
    "claims:",
    "  - { id: \"C1\", text: \"Fixture claim\" }",
    "relations:",
    ...relations.map(formatRelationFlowRecord),
    "---",
    ""
  ].join("\n"));
}

function relationRecord(input: {
  readonly source: string;
  readonly target: string;
  readonly type: EntityRelationRecord["type"];
}): EntityRelationRecord {
  const identity = { ...input, direction: "directed" as const };
  return {
    relation_id: deriveRelationId(identity),
    ...identity,
    strength: "strong",
    origin: "declared",
    rationale: "Fixture relation",
    state: "active"
  };
}
