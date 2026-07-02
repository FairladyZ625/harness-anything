import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { resolveEntityRoot } from "../../src/layout/index.ts";

function makeHarnessRoot(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-root-"));
  const tasksRoot = path.join(rootDir, "harness", "tasks");
  mkdirSync(path.join(tasksRoot, "task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q-owner"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\n", "utf8");
  writeFileSync(path.join(tasksRoot, "task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q-owner", "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    "task_id: task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q",
    "---",
    ""
  ].join("\n"), "utf8");
  return rootDir;
}

test("entity root resolver maps task refs to the task package index", () => {
  const rootDir = makeHarnessRoot();

  const resolved = resolveEntityRoot(rootDir, "task/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q");

  assert.equal(resolved.rootPath, path.join(rootDir, "harness", "tasks", "task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q-owner"));
  assert.equal(resolved.documentPath, path.join(resolved.rootPath, "INDEX.md"));
});

test("entity root resolver maps decision refs to the decision document without creating it", () => {
  const rootDir = makeHarnessRoot();

  const resolved = resolveEntityRoot(rootDir, "decision/dec_01K7Z/C1", "write");

  assert.equal(resolved.rootPath, path.join(rootDir, "harness", "decisions", "decision-dec_01K7Z"));
  assert.equal(resolved.documentPath, path.join(resolved.rootPath, "decision.md"));
  assert.equal(resolved.anchor, "C1");
});

test("entity root resolver maps fact refs to the owner task facts ledger", () => {
  const rootDir = makeHarnessRoot();

  const resolved = resolveEntityRoot(rootDir, "fact/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q/F-a3f2");

  assert.equal(resolved.rootPath, path.join(rootDir, "harness", "tasks", "task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q-owner"));
  assert.equal(resolved.documentPath, path.join(resolved.rootPath, "facts.md"));
  assert.equal(resolved.anchor, "F-a3f2");
});

test("entity root resolver rejects unknown, external, and traversal-like refs", () => {
  const rootDir = makeHarnessRoot();

  assert.throws(() => resolveEntityRoot(rootDir, "issue/123"), /invalid entity ref/u);
  assert.throws(() => resolveEntityRoot(rootDir, "team-a:task/task_01JY1H4J1Y8Y9G7FZ6MZ4W0N8Q"), /external entity ref/u);
  assert.throws(() => resolveEntityRoot(rootDir, "decision/../C1"), /invalid entity ref/u);
});
