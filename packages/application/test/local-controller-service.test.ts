import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeLocalControllerService } from "../src/index.ts";

test("local controller service reads projection and writes through local lifecycle service path", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-app-"));
  try {
    writeTaskIndex(rootDir, "task-1", "Task One", "planned");
    const service = makeLocalControllerService({ rootDir });

    const list = service.getTasks();
    assert.equal(list.ok, true);
    assert.equal(list.tasks.length, 1);

    const detail = service.getTaskDetail({ taskId: "task-1" });
    assert.equal(detail.ok, true);
    assert.deepEqual(detail.documents, [{ path: "INDEX.md" }]);

    const document = service.getTaskDocument({ taskId: "task-1", path: "INDEX.md" });
    assert.equal(document.ok, true);
    assert.match(document.body ?? "", /Task One/);

    assert.deepEqual(await service.setTaskStatus({ taskId: "task-1", status: "active" }), { ok: true });
    assert.deepEqual(await service.setTaskStatus({ taskId: "task-1", status: "done" }), {
      ok: false,
      error: {
        code: "terminal_status_requires_task_complete",
        hint: "Use task-complete after review, CI, and closeout gates pass."
      }
    });
    assert.deepEqual(await service.setTaskStatus({ taskId: "task-1", status: "cancelled" }), {
      ok: false,
      error: {
        code: "terminal_status_requires_task_complete",
        hint: "Terminal cancellation requires an audited recovery path."
      }
    });
    assert.match(readFileSync(path.join(rootDir, "harness/planning/tasks/task-1/INDEX.md"), "utf8"), /status: active/);
    assert.deepEqual(await service.appendTaskProgress({ taskId: "task-1", text: "GUI update" }), { ok: true });
    assert.match(readFileSync(path.join(rootDir, "harness/planning/tasks/task-1/progress.md"), "utf8"), /GUI update/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function writeTaskIndex(rootDir: string, taskId: string, title: string, status: string): void {
  mkdirSync(path.join(rootDir, "harness/planning/tasks", taskId), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/planning/tasks", taskId, "INDEX.md"), [
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
    "  bindingFingerprint: sha256:test",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    ""
  ].join("\n"), "utf8");
}
