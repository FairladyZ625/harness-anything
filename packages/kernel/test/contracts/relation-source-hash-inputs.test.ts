// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readMarkdownSource, readTaskProjectionSourceHashInputs } from "../../src/projection/sqlite-task-source.ts";
import { withTempStore } from "../store/helpers.ts";
import { realizedDecisionBody } from "../../../../tools/fixtures/task-plan.mjs";

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
  });
});

function writeIndex(rootDir: string, taskId: string, title: string): void {
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
      "---",
      "",
      `# ${title}`,
      "",
    ].join("\n"),
  );
}
