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
  readTaskProjectionSourceHashInputs,
} from "../../src/projection/sqlite-task-source.ts";
import { withTempStore } from "../store/helpers.ts";
import { realizedDecisionBody } from "../../../../tools/fixtures/task-plan.mjs";

test("relation graph collection and freshness enumerate the same authored source kinds", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-source", "Task Source", [
      relationRecord({
        source: "task/task-source",
        target: "task/task-target",
        type: "relates",
      }),
    ]);
    writeIndex(rootDir, "task-target", "Task Target");
    const authoredKinds = readRelationGraphAuthoredSourceKinds({ rootDir });
    const sourceHashKinds = readRelationGraphSourceHashInputKinds({ rootDir });

    assert.deepEqual(authoredKinds, ["task-index"]);
    assert.deepEqual(sourceHashKinds, ["task-index"]);
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

    assert.deepEqual(taskIndexPaths, ["harness/tasks/task_Z/INDEX.md", "harness/tasks/task_a/INDEX.md"]);
  });
});

test("event-backed Decision relations are absent from Markdown freshness inputs", () => {
  withTempStore((rootDir) => {
    const before = readMarkdownSource({ rootDir }).hash;
    mkdirSync(path.join(rootDir, "harness/decisions/decision-dec_SOURCE"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "harness/decisions/decision-dec_SOURCE/decision.md"),
      realizedDecisionBody("Canonical authored Decision"),
    );
    assert.equal(readMarkdownSource({ rootDir }).hash, before);
    assert.deepEqual(readRelationGraphSourceHashInputKinds({ rootDir }), []);
  });
});

function writeIndex(
  rootDir: string,
  taskId: string,
  title: string,
  relations: ReadonlyArray<EntityRelationRecord> = [],
): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(
    path.join(taskRoot, "INDEX.md"),
    [
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
      "",
    ].join("\n"),
  );
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
    direction: "directed" as const,
  };
  return {
    relation_id: deriveRelationId(base),
    ...base,
    strength: "strong",
    origin: "declared",
    rationale: "Fixture relation",
    state: "active",
  };
}
