import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalPath,
  isGeneratedOrVendorPath,
  isPathInside,
  isSamePath,
  normalizeSlashes,
  relativePath
} from "../src/cli/path.ts";

test("CLI path helpers normalize logical paths and generated/vendor filters", () => {
  assert.equal(relativePath("/repo", path.join("/repo", "harness", "task.md")), "harness/task.md");
  assert.equal(normalizeSlashes(["harness", "task.md"].join(path.sep)), "harness/task.md");

  assert.equal(isGeneratedOrVendorPath("packages/cli/dist/index.js"), true);
  assert.equal(isGeneratedOrVendorPath("harness/legacy/tasks/old/task_plan.md"), true);
  assert.equal(isGeneratedOrVendorPath("packages/cli/src/index.ts"), false);
});

test("CLI path helpers compare canonical paths and treat the root as inside itself", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "harness-cli-path-"));
  const root = path.join(workspace, "root");
  const child = path.join(root, "child");
  mkdirSync(child, { recursive: true });

  assert.equal(canonicalPath(path.join(root, "missing.md")), path.join(canonicalPath(root), "missing.md"));
  assert.equal(isSamePath(root, path.join(root, ".")), true);
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(root, child), true);
  assert.equal(isPathInside(root, workspace), false);
});

test("CLI path helpers resolve symlinks before inside checks", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "harness-cli-path-symlink-"));
  const root = path.join(workspace, "root");
  const outside = path.join(workspace, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "escape.txt"), "outside\n", "utf8");
  if (!trySymlink(outside, path.join(root, "linked-outside"), "junction")) return;

  assert.equal(isPathInside(root, path.join(root, "linked-outside", "escape.txt")), false);
});

function trySymlink(target: string, linkPath: string, type?: "file" | "dir" | "junction"): boolean {
  try {
    symlinkSync(target, linkPath, type);
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
