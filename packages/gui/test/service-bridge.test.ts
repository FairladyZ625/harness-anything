import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { apiRouteContracts, createLocalGuiServiceBridge, getShippedGuiBridgeMethods } from "../src/index.ts";

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
    assert.equal(rejected.error?.code, "invalid_payload");

    const windowsPath = await bridge.invoke("getTaskDocument", { taskId: "task-1", path: "C:\\Users\\name\\secret.md" }) as { readonly ok: boolean; readonly error?: { readonly code: string } };
    assert.equal(windowsPath.ok, false);
    assert.equal(windowsPath.error?.code, "invalid_payload");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI service bridge honors explicit authored root context", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-bridge-"));
  try {
    writeTaskIndex(rootDir, "task-1", "Custom GUI Task", "planned", ".custom-harness");
    const bridge = createLocalGuiServiceBridge(rootDir, { authoredRoot: ".custom-harness" });

    const list = await bridge.invoke("getTasks", null) as { readonly ok: boolean; readonly tasks: readonly unknown[] };
    assert.equal(list.ok, true);
    assert.equal(list.tasks.length, 1);

    const document = await bridge.invoke("getTaskDocument", { taskId: "task-1", path: "INDEX.md" }) as { readonly ok: boolean; readonly body?: string };
    assert.equal(document.ok, true);
    assert.match(document.body ?? "", /Custom GUI Task/);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI service bridge resolves project root before guarding task documents", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-bridge-"));
  try {
    mkdirSync(path.join(rootDir, "workspace", "nested"), { recursive: true });
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness", "harness.yaml"), [
      "schema: harness-anything/v1",
      "name: gui-subdir",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      ""
    ].join("\n"), "utf8");
    writeTaskIndex(rootDir, "task-1", "Subdir GUI Task", "planned");
    const bridge = createLocalGuiServiceBridge(path.join(rootDir, "workspace", "nested"));

    const document = await bridge.invoke("getTaskDocument", { taskId: "task-1", path: "INDEX.md" }) as { readonly ok: boolean; readonly body?: string; readonly error?: { readonly code: string } };

    assert.equal(document.ok, true);
    assert.match(document.body ?? "", /Subdir GUI Task/);
    assert.notEqual(document.error?.code, "path_outside_project");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI service bridge shipped methods are registry-driven and deferred methods return explicit errors", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-bridge-"));
  try {
    const bridge = createLocalGuiServiceBridge(rootDir);
    const activeGuiMethods = apiRouteContracts
      .map((route) => "guiBridgeMethod" in route ? route.guiBridgeMethod : undefined)
      .filter((method): method is string => typeof method === "string");

    assert.deepEqual(getShippedGuiBridgeMethods(), activeGuiMethods);
    const shippedMethods = new Set<string>(getShippedGuiBridgeMethods());
    assert.equal(shippedMethods.has("archiveTask"), false);
    assert.equal(shippedMethods.has("openShell"), false);

    const archive = await bridge.invoke("archiveTask", null) as { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } };
    assert.equal(archive.ok, false);
    assert.equal(archive.error?.code, "method_deferred");
    assert.match(archive.error?.hint ?? "", /Archive/);

    const shell = await bridge.invoke("openShell", null) as { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } };
    assert.equal(shell.ok, false);
    assert.equal(shell.error?.code, "method_deferred");
    assert.match(shell.error?.hint ?? "", /terminal sessions/i);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function writeTaskIndex(rootDir: string, taskId: string, title: string, status: string, authoredRoot = "harness"): void {
  mkdirSync(path.join(rootDir, authoredRoot, "tasks", taskId), { recursive: true });
  writeFileSync(path.join(rootDir, authoredRoot, "tasks", taskId, "INDEX.md"), [
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
