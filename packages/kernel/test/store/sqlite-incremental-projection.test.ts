import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveRelationId, formatRelationFlowRecord } from "../../src/domain/index.ts";
import type { EntityRelationRecord } from "../../src/domain/index.ts";
import {
  queryDecisionProjection,
  readRelationGraphProjection,
  readTaskProjection,
  rebuildTaskProjection
} from "../../src/projection/sqlite-task-projection.ts";
import { updateTaskProjectionIncrementally } from "../../src/projection/sqlite-task-incremental-projection.ts";
import { readMarkdownSource } from "../../src/projection/sqlite-task-source.ts";

test("incremental projection matches full rebuild across deterministic random write sequences", () => {
  for (const seed of [7, 19, 43, 71]) {
    withProjectionPair((incrementalRoot, rebuildRoot) => {
      seedHarness(incrementalRoot);
      seedHarness(rebuildRoot);
      rebuildTaskProjection({ rootDir: incrementalRoot });
      rebuildTaskProjection({ rootDir: rebuildRoot });

      const random = mulberry32(seed);
      for (let step = 0; step < 36; step += 1) {
        const operation = Math.floor(random() * 5);
        const taskId = ["task-a", "task-b", "task-c"][Math.floor(random() * 3)] ?? "task-a";
        const previousSourceHash = readMarkdownSource(incrementalRoot).hash;
        const touchedPaths = applyRandomProjectionWrite(incrementalRoot, operation, taskId, step, seed);
        applyRandomProjectionWrite(rebuildRoot, operation, taskId, step, seed);

        updateTaskProjectionIncrementally({
          rootDir: incrementalRoot,
          touchedPaths,
          previousSourceHash
        });
        rebuildTaskProjection({ rootDir: rebuildRoot });

        assert.deepEqual(snapshotProjection(incrementalRoot, `incremental seed ${seed} step ${step}`), snapshotProjection(rebuildRoot, `rebuild seed ${seed} step ${step}`), `seed ${seed} step ${step}`);
      }
    });
  }
});

test("incremental projection upserts task rows when package slug differs from task_id", () => {
  withProjectionPair((incrementalRoot, rebuildRoot) => {
    const slug = "task_01ABC-readable-slug";
    const taskId = "task_01ABC";
    writeIndex(incrementalRoot, taskId, "Slugged Task", "active", [], slug);
    writeIndex(rebuildRoot, taskId, "Slugged Task", "active", [], slug);
    rebuildTaskProjection({ rootDir: incrementalRoot });
    rebuildTaskProjection({ rootDir: rebuildRoot });

    const previousSourceHash = readMarkdownSource(incrementalRoot).hash;
    const touchedPath = writeIndex(incrementalRoot, taskId, "Slugged Task Updated", "done", [], slug);
    writeIndex(rebuildRoot, taskId, "Slugged Task Updated", "done", [], slug);

    updateTaskProjectionIncrementally({
      rootDir: incrementalRoot,
      touchedPaths: [touchedPath],
      previousSourceHash
    });
    rebuildTaskProjection({ rootDir: rebuildRoot });

    assert.deepEqual(snapshotProjection(incrementalRoot, "incremental slug mismatch"), snapshotProjection(rebuildRoot, "rebuild slug mismatch"));
  });
});

test("decision queries rebuild stale projection when active decision exists only on disk", () => {
  withProjectionPair((rootDir) => {
    seedHarness(rootDir);
    rebuildTaskProjection({ rootDir });

    writeDecision(rootDir, false, "dec_W6_DISK_ONLY");
    const result = queryDecisionProjection({ rootDir, filters: { state: "active" } });

    assert.equal(result.rows.some((row) => row.decisionId === "dec_W6_DISK_ONLY"), true);
    assert.equal(result.warnings.some((warning) => warning.code === "projection_stale"), true);
  });
});

function withProjectionPair(fn: (incrementalRoot: string, rebuildRoot: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-incremental-projection-"));
  try {
    fn(path.join(rootDir, "incremental"), path.join(rootDir, "rebuild"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function seedHarness(rootDir: string): void {
  for (const taskId of ["task-a", "task-b", "task-c"]) {
    writeIndex(rootDir, taskId, `Task ${taskId}`, "active", []);
  }
  writeFacts(rootDir, "task-a", true);
  writeDecision(rootDir, false);
}

function applyRandomProjectionWrite(rootDir: string, operation: number, taskId: string, step: number, seed: number): ReadonlyArray<string> {
  switch (operation) {
    case 0: {
      const target = taskId === "task-c" ? "task-a" : "task-c";
      const relations = step % 2 === 0 ? [relation(`task/${taskId}`, `task/${target}`, "depends-on", `step ${step}`)] : [];
      return [writeIndex(rootDir, taskId, `Task ${taskId} ${seed}-${step}`, statusFor(step), relations)];
    }
    case 1:
      return [writeModule(rootDir, taskId, `module-${seed % 5}`, `Module ${step}`)];
    case 2:
      return [writeCloseout(rootDir, taskId, step % 2 === 0)];
    case 3:
      return [writeFacts(rootDir, taskId, step % 3 !== 0)];
    default:
      return [writeDecision(rootDir, step % 2 === 0)];
  }
}

function snapshotProjection(rootDir: string, label: string): unknown {
  const tasks = readTaskProjection({ rootDir });
  const decisions = queryDecisionProjection({ rootDir, filters: {} });
  const graph = readRelationGraphProjection({ rootDir });
  assert.equal(tasks.warnings.every((warning) => warning.severity !== "hard-fail"), true, `${label} ${rootDir}: ${JSON.stringify(tasks.warnings)}`);
  assert.equal(decisions.warnings.every((warning) => warning.severity !== "hard-fail"), true, `${label} ${rootDir}: ${JSON.stringify(decisions.warnings)}`);
  assert.equal(graph.warnings.every((warning) => warning.severity !== "hard-fail"), true, `${label} ${rootDir}: ${JSON.stringify(graph.warnings)}`);
  return {
    tasks: tasks.rows,
    decisions: decisions.rows,
    edges: graph.edges,
    coverageRows: graph.coverageRows,
    factAnchors: graph.factAnchors
  };
}

function writeIndex(
  rootDir: string,
  taskId: string,
  title: string,
  status: string,
  relations: ReadonlyArray<EntityRelationRecord>,
  packageSlug = taskId
): string {
  const taskDir = path.join(rootDir, "harness/tasks", packageSlug);
  mkdirSync(taskDir, { recursive: true });
  const indexPath = path.join(taskDir, "INDEX.md");
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
    "vertical: default",
    "preset: default",
    ...(relations.length > 0 ? ["relations:", ...relations.map(formatRelationFlowRecord)] : []),
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
  stamp(indexPath);
  return indexPath;
}

function writeModule(rootDir: string, taskId: string, moduleKey: string, moduleTitle: string): string {
  const modulePath = path.join(rootDir, "harness/tasks", taskId, "module.md");
  mkdirSync(path.dirname(modulePath), { recursive: true });
  writeFileSync(modulePath, [`Module key: ${moduleKey}`, `Module title: ${moduleTitle}`, ""].join("\n"));
  stamp(modulePath);
  return modulePath;
}

function writeCloseout(rootDir: string, taskId: string, present: boolean): string {
  const closeoutPath = path.join(rootDir, "harness/tasks", taskId, "closeout.md");
  if (present) {
    mkdirSync(path.dirname(closeoutPath), { recursive: true });
    writeFileSync(closeoutPath, `# Closeout ${taskId}\n`);
    stamp(closeoutPath);
  } else {
    rmSync(closeoutPath, { force: true });
  }
  return closeoutPath;
}

function writeFacts(rootDir: string, taskId: string, includeRelation: boolean): string {
  const factsPath = path.join(rootDir, "harness/tasks", taskId, "facts.md");
  mkdirSync(path.dirname(factsPath), { recursive: true });
  const factRef = `fact/${taskId}/F-DEADBEEF`;
  writeFileSync(factsPath, [
    "# Facts",
    "",
    "- {fact_id: F-DEADBEEF, statement: \"Incremental projection fact.\", source: \"test\", observedAt: \"2026-07-07T00:00:00.000Z\", confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: \"node-test\", sessionId: \"sqlite-incremental\", boundAt: \"2026-07-07T00:00:00.000Z\"}]}",
    ...(includeRelation ? [
      "",
      "relations:",
      formatRelationFlowRecord(relation(factRef, "decision/dec_W6_INCREMENTAL/CH1", "supports", `fact ${taskId} supports decision`))
    ] : []),
    ""
  ].join("\n"));
  stamp(factsPath);
  return factsPath;
}

function writeDecision(rootDir: string, includeRelation: boolean, decisionId = "dec_W6_INCREMENTAL"): string {
  const decisionDir = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionDir, { recursive: true });
  const decisionPath = path.join(decisionDir, "decision.md");
  writeFileSync(decisionPath, [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    `_coordinatorWatermark: wm-${decisionId}`,
    `title: W6 incremental projection decision ${decisionId}`,
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: [\"projection\"]",
    "  productLines: []",
    "proposedBy: { kind: \"agent\", id: \"test\" }",
    "proposedAt: \"2026-07-07T00:00:00.000Z\"",
    "arbiter: { kind: \"human\", id: \"test\" }",
    "decidedAt: \"2026-07-07T00:00:00.000Z\"",
    "provenance:",
    "  - { runtime: \"node-test\", sessionId: \"sqlite-incremental\", boundAt: \"2026-07-07T00:00:00.000Z\" }",
    "question: \"Should incremental projection match full rebuild?\"",
    "chosen:",
    "  - { id: \"CH1\", text: \"Use incremental projection\" }",
    "rejected:",
    "  - { id: \"RJ1\", text: \"Trust stale cache\", why_not: \"SQLite is derived\" }",
    "claims:",
    "  - { id: \"C1\", text: \"Incremental equals rebuild\" }",
    "relations:",
    ...(includeRelation ? [
      formatRelationFlowRecord(relation(`decision/${decisionId}/CH1`, "fact/task-a/F-DEADBEEF", "evidenced-by", "decision evidence edge"))
    ] : []),
    "---",
    "",
    `# W6 incremental projection decision ${decisionId}`,
    ""
  ].join("\n"));
  stamp(decisionPath);
  return decisionPath;
}

function relation(source: string, target: string, type: EntityRelationRecord["type"], rationale: string): EntityRelationRecord {
  const base = {
    source,
    target,
    type,
    direction: "directed" as const
  };
  return {
    relation_id: deriveRelationId(base),
    ...base,
    strength: "strong",
    origin: "declared",
    rationale,
    state: "active"
  };
}

function statusFor(step: number): string {
  return ["planned", "active", "blocked", "in_review", "done"][step % 5] ?? "active";
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function stamp(filePath: string): void {
  const fixed = new Date("2026-07-07T00:00:00.000Z");
  utimesSync(filePath, fixed, fixed);
}
