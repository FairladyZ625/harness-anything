// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { formatFactFlowRecord, type FactRecord } from "../../src/domain/index.ts";
import { captureProjectionSourceSnapshot } from "../../src/projection/projection-source-snapshot.ts";
import { updateTaskProjectionIncrementally } from "../../src/projection/sqlite-task-incremental-projection.ts";
import {
  readTriadicProjectionSnapshot,
  rebuildTaskProjection
} from "../../src/projection/sqlite-task-projection.ts";
import { withTempStore } from "./helpers.ts";

test("fact edits publish through the projection and corrupted fact rows rebuild consistently", () => {
  withTempStore((rootDir) => {
    const factsPath = seedFactTask(rootDir, factRecord("Before projection refresh"));
    rebuildTaskProjection({ rootDir });
    assert.equal(readTriadicProjectionSnapshot({ rootDir }).facts[0]?.statement, "Before projection refresh");

    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    writeFactDocument(factsPath, factRecord("After projection refresh"));
    const updated = updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [factsPath],
      previousSourceFingerprint
    });

    assert.equal(updated.mode, "incremental");
    const projected = readTriadicProjectionSnapshot({ rootDir });
    assert.equal(projected.facts[0]?.statement, "After projection refresh");

    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const database = new DatabaseSync(projectionPath);
    try {
      database.exec("DROP TABLE task_fact_projection");
    } finally {
      database.close();
    }

    const rebuilt = readTriadicProjectionSnapshot({ rootDir });
    assert.equal(rebuilt.facts[0]?.statement, "After projection refresh");
    assert.equal(rebuilt.warnings.some((warning) => warning.code === "projection_tampered"), true);
  });
});

test("malformed FactFlow records surface projection warnings instead of disappearing silently", () => {
  withTempStore((rootDir) => {
    const factsPath = seedFactTask(rootDir, factRecord("Initially valid"));
    rebuildTaskProjection({ rootDir });
    writeFileSync(factsPath, [
      "# Facts",
      "",
      "- {fact_id: F-DEADBEEF, statement: \"Missing required fields\", confidence: high}",
      ""
    ].join("\n"));

    const snapshot = readTriadicProjectionSnapshot({ rootDir });

    assert.deepEqual(snapshot.facts, []);
    assert.equal(snapshot.warnings.some((warning) =>
      warning.code === "source_malformed" && warning.message.includes("facts.md:3")
    ), true);
  });
});

function seedFactTask(rootDir: string, fact: FactRecord): string {
  const taskId = "task_01J00000000000000000000001";
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Fact projection task",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref: ",
    "  titleSnapshot: Fact projection task",
    "  url: ",
    "  bindingCreatedAt: 2026-07-13T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    "",
    "# Fact projection task",
    ""
  ].join("\n"));
  const factsPath = path.join(taskRoot, "facts.md");
  writeFactDocument(factsPath, fact);
  return factsPath;
}

function writeFactDocument(factsPath: string, fact: FactRecord): void {
  writeFileSync(factsPath, ["# Facts", "", formatFactFlowRecord(fact), ""].join("\n"));
}

function factRecord(statement: string): FactRecord {
  return {
    fact_id: "F-DEADBEEF",
    statement,
    source: "projection-test",
    observedAt: "2026-07-13T00:00:00.000Z",
    confidence: "high",
    memoryClass: "semantic",
    memoryTags: ["pattern"],
    provenance: [{
      runtime: "codex",
      sessionId: "projection-test",
      boundAt: "2026-07-13T00:00:00.000Z"
    }]
  };
}
