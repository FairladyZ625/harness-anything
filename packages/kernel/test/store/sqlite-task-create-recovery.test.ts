// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { captureProjectionSourceSnapshot } from "../../src/projection/projection-source-snapshot.ts";
import { readDeclaredSourceManifestRows } from "../../src/projection/sqlite-declared-source-manifest.ts";
import { readProjectionSourceCacheSnapshot } from "../../src/projection/sqlite-projection-source-cache.ts";
import { tryReadProjectionDatabase } from "../../src/projection/sqlite-projection-store.ts";
import { rememberProjectionValidation } from "../../src/projection/sqlite-projection-validation-cache.ts";
import { updateTaskProjectionIncrementally } from "../../src/projection/sqlite-task-incremental-projection.ts";
import { rebuildTaskProjection } from "../../src/projection/sqlite-task-projection.ts";
import { withTempStore } from "./helpers.ts";

test("task create self-heals a missing cached projection table instead of leaking a prepare failure", () => {
  withTempStore((rootDir) => {
    writeTask(rootDir, "task-a", "Existing task");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const existing = tryReadProjectionDatabase(projectionPath);
    assert.equal(existing.ok, true);
    if (!existing.ok) return;
    const declaredManifest = readDeclaredSourceManifestRows(projectionPath);
    const sourceCache = readProjectionSourceCacheSnapshot(projectionPath);

    const malformed = new DatabaseSync(projectionPath);
    try {
      malformed.exec("DROP TABLE task_projection");
    } finally {
      malformed.close();
    }
    rememberProjectionValidation(projectionPath, declaredManifest, existing, sourceCache);
    const touchedPath = writeTask(rootDir, "task-b", "New task");

    const result = updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [touchedPath],
      previousSourceFingerprint
    });

    assert.equal(result.mode, "rebuild");
    assert.equal(result.rows.some((row) => row.taskId === "task-b"), true);
    const repaired = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      assert.equal(repaired.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    } finally {
      repaired.close();
    }
  });
});

test("task projection SQL failures name the statement, table, and driver cause", () => {
  withTempStore((rootDir) => {
    writeTask(rootDir, "task-a", "Existing task");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const database = new DatabaseSync(projectionPath);
    try {
      database.exec(`
        CREATE TRIGGER reject_task_create
        BEFORE INSERT ON task_projection
        BEGIN SELECT RAISE(ABORT, 'synthetic task insert rejection'); END
      `);
    } finally {
      database.close();
    }
    const touchedPath = writeTask(rootDir, "task-b", "Rejected task");

    assert.throws(
      () => updateTaskProjectionIncrementally({
        rootDir,
        touchedPaths: [touchedPath],
        previousSourceFingerprint
      }),
      /projection\.task\.upsert.*task_projection.*synthetic task insert rejection/u
    );
  });
});

function writeTask(rootDir: string, taskId: string, title: string): string {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  const indexPath = path.join(taskRoot, "INDEX.md");
  writeFileSync(indexPath, [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: planned",
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-31T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
  return indexPath;
}
