// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { withGuiDaemonEnv } from "./helpers/daemon-generation-lifecycle.ts";

test("GUI daemon bridge honors the project daemon user root", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-settings-daemon-"));
  const authoredRoot = path.join(rootDir, "harness");
  const configuredUserRoot = path.join(rootDir, "project-daemon");
  try {
    mkdirSync(path.join(authoredRoot, "tasks", "task-1"), { recursive: true });
    writeFileSync(path.join(authoredRoot, "harness.yaml"), [
      "schema: harness-anything/v1",
      "settings:",
      "  daemon:",
      "    userRoot: project-daemon",
      ""
    ].join("\n"), "utf8");
    writeFileSync(path.join(authoredRoot, "tasks", "task-1", "INDEX.md"), [
      "---",
      "schema: task-package/v2",
      "task_id: task-1",
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
    ].join("\n"), "utf8");

    const list = await withGuiDaemonEnv(rootDir, async () => {
      return createLocalGuiServiceBridge(rootDir).invoke("getTasks", null) as Promise<{
        readonly ok: boolean;
        readonly tasks: readonly unknown[];
      }>;
    }, { userRoot: false });

    assert.equal(list.ok, true);
    assert.equal(list.tasks.length, 1);
    assert.equal(existsSync(path.join(configuredUserRoot, "registry.json")), true);
    assert.equal(existsSync(path.join(rootDir, ".harness", "registry.json")), false);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 700));
    rmSync(rootDir, { recursive: true, force: true });
  }
});
