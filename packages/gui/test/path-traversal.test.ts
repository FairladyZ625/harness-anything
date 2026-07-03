import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateProjectPath } from "../src/index.ts";

test("path guard rejects traversal, private folder access, absolute escape and file symlink escape", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "ha-gui-outside-"));
  try {
    mkdirSync(path.join(root, "harness/tasks/task-1"), { recursive: true });
    mkdirSync(path.join(root, ".harness-private"), { recursive: true });
    writeFileSync(path.join(outside, "secret.md"), "secret");

    assert.equal(validateProjectPath(root, "harness/tasks/task-1/INDEX.md").ok, true);
    assert.equal(validateProjectPath(root, "../outside.md").reason, "path_outside_project");
    assert.equal(validateProjectPath(root, path.join(outside, "secret.md")).reason, "path_outside_project");
    assert.equal(validateProjectPath(root, "C:\\Users\\name\\secret.md").reason, "path_outside_project");
    assert.equal(validateProjectPath(root, "\\\\server\\share\\secret.md").reason, "path_outside_project");
    assert.equal(validateProjectPath(root, ".harness-private/review.md").reason, "path_is_private");
    if (trySymlink(path.join(outside, "secret.md"), path.join(root, "harness/tasks/task-1/link.md"))) {
      assert.equal(validateProjectPath(root, "harness/tasks/task-1/link.md").reason, "path_outside_project");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("path guard rejects missing files under symlinked parent directories", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "ha-gui-outside-"));
  try {
    mkdirSync(path.join(root, "harness/tasks"), { recursive: true });
    if (!trySymlink(outside, path.join(root, "harness/tasks/outdir"), "junction")) return;

    assert.equal(
      validateProjectPath(root, "harness/tasks/outdir/new.md").reason,
      "path_outside_project"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function trySymlink(target: string, path: string, type?: "file" | "dir" | "junction"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (isWindowsSymlinkPermissionError(error)) return false;
    throw error;
  }
}

function isWindowsSymlinkPermissionError(error: unknown): boolean {
  return process.platform === "win32" &&
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EPERM";
}
