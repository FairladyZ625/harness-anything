import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, formatFactFlowRecord, formatRelationFlowRecord } from "../../src/index.ts";
import type { EntityRelationRecord, FactRecord } from "../../src/index.ts";
import { readRelationGraphAuthoredSourceKinds } from "../../src/projection/relation-graph-projection.ts";
import { readTaskProjectionSourceHashInputs } from "../../src/projection/sqlite-task-source.ts";
import { withTempStore } from "../store/helpers.ts";

test("relation authored source kinds are covered by task projection sourceHash inputs", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-source", "Task Source", [
      relationRecord({
        source: "task/task-source",
        target: "task/task-target",
        type: "relates"
      })
    ]);
    writeIndex(rootDir, "task-target", "Task Target");
    writeIndex(rootDir, "task-fact-owner", "Task Fact Owner");
    writeFacts(rootDir, "task-fact-owner", [{
      fact_id: "F-DEADBEEF",
      statement: "The fact supports the decision.",
      source: "fixture",
      observedAt: "2026-07-06T00:00:00.000Z",
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: ["abstract_rule"],
      provenance: [{
        runtime: "codex",
        sessionId: "fixture-session",
        boundAt: "2026-07-06T00:00:00.000Z"
      }]
    }], [
      relationRecord({
        source: "fact/task-fact-owner/F-DEADBEEF",
        target: "decision/dec_SOURCE/C1",
        type: "supports"
      })
    ]);
    writeDecision(rootDir, "dec_SOURCE", [
      relationRecord({
        source: "decision/dec_SOURCE/C1",
        target: "task/task-target",
        type: "derives"
      })
    ]);

    const authoredKinds = readRelationGraphAuthoredSourceKinds({ rootDir });
    const sourceHashKinds = new Set(readTaskProjectionSourceHashInputs({ rootDir }).map((input) => input.kind));
    const missingKinds = authoredKinds.filter((kind) => !sourceHashKinds.has(kind));

    assert.deepEqual(authoredKinds, ["decision-document", "task-facts", "task-index"]);
    assert.deepEqual(missingKinds, []);
  });
});

function writeIndex(rootDir: string, taskId: string, title: string, relations: ReadonlyArray<EntityRelationRecord> = []): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${JSON.stringify(title)}`,
    "status: active",
    "packageDisposition: active",
    "lifecycle:",
    "  engine: local",
    ...(relations.length > 0 ? ["relations:", ...relations.map(formatRelationFlowRecord)] : []),
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
}

function writeFacts(
  rootDir: string,
  taskId: string,
  facts: ReadonlyArray<FactRecord>,
  relations: ReadonlyArray<EntityRelationRecord> = []
): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "facts.md"), [
    "# Facts",
    "",
    ...facts.map(formatFactFlowRecord),
    ...(relations.length > 0 ? ["", "relations:", ...relations.map(formatRelationFlowRecord)] : []),
    ""
  ].join("\n"));
}

function writeDecision(rootDir: string, decisionId: string, relations: ReadonlyArray<EntityRelationRecord>): void {
  const decisionRoot = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    "_coordinatorWatermark: wm-source-contract",
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
    "proposedAt: \"2026-07-06T00:00:00.000Z\"",
    "arbiter: { kind: \"human\", id: \"arbiter\" }",
    "provenance:",
    "  - { runtime: \"cli\", actor: { kind: \"human\", id: \"tester\" }, capturedAt: \"2026-07-06T00:00:00.000Z\" }",
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
}): EntityRelationRecord {
  const base = {
    source: input.source,
    target: input.target,
    type: input.type,
    direction: "directed" as const
  };
  return {
    relation_id: deriveRelationId(base),
    ...base,
    strength: "strong",
    origin: "declared",
    rationale: "Fixture relation",
    state: "active"
  };
}
