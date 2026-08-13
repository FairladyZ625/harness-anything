// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  evaluateEntityDisposition,
  readEntityCascadeImpact
} from "../../src/index.ts";
import { withTempStore } from "./helpers.ts";

test("entity disposition reports child-task cascade impact while writes remain unavailable", () => {
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
    assert.equal(archive.allowed, false);
    assert.equal(childHardDelete.allowed, false);
    assert.equal(hardDelete.lowerBound.childTaskCount, 1);
    assert.match(hardDelete.reason, /does not expose authored task package disposition writes/u);
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
