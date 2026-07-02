import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { assertNoPortablePathCollisions } from "../../src/layout/index.ts";
import { readTaskPackage, writeDocument } from "../../src/store/markdown-artifact-store.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/write-journal-coordinator.ts";
import { docWrite } from "./helpers.ts";

test("markdown artifact store rejects case-insensitive authored document path collisions when the host filesystem can materialize them", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-portable-path-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks/task-1");
    mkdirSync(path.join(taskRoot, "notes"), { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), indexBody("task-1"), "utf8");
    writeFileSync(path.join(taskRoot, "notes/Progress.md"), "A\n", "utf8");
    writeFileSync(path.join(taskRoot, "notes/progress.md"), "B\n", "utf8");

    const entries = readdirSync(path.join(taskRoot, "notes"));
    if (entries.includes("Progress.md") && entries.includes("progress.md")) {
      assert.throws(
        () => readTaskPackage(rootDir, "task-1"),
        /portable path collision: notes\/Progress\.md, notes\/progress\.md/u
      );
      return;
    }

    assert.throws(
      () => assertNoPortablePathCollisions(["notes/Progress.md", "notes/progress.md"]),
      /portable path collision: notes\/Progress\.md, notes\/progress\.md/u
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("markdown artifact store rejects writes that would collide with an existing portable document path", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-portable-path-write-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks/task-1");
    mkdirSync(path.join(taskRoot, "notes"), { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), indexBody("task-1"), "utf8");
    writeFileSync(path.join(taskRoot, "notes/Progress.md"), "A\n", "utf8");

    assert.throws(
      () => writeDocument(rootDir, { taskId: "task-1", path: "notes/progress.md", body: "B\n" }),
      /portable path collision before write: notes\/Progress\.md, notes\/progress\.md/u
    );
    assert.deepEqual(readdirSync(path.join(taskRoot, "notes")), ["Progress.md"]);
    assert.equal(readFileSync(path.join(taskRoot, "notes/Progress.md"), "utf8"), "A\n");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("WriteCoordinator rejects portable document path collisions before enqueueing the write", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-portable-path-coordinator-"));
  try {
    const taskRoot = path.join(rootDir, "harness/tasks/task-1");
    mkdirSync(path.join(taskRoot, "notes"), { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), indexBody("task-1"), "utf8");
    writeFileSync(path.join(taskRoot, "notes/Progress.md"), "A\n", "utf8");

    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    const result = Effect.runSync(Effect.either(coordinator.enqueue(
      docWrite("op-collision", "task-1", "notes/progress.md", "B\n")
    )));

    assert.equal(result._tag, "Left");
    if (result._tag === "Left") {
      assert.equal(result.left._tag, "WriteRejected");
      assert.equal(result.left.taskId, "task-1");
      assert.match(result.left.reason, /portable path collision before write: notes\/Progress\.md, notes\/progress\.md/u);
    }
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);
    assert.deepEqual(readdirSync(path.join(taskRoot, "notes")), ["Progress.md"]);
    assert.equal(readFileSync(path.join(taskRoot, "notes/Progress.md"), "utf8"), "A\n");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function indexBody(taskId: string): string {
  return [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Task One",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: planned",
    "  ref: ",
    "  titleSnapshot: Task One",
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:test",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    ""
  ].join("\n");
}
