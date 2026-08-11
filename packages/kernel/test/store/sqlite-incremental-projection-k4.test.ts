// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { deriveRelationId, formatRelationFlowRecord, type EntityRelationRecord } from "../../src/domain/index.ts";
import { captureProjectionSourceSnapshot } from "../../src/projection/projection-source-snapshot.ts";
import { updateTaskProjectionIncrementally } from "../../src/projection/sqlite-task-incremental-projection.ts";
import { rebuildTaskProjection } from "../../src/projection/sqlite-task-projection.ts";

test("an unreferenced relation-free task addition leaves the persisted relation subgraph untouched", () => {
  withProjectionRoot((rootDir) => {
    seedRelationGraph(rootDir);
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const database = new DatabaseSync(projectionPath);
    let initialEdgeCount: number;
    try {
      initialEdgeCount = Number(database.prepare("SELECT COUNT(*) AS count FROM relation_edges").get()?.count);
      assert.ok(initialEdgeCount > 0);
      database.exec(`
        CREATE TRIGGER reject_unaffected_relation_graph_delete
        BEFORE DELETE ON relation_edges
        BEGIN SELECT RAISE(FAIL, 'unaffected relation graph rewritten'); END
      `);
    } finally {
      database.close();
    }

    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const touchedPath = writeTask(rootDir, "task-isolated", []);
    const result = updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [touchedPath],
      previousSourceFingerprint
    });

    assert.equal(result.mode, "incremental");
    const updated = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      assert.equal(updated.prepare("SELECT COUNT(*) AS count FROM relation_edges").get()?.count, initialEdgeCount);
      assert.equal(updated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'reject_unaffected_relation_graph_delete'").get()?.count, 1);
    } finally {
      updated.close();
    }
  });
});

test("a relation edit updates only changed graph rows", () => {
  withProjectionRoot((rootDir) => {
    const changedRelation = relation("task/task-a", "task/task-b", "before");
    seedRelationGraph(rootDir, changedRelation);
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const database = new DatabaseSync(projectionPath);
    let protectedRelationId: string;
    try {
      protectedRelationId = String(database.prepare(
        "SELECT relation_id FROM relation_edges WHERE relation_id <> ? ORDER BY relation_id LIMIT 1"
      ).get(changedRelation.relation_id)?.relation_id ?? "");
      assert.ok(protectedRelationId);
      database.exec(`
        CREATE TRIGGER reject_unaffected_relation_delete
        BEFORE DELETE ON relation_edges
        WHEN OLD.relation_id = '${protectedRelationId}'
        BEGIN SELECT RAISE(FAIL, 'unaffected relation row deleted'); END
      `);
    } finally {
      database.close();
    }

    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const touchedPath = writeTask(rootDir, "task-a", [{ ...changedRelation, rationale: "after" }]);
    const result = updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [touchedPath],
      previousSourceFingerprint
    });

    assert.equal(result.mode, "incremental");
    const updated = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      assert.equal(updated.prepare("SELECT COUNT(*) AS count FROM relation_edges WHERE relation_id = ?")
        .get(protectedRelationId)?.count, 1);
      assert.equal(updated.prepare("SELECT rationale FROM relation_edges WHERE relation_id = ?")
        .get(changedRelation.relation_id)?.rationale, "after");
    } finally {
      updated.close();
    }
  });
});

function withProjectionRoot(run: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-k4-relation-projection-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function seedRelationGraph(rootDir: string, first = relation("task/task-a", "task/task-b", "existing")): void {
  writeTask(rootDir, "task-a", [first]);
  writeTask(rootDir, "task-b", [relation("task/task-b", "task/task-c", "unaffected")]);
  writeTask(rootDir, "task-c", []);
}

function writeTask(rootDir: string, taskId: string, relations: ReadonlyArray<EntityRelationRecord>): string {
  const taskDir = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  const indexPath = path.join(taskDir, "INDEX.md");
  const title = `Task ${taskId}`;
  writeFileSync(indexPath, [
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
    "  bindingCreatedAt: 2026-07-07T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    ...(relations.length > 0 ? ["relations:", ...relations.map(formatRelationFlowRecord)] : []),
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
  return indexPath;
}

function relation(source: string, target: string, rationale: string): EntityRelationRecord {
  const base = { source, target, type: "depends-on" as const, direction: "directed" as const };
  return {
    relation_id: deriveRelationId(base),
    ...base,
    strength: "strong",
    origin: "declared",
    rationale,
    state: "active"
  };
}
