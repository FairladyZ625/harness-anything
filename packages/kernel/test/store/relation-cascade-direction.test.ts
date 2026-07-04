import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  deriveRelationId,
  formatRelationFlowRecord,
  readEntityCascadeImpact,
  rebuildTaskProjection,
  type EntityRelationRecord
} from "../../src/index.ts";
import { withTempStore } from "./helpers.ts";

test("entity cascade treats undirected relations as incoming and outgoing on both endpoints", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-undirected-a", "Task Undirected A");
    writeIndex(rootDir, "task-undirected-b", "Task Undirected B");
    const relation = relationRecord({
      source: "task/task-undirected-a",
      target: "task/task-undirected-b",
      type: "relates",
      direction: "undirected"
    });
    writeTaskRelation(rootDir, "task-undirected-a", relation);
    rebuildTaskProjection({ rootDir });

    const fromA = readEntityCascadeImpact({ rootDir, entityRef: "task/task-undirected-a" });
    const fromB = readEntityCascadeImpact({ rootDir, entityRef: "task/task-undirected-b" });

    assert.deepEqual(fromA.incoming.map((edge) => edge.relationId), [relation.relation_id]);
    assert.deepEqual(fromA.outgoing.map((edge) => edge.relationId), [relation.relation_id]);
    assert.deepEqual(fromA.impactedRefs, ["task/task-undirected-b"]);
    assert.deepEqual(fromB.incoming.map((edge) => edge.relationId), [relation.relation_id]);
    assert.deepEqual(fromB.outgoing.map((edge) => edge.relationId), [relation.relation_id]);
    assert.deepEqual(fromB.impactedRefs, ["task/task-undirected-a"]);
  });
});

function writeIndex(rootDir: string, taskId: string, title: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: harness-task/v1",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "status: active",
    "ref: ",
    `titleSnapshot: ${title}`,
    "url: ",
    "bindingCreatedAt: 2026-07-03T00:00:00.000Z",
    "bindingFingerprint: ",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
}

function writeTaskRelation(rootDir: string, taskDirName: string, relation: EntityRelationRecord): void {
  const indexPath = path.join(rootDir, "harness/tasks", taskDirName, "INDEX.md");
  const body = readFileSync(indexPath, "utf8");
  writeFileSync(indexPath, body.replace(/\n---\n\n#/u, `\nrelations:\n${formatRelationFlowRecord(relation)}\n---\n\n#`));
}

function relationRecord(input: {
  readonly source: string;
  readonly target: string;
  readonly type: EntityRelationRecord["type"];
  readonly direction?: EntityRelationRecord["direction"];
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
    strength: "strong",
    origin: "declared",
    rationale: "Fixture relation",
    state: "active"
  };
}
