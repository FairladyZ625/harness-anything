// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  evaluateEntityDisposition,
  formatFactFlowRecord,
  readEntityCascadeImpact
} from "../../src/index.ts";
import { withTempStore } from "./helpers.ts";

test("entity disposition lower-bound blocks D3 and D4 when task owns anchored facts", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-fact-anchored", "Task Fact Anchored");
    writeFacts(rootDir, "task-fact-anchored", [{
      fact_id: "F-DEADBEEF",
      statement: "This anchored fact makes hard delete unsafe.",
      source: "test",
      observedAt: "2026-07-04T00:00:00.000Z",
      confidence: "high"
    }]);

    const hardDelete = evaluateEntityDisposition({
      rootDir,
      entityRef: "task/task-fact-anchored",
      action: "hard-delete"
    });
    const tombstone = evaluateEntityDisposition({
      rootDir,
      entityRef: "task/task-fact-anchored",
      action: "tombstone"
    });
    const archive = evaluateEntityDisposition({
      rootDir,
      entityRef: "task/task-fact-anchored",
      action: "archive"
    });
    const impact = readEntityCascadeImpact({ rootDir, entityRef: "task/task-fact-anchored" });

    assert.equal(hardDelete.allowed, false);
    assert.equal(tombstone.allowed, false);
    assert.equal(archive.allowed, true);
    assert.equal(hardDelete.lowerBound.activeAnchoredFactCount, 1);
    assert.equal(hardDelete.lowerBound.activeIncomingCount, 0);
    assert.equal(hardDelete.lowerBound.childTaskCount, 0);
    assert.match(hardDelete.reason, /1 anchored fact\(s\), 0 active incoming relation\(s\), and 0 child task\(s\)/u);
    assert.match(hardDelete.reason, /distill evidence into an anchor task/u);
    assert.deepEqual(impact.anchoredFacts.map((fact) => fact.factRef), ["fact/task-fact-anchored/F-DEADBEEF"]);
    assert.deepEqual(impact.impactedRefs, ["fact/task-fact-anchored/F-DEADBEEF"]);
  });
});

test("entity disposition lower-bound blocks D3 and D4 when task owns child tasks", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-parent", "Task Parent");
    writeIndex(rootDir, "task-child", "Task Child", "task-parent");

    const hardDelete = evaluateEntityDisposition({
      rootDir,
      entityRef: "task/task-parent",
      action: "hard-delete"
    });
    const archive = evaluateEntityDisposition({
      rootDir,
      entityRef: "task/task-parent",
      action: "archive"
    });
    const childHardDelete = evaluateEntityDisposition({
      rootDir,
      entityRef: "task/task-child",
      action: "hard-delete"
    });
    const impact = readEntityCascadeImpact({ rootDir, entityRef: "task/task-parent" });

    assert.equal(hardDelete.allowed, false);
    assert.equal(archive.allowed, true);
    assert.equal(childHardDelete.allowed, true);
    assert.equal(hardDelete.lowerBound.childTaskCount, 1);
    assert.match(hardDelete.reason, /0 anchored fact\(s\), 0 active incoming relation\(s\), and 1 child task\(s\)/u);
    assert.match(hardDelete.reason, /archive\/delete\/supersede child tasks before (?:local compatibility )?hard delete/u);
    assert.match(hardDelete.reason, /Production does not offer hard delete/u);
    assert.deepEqual(impact.childTasks.map((child) => child.taskId), ["task-child"]);
    assert.deepEqual(impact.impactedRefs, ["task/task-child"]);
  });
});

function writeIndex(rootDir: string, taskId: string, title: string, parentTaskId?: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v1",
    `task_id: ${taskId}`,
    `title: ${JSON.stringify(title)}`,
    "status: in_progress",
    ...(parentTaskId ? [`parent: ${parentTaskId}`] : []),
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
}

function writeFacts(
  rootDir: string,
  taskId: string,
  facts: ReadonlyArray<{
    readonly fact_id: string;
    readonly statement: string;
    readonly source: string;
    readonly observedAt: string;
    readonly confidence: "low" | "medium" | "high";
  }>
): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "facts.md"), [
    "# Facts",
    "",
    ...facts.map((fact) => formatFactFlowRecord({
      ...fact,
      memoryClass: "episodic",
      memoryTags: [],
      provenance: [{
        runtime: "human",
        sessionId: "human-cli-1783036800000",
        boundAt: "2026-07-04T00:00:00.000Z"
      }]
    })),
    ""
  ].join("\n"));
}
