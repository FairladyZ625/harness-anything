// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { captureProjectionSourceSnapshot } from "../../src/projection/projection-source-snapshot.ts";
import { updateTaskProjectionIncrementally } from "../../src/projection/sqlite-task-incremental-projection.ts";
import { readTaskProjection, rebuildTaskProjection } from "../../src/projection/sqlite-task-projection.ts";

test("fresh processes reuse persisted task decision and attribution bodies", () => {
  withTempProjection((rootDir) => {
    seedHarness(rootDir);
    writeAttributionEvent(rootDir, "event-fresh-a", "task/task-a");
    writeAttributionEvent(rootDir, "event-fresh-b", "task/task-b");
    rebuildTaskProjection({ rootDir });

    const result = runFreshProcess(rootDir, freshProjectionBodyCacheReaderScript);

    assert.deepEqual(result, {
      taskBodiesRead: 0,
      decisionBodiesRead: 0,
      attributionBodiesRead: 0,
      warnings: []
    });
  });
});

test("fresh process single task changes read only the changed authored body", () => {
  withTempProjection((rootDir) => {
    seedHarness(rootDir);
    writeAttributionEvent(rootDir, "event-fresh-a", "task/task-a");
    writeAttributionEvent(rootDir, "event-fresh-b", "task/task-b");
    rebuildTaskProjection({ rootDir });
    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const touchedPath = writeIndex(rootDir, "task-b", "Task task-b changed", "done");

    const result = runFreshIncrementalProcess(rootDir, touchedPath, previousSourceFingerprint);

    assert.deepEqual(result, {
      taskBodiesRead: 1,
      decisionBodiesRead: 0,
      attributionBodiesRead: 0,
      mode: "incremental"
    });
    assert.equal(readTaskProjection({ rootDir }).rows.find((row) => row.taskId === "task-b")?.canonicalStatus, "done");
  });
});

test("fresh process single decision changes read only the changed authored body", () => {
  withTempProjection((rootDir) => {
    seedHarness(rootDir);
    writeAttributionEvent(rootDir, "event-fresh-a", "task/task-a");
    rebuildTaskProjection({ rootDir });
    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const touchedPath = writeDecision(rootDir, "Changed cached decision");

    const result = runFreshIncrementalProcess(rootDir, touchedPath, previousSourceFingerprint);

    assert.deepEqual(result, {
      taskBodiesRead: 0,
      decisionBodiesRead: 1,
      attributionBodiesRead: 0,
      mode: "incremental"
    });
  });
});

test("fresh process single attribution addition reads only the new shard", () => {
  withTempProjection((rootDir) => {
    seedHarness(rootDir);
    writeAttributionEvent(rootDir, "event-fresh-a", "task/task-a");
    writeAttributionEvent(rootDir, "event-fresh-b", "task/task-b");
    rebuildTaskProjection({ rootDir });
    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const touchedPath = writeAttributionEvent(rootDir, "event-fresh-c", "task/task-c");

    const result = runFreshIncrementalProcess(rootDir, touchedPath, previousSourceFingerprint);

    assert.deepEqual(result, {
      taskBodiesRead: 0,
      decisionBodiesRead: 0,
      attributionBodiesRead: 1,
      mode: "incremental"
    });
  });
});

test("persisted absent source watches detect the first task without a full rebuild", () => {
  withTempProjection((rootDir) => {
    rebuildTaskProjection({ rootDir });
    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const touchedPath = writeIndex(rootDir, "task-first", "First task", "active");

    const result = updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [touchedPath],
      previousSourceFingerprint
    });

    assert.equal(result.mode, "incremental");
    assert.equal(result.rows[0]?.taskId, "task-first");
    assert.equal(readTaskProjection({ rootDir }).warnings.some((warning) => warning.code === "projection_stale"), false);
  });
});

test("persisted source watches detect an INDEX created inside an existing task directory", () => {
  withTempProjection((rootDir) => {
    mkdirSync(path.join(rootDir, "harness/tasks/task-late-index"), { recursive: true });
    rebuildTaskProjection({ rootDir });
    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const touchedPath = writeIndex(rootDir, "task-late-index", "Late index", "active");

    const result = runFreshIncrementalProcessWithRows(rootDir, touchedPath, previousSourceFingerprint);

    assert.equal(result.mode, "incremental");
    assert.deepEqual(result.taskIds, ["task-late-index"]);
  });
});

test("persisted source caches never cross authored layout identities", () => {
  withTempProjection((rootDir) => {
    writeIndex(rootDir, "task-layout", "Default layout task", "active");
    rebuildTaskProjection({ rootDir });
    writeIndex(rootDir, "task-layout", "Alternate layout task", "active", "alternate");

    const result = readTaskProjection({
      rootDir,
      layoutOverrides: { authoredRoot: "alternate" }
    });

    assert.equal(result.rows[0]?.title, "Alternate layout task");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_stale"), true);
  });
});

test("single task changes never rewrite unchanged persisted source rows", () => {
  withTempProjection((rootDir) => {
    seedHarness(rootDir);
    writeAttributionEvent(rootDir, "event-locality-a", "task/task-a");
    writeAttributionEvent(rootDir, "event-locality-b", "task/task-b");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.exec(`
        CREATE TRIGGER reject_unchanged_source_file_rewrite
        BEFORE INSERT ON projection_source_cache_files
        WHEN NEW.source_path <> 'harness/tasks/task-b/INDEX.md'
        BEGIN SELECT RAISE(ABORT, 'unchanged source row rewritten'); END
      `);
    } finally {
      db.close();
    }
    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const touchedPath = writeIndex(rootDir, "task-b", "Task task-b changed", "done");

    const result = updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [touchedPath],
      previousSourceFingerprint
    });

    assert.equal(result.mode, "incremental");
    const updated = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      assert.match(String(updated.prepare(`
        SELECT body FROM projection_source_cache_files
        WHERE cache_kind = 'task' AND source_path = 'harness/tasks/task-b/INDEX.md'
      `).get()?.body), /Task task-b changed/u);
      assert.equal(updated.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'trigger' AND name = 'reject_unchanged_source_file_rewrite'
      `).get()?.count, 1);
    } finally {
      updated.close();
    }
  });
});

test("single attribution additions only insert the new SQL rows", () => {
  withTempProjection((rootDir) => {
    seedHarness(rootDir);
    writeAttributionEvent(rootDir, "event-locality-a", "task/task-a");
    writeAttributionEvent(rootDir, "event-locality-b", "task/task-b");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.exec(`
        CREATE TRIGGER reject_existing_attribution_source_rewrite
        BEFORE INSERT ON projection_source_cache_files
        WHEN NEW.cache_kind = 'attribution'
          AND NEW.source_path <> 'harness/attribution-events/event-locality-c.jsonl'
        BEGIN SELECT RAISE(ABORT, 'existing attribution source rewritten'); END;
        CREATE TRIGGER reject_existing_attribution_event_rewrite
        BEFORE INSERT ON attribution_events
        WHEN NEW.event_id <> 'event-locality-c'
        BEGIN SELECT RAISE(ABORT, 'existing attribution event rewritten'); END
      `);
    } finally {
      db.close();
    }
    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const touchedPath = writeAttributionEvent(rootDir, "event-locality-c", "task/task-c");

    const result = updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [touchedPath],
      previousSourceFingerprint
    });

    assert.equal(result.mode, "incremental");
    const updated = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      assert.equal(updated.prepare("SELECT COUNT(*) AS count FROM attribution_events").get()?.count, 3);
      assert.equal(updated.prepare(`
        SELECT COUNT(*) AS count FROM projection_source_cache_files WHERE cache_kind = 'attribution'
      `).get()?.count, 3);
    } finally {
      updated.close();
    }
  });
});

function runFreshProcess(rootDir: string, script: string): unknown {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HARNESS_ROOT: rootDir },
    encoding: "utf8"
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
}

function runFreshIncrementalProcess(
  rootDir: string,
  touchedPath: string,
  previousSourceFingerprint: string
): unknown {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", freshIncrementalSourceCacheReaderScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HARNESS_ROOT: rootDir,
      HARNESS_PREVIOUS_SOURCE_FINGERPRINT: previousSourceFingerprint,
      HARNESS_TOUCHED_PATH: touchedPath
    },
    encoding: "utf8"
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
}

function runFreshIncrementalProcessWithRows(
  rootDir: string,
  touchedPath: string,
  previousSourceFingerprint: string
): { readonly mode: string; readonly taskIds: ReadonlyArray<string> } {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", freshIncrementalRowsReaderScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HARNESS_ROOT: rootDir,
      HARNESS_PREVIOUS_SOURCE_FINGERPRINT: previousSourceFingerprint,
      HARNESS_TOUCHED_PATH: touchedPath
    },
    encoding: "utf8"
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim()) as { readonly mode: string; readonly taskIds: ReadonlyArray<string> };
}

function withTempProjection(run: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-projection-source-cache-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function seedHarness(rootDir: string): void {
  for (const taskId of ["task-a", "task-b", "task-c"]) {
    writeIndex(rootDir, taskId, `Task ${taskId}`, "active");
  }
  writeDecision(rootDir, "Cached decision");
}

function writeIndex(rootDir: string, taskId: string, title: string, status: string, authoredRoot = "harness"): string {
  const indexPath = path.join(rootDir, authoredRoot, "tasks", taskId, "INDEX.md");
  mkdirSync(path.dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-07T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "---",
    ""
  ].join("\n"));
  stamp(indexPath);
  return indexPath;
}

function writeDecision(rootDir: string, title: string): string {
  const decisionPath = path.join(rootDir, "harness/decisions/decision-cache/decision.md");
  mkdirSync(path.dirname(decisionPath), { recursive: true });
  writeFileSync(decisionPath, [
    "---",
    "schema: decision-package/v1",
    "decision_id: dec_CACHE",
    "_coordinatorWatermark: wm-cache",
    `title: ${title}`,
    "state: active",
    "question: Cache authored sources?",
    "chosen: []",
    "rejected: []",
    "claims: []",
    "relations: []",
    "---",
    ""
  ].join("\n"));
  stamp(decisionPath);
  return decisionPath;
}

function writeAttributionEvent(rootDir: string, eventId: string, entityId: string): string {
  const eventPath = path.join(rootDir, "harness/attribution-events", `${eventId}.jsonl`);
  mkdirSync(path.dirname(eventPath), { recursive: true });
  writeFileSync(eventPath, `${JSON.stringify({
    schema: "attribution-event/v1",
    eventId,
    opId: `op-${eventId}`,
    journalRecordSchema: "write-journal/v2",
    entityId,
    kind: "progress_append",
    actor: {
      principal: { kind: "person", personId: "person_test" },
      executor: { kind: "agent", id: "agent_test" }
    },
    principalSource: {
      kind: "local-configured",
      authority: "harness.yaml",
      authoritySha256: `sha256:${"0".repeat(64)}`
    },
    executorSource: "client-asserted",
    at: "2026-07-07T00:00:00.000Z",
    recordedAt: "2026-07-07T00:00:01.000Z",
    payloadHash: `sha256:${"1".repeat(64)}`,
    payloadRef: {
      path: `.harness/payloads/${eventId}.json`,
      sha256: `sha256:${"1".repeat(64)}`
    }
  })}\n`);
  stamp(eventPath);
  return eventPath;
}

function stamp(filePath: string): void {
  const fixed = new Date("2026-07-07T00:00:00.000Z");
  utimesSync(filePath, fixed, fixed);
}

const bodyCounterPrelude = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalReadFileSync = fs.readFileSync;
const counts = { taskBodiesRead: 0, decisionBodiesRead: 0, attributionBodiesRead: 0 };
fs.readFileSync = function(input, ...args) {
  const inputPath = typeof input === "string" ? input : "";
  if (inputPath.endsWith("/INDEX.md") && inputPath.includes("/harness/tasks/")) counts.taskBodiesRead += 1;
  if (inputPath.includes("/harness/decisions/")) counts.decisionBodiesRead += 1;
  if (inputPath.includes("/harness/attribution-events/")) counts.attributionBodiesRead += 1;
  return Reflect.apply(originalReadFileSync, this, [input, ...args]);
};
syncBuiltinESMExports();
`;

const freshProjectionBodyCacheReaderScript = `${bodyCounterPrelude}
const { readTaskProjection } = await import("./packages/kernel/src/projection/sqlite-task-projection.ts");
const projection = readTaskProjection({ rootDir: process.env.HARNESS_ROOT });
process.stdout.write(JSON.stringify({
  ...counts,
  warnings: projection.warnings.map((warning) => warning.code)
}));
`;

const freshIncrementalSourceCacheReaderScript = `${bodyCounterPrelude}
const { updateTaskProjectionIncrementally } = await import("./packages/kernel/src/projection/sqlite-task-incremental-projection.ts");
const result = updateTaskProjectionIncrementally({
  rootDir: process.env.HARNESS_ROOT,
  touchedPaths: [process.env.HARNESS_TOUCHED_PATH],
  previousSourceFingerprint: process.env.HARNESS_PREVIOUS_SOURCE_FINGERPRINT
});
process.stdout.write(JSON.stringify({ ...counts, mode: result.mode }));
`;

const freshIncrementalRowsReaderScript = `
const { updateTaskProjectionIncrementally } = await import("./packages/kernel/src/projection/sqlite-task-incremental-projection.ts");
const result = updateTaskProjectionIncrementally({
  rootDir: process.env.HARNESS_ROOT,
  touchedPaths: [process.env.HARNESS_TOUCHED_PATH],
  previousSourceFingerprint: process.env.HARNESS_PREVIOUS_SOURCE_FINGERPRINT
});
process.stdout.write(JSON.stringify({ mode: result.mode, taskIds: result.rows.map((row) => row.taskId) }));
`;
