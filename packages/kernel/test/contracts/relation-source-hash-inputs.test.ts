// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, formatRelationFlowRecord } from "../../src/index.ts";
import type { EntityRelationRecord } from "../../src/index.ts";
import { readRelationGraphAuthoredSourceKinds } from "../../src/projection/relation-graph-projection.ts";
import {
  readMarkdownSource,
  readRelationGraphSourceHashInputKinds,
  readTaskProjectionSourceHashInputs
} from "../../src/projection/sqlite-task-source.ts";
import { withTempStore } from "../store/helpers.ts";

test("relation graph collection and freshness enumerate the same authored source kinds", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-source", "Task Source", [
      relationRecord({
        source: "task/task-source",
        target: "task/task-target",
        type: "relates"
      })
    ]);
    writeIndex(rootDir, "task-target", "Task Target");
    writeDecision(rootDir, "dec_SOURCE", [
      relationRecord({
        source: "decision/dec_SOURCE/C1",
        target: "task/task-target",
        type: "derives"
      })
    ]);

    const authoredKinds = readRelationGraphAuthoredSourceKinds({ rootDir });
    const sourceHashKinds = readRelationGraphSourceHashInputKinds({ rootDir });

    assert.deepEqual(authoredKinds, ["decision-document", "task-index"]);
    assert.deepEqual(sourceHashKinds, ["decision-document", "task-index"]);
    assert.deepEqual(sourceHashKinds, authoredKinds);
  });
});

test("freshness preserves task index hash input order", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task_a", "Lowercase Task");
    writeIndex(rootDir, "task_Z", "Uppercase Task");

    const taskIndexPaths = readTaskProjectionSourceHashInputs({ rootDir })
      .filter((input) => input.kind === "task-index")
      .map((input) => input.sourcePath);

    assert.deepEqual(taskIndexPaths, [
      "harness/tasks/task_Z/INDEX.md",
      "harness/tasks/task_a/INDEX.md"
    ]);
  });
});

test("decision-only relation changes invalidate freshness", () => {
  withTempStore((rootDir) => {
    writeDecision(rootDir, "dec_SOURCE", [
      relationRecord({
        source: "decision/dec_SOURCE/C1",
        target: "task/task-before",
        type: "derives"
      })
    ]);
    const before = readMarkdownSource({ rootDir }).hash;

    writeDecision(rootDir, "dec_SOURCE", [
      relationRecord({
        source: "decision/dec_SOURCE/C1",
        target: "task/task-after",
        type: "derives"
      })
    ]);

    assert.notEqual(readMarkdownSource({ rootDir }).hash, before);
    assert.deepEqual(readRelationGraphSourceHashInputKinds({ rootDir }), ["decision-document"]);
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
