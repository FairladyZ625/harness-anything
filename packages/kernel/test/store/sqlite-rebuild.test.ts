import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { checkTaskProjection, hashTaskProjectionRows, readTaskProjection, rebuildTaskProjection } from "../../src/index.ts";
import { makeJournaledWriteCoordinator, makeMarkdownArtifactStore } from "../../src/store/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("markdown artifact store remains the rebuildable source of truth without SQLite", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-1", "task-1", "task_plan.md", "# Task")));
    Effect.runSync(coordinator.flush("explicit"));

    rmSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { force: true });

    const store = makeMarkdownArtifactStore({ rootDir });
    const taskPackage = Effect.runSync(store.readTaskPackage("task-1"));

    assert.equal(taskPackage.disposition, "active");
    assert.deepEqual(taskPackage.documents.map((document) => document.path), ["task_plan.md"]);
    assert.equal(taskPackage.documents[0]?.body, "# Task");
  });
});

test("markdown artifact store reads package disposition from INDEX frontmatter", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-active", "Task Active", "active", "active");
    writeIndex(rootDir, "task-missing", "Task Missing", "active", null);
    writeIndex(rootDir, "task-archived", "Task Archived", "done", "archived");
    writeIndex(rootDir, "task-tombstoned", "Task Tombstoned", "cancelled", "tombstoned");

    const store = makeMarkdownArtifactStore({ rootDir });

    assert.equal(Effect.runSync(store.readTaskPackage("task-active")).disposition, "active");
    assert.equal(Effect.runSync(store.readTaskPackage("task-missing")).disposition, "active");
    assert.equal(Effect.runSync(store.readTaskPackage("task-archived")).disposition, "archived");
    assert.equal(Effect.runSync(store.readTaskPackage("task-tombstoned")).disposition, "tombstoned");
  });
});

test("markdown artifact store rejects invalid package disposition", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-invalid", "Task Invalid", "active", "typo");

    const store = makeMarkdownArtifactStore({ rootDir });

    assert.throws(
      () => Effect.runSync(store.readTaskPackage("task-invalid")),
      /invalid package disposition/
    );
  });
});

test("SQLite task projection rebuild is deterministic after cache deletion", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    writeIndex(rootDir, "task-2", "Task Two", "done");
    writeFileSync(path.join(rootDir, "harness/tasks/task-2/closeout.md"), "# Closeout\n");

    const first = rebuildTaskProjection({ rootDir }).rows;
    rmSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { force: true });
    const second = rebuildTaskProjection({ rootDir }).rows;

    assert.deepEqual(second, first);
    assert.equal(second[0]?.sourcePath, "harness/tasks/task-1/INDEX.md");
    assert.equal(second[0]?.source, "local-document");
    assert.equal(second[1]?.closeoutReadiness, "ready");
  });
});

test("SQLite projection rebuild materializes decision rows for query readers", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    writeDecision(rootDir, "dec_M5_E72_SELFHOST", "wm-1");

    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT decision_id, legacy_id, state FROM decision_projection WHERE legacy_id = ?").get("E72") as Record<string, unknown>;
      assert.equal(row.decision_id, "dec_M5_E72_SELFHOST");
      assert.equal(row.legacy_id, "E72");
      assert.equal(row.state, "active");
    } finally {
      db.close();
    }
  });
});

test("SQLite task projection row hash is deterministic and content-addressed", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-2", "Task Two", "done");
    writeIndex(rootDir, "task-1", "Task One", "active");

    const first = rebuildTaskProjection({ rootDir }).rows;
    const second = [...first].reverse();

    assert.equal(hashTaskProjectionRows(second), hashTaskProjectionRows(first));
    const indexPath = path.join(rootDir, "harness/tasks/task-1/INDEX.md");
    utimesSync(indexPath, new Date("2026-06-12T01:00:00.000Z"), new Date("2026-06-12T01:00:00.000Z"));
    assert.equal(hashTaskProjectionRows(rebuildTaskProjection({ rootDir }).rows), hashTaskProjectionRows(first));

    writeIndex(rootDir, "task-1", "Renamed Task One", "active");
    assert.notEqual(hashTaskProjectionRows(rebuildTaskProjection({ rootDir }).rows), hashTaskProjectionRows(first));
  });
});

test("task projection auto-rebuilds when markdown source changes", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "planned");
    rebuildTaskProjection({ rootDir });
    writeIndex(rootDir, "task-1", "Task One", "active");

    const result = readTaskProjection({ rootDir });

    assert.equal(result.rows[0]?.canonicalStatus, "active");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_stale"), true);
  });
});

test("generated SQLite edits are reported and rebuilt from markdown truth", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.prepare("UPDATE task_projection SET title = ? WHERE task_id = ?").run("Edited In Projection", "task-1");
    } finally {
      db.close();
    }

    const result = checkTaskProjection({ rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.rows[0]?.title, "Task One");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_tampered"), true);
    assert.equal(result.warnings.every((warning) => typeof warning.source === "string" && typeof warning.severity === "string"), true);
    assert.equal(result.report.axes.some((axis) => axis.axis === "generated-cache" && axis.hardFailCount === 1), true);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md"), "utf8").includes("Edited In Projection"), false);
  });
});

test("generated SQLite timestamp edits are reported even though projection hashes ignore mtimes", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.prepare("UPDATE task_projection SET updated_at = ? WHERE task_id = ?").run("1999-01-01T00:00:00.000Z", "task-1");
    } finally {
      db.close();
    }

    const result = checkTaskProjection({ rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.warnings.some((warning) => warning.code === "projection_tampered"), true);
    assert.notEqual(result.rows[0]?.updatedAt, "1999-01-01T00:00:00.000Z");
  });
});

test("corrupted SQLite projection is reported with a stable warning and rebuilt from markdown", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.prepare("UPDATE task_projection SET created_by_json = ? WHERE task_id = ?").run("{bad-json", "task-1");
    } finally {
      db.close();
    }

    const result = checkTaskProjection({ rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.rows[0]?.title, "Task One");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_tampered"), true);
  });
});

test("malformed task source is a checker error and not authored by projection reads", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, "harness/tasks/bad-task"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/tasks/bad-task/INDEX.md"), "# Missing frontmatter\n");

    const result = checkTaskProjection({ rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.rows.length, 0);
    assert.equal(result.warnings.some((warning) => warning.code === "source_malformed"), true);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/bad-task/INDEX.md"), "utf8"), "# Missing frontmatter\n");
  });
});

test("post-merge check reports missing and duplicate decision coordinator watermarks", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    writeDecision(rootDir, "dec_MISSING", "");
    writeDecision(rootDir, "dec_DUPLICATE_A", "wm-duplicate");
    writeDecision(rootDir, "dec_DUPLICATE_B", "wm-duplicate");

    const result = checkTaskProjection({ rootDir, postMerge: true });

    assert.equal(result.ok, false);
    assert.equal(result.warnings.some((warning) => warning.code === "decision_watermark_missing"), true);
    assert.equal(result.warnings.some((warning) => warning.code === "decision_watermark_duplicate"), true);
  });
});

function writeIndex(
  rootDir: string,
  taskId: string,
  title: string,
  status: string,
  packageDisposition: string | null = "active"
): void {
  const dispositionLines = packageDisposition === null ? [] : [`packageDisposition: ${packageDisposition}`];
  mkdirSync(path.join(rootDir, "harness/tasks", taskId), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/tasks", taskId, "INDEX.md"), [
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
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    ...dispositionLines,
    "vertical: default",
    "preset: default",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
}

function writeDecision(rootDir: string, decisionId: string, watermark: string): void {
  const lines = [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    ...(watermark ? [`_coordinatorWatermark: ${watermark}`] : []),
    "title: Test decision",
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: [\"m5-circulation\"]",
    "  productLines: []",
    "proposedBy: { kind: \"agent\", id: \"test\" }",
    "proposedAt: \"2026-07-04T00:00:00.000Z\"",
    "arbiter: { kind: \"human\", id: \"ZeyuLi\" }",
    "decidedAt: \"2026-07-04T00:00:00.000Z\"",
    "provenance:",
    "  - { runtime: \"human\", sessionId: \"human-cli-1\", boundAt: \"2026-07-04T00:00:00.000Z\" }",
    "question: \"Should projection materialize decisions?\"",
    "chosen:",
    "  - { id: \"CH1\", text: \"Use D4 projection\" }",
    "rejected:",
    "  - { id: \"RJ1\", text: \"Use markdown scans\", why_not: \"Query path must align\" }",
    "claims:",
    "  - { id: \"C1\", text: \"Decision projection exists\" }",
    "relations:",
    "---",
    "",
    "# Test decision",
    ""
  ];
  const decisionRoot = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), lines.join("\n"));
}
