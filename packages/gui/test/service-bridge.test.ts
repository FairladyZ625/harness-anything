import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalGuiServiceBridge } from "../src/index.ts";

test("GUI service bridge reaches application service while enforcing document path guard", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-bridge-"));
  try {
    writeTaskIndex(rootDir, "task-1", "Task One", "planned");
    const bridge = createLocalGuiServiceBridge(rootDir);

    const list = await bridge.invoke("getTasks", null) as { readonly ok: boolean; readonly tasks: readonly unknown[] };
    assert.equal(list.ok, true);
    assert.equal(list.tasks.length, 1);

    const document = await bridge.invoke("getTaskDocument", { taskId: "task-1", path: "INDEX.md" }) as { readonly ok: boolean; readonly body?: string };
    assert.equal(document.ok, true);
    assert.match(document.body ?? "", /Task One/);

    const rejected = await bridge.invoke("getTaskDocument", { taskId: "task-1", path: "../../../../.harness-private/review.md" }) as { readonly ok: boolean; readonly error?: { readonly code: string } };
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "path_is_private");
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
