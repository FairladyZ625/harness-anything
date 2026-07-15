// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHarnessLayout } from "../../kernel/src/index.ts";
import { resolveDeclaredReadScopes, resolveDeclaredWriteScopes } from "../src/commands/extensions/script-scope.ts";

test("script scopes reject external and dangling read symlinks and symlinked custom authored roots", {
  skip: process.platform === "win32"
}, () => {
  const container = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-scope-symlink-"));
  try {
    const rootDir = path.join(container, "project");
    const externalRoot = path.join(container, "external");
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(externalRoot, { recursive: true });
    symlinkSync(externalRoot, path.join(rootDir, "linked-read"));
    const defaultLayout = resolveHarnessLayout(rootDir);
    assert.equal(resolveDeclaredReadScopes(
      ["{{paths.rootDir}}/linked-read/**"],
      defaultLayout,
      path.join(defaultLayout.tasksRoot, "task-read")
    ).ok, false);

    symlinkSync("missing-read-target", path.join(rootDir, "dangling-read"));
    assert.equal(resolveDeclaredReadScopes(
      ["{{paths.rootDir}}/dangling-read/**"],
      defaultLayout,
      path.join(defaultLayout.tasksRoot, "task-read")
    ).ok, false);

    symlinkSync(externalRoot, path.join(rootDir, "linked-harness"));
    const linkedLayout = resolveHarnessLayout({ rootDir, layoutOverrides: { authoredRoot: "linked-harness" } });
    const outputRoot = path.join(linkedLayout.tasksRoot, "task-write");
    assert.equal(resolveDeclaredWriteScopes(["{{outputRoot}}/**"], linkedLayout, outputRoot).ok, false);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("recursive read scopes stop at descendant symlink leaves without rejecting their parent", {
  skip: process.platform === "win32"
}, () => {
  const container = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-read-descendant-symlink-"));
  try {
    const rootDir = path.join(container, "project");
    const externalRoot = path.join(container, "external");
    const externalReadRoot = path.join(rootDir, "external-read-root");
    const danglingReadRoot = path.join(rootDir, "dangling-read-root");
    mkdirSync(externalRoot, { recursive: true });
    mkdirSync(externalReadRoot, { recursive: true });
    mkdirSync(danglingReadRoot, { recursive: true });
    symlinkSync(externalRoot, path.join(externalReadRoot, "escape"));
    symlinkSync("missing-target", path.join(danglingReadRoot, "escape"));
    const layout = resolveHarnessLayout(rootDir);
    const outputRoot = path.join(layout.tasksRoot, "task-read");

    assert.equal(path.relative(
      externalReadRoot,
      realpathSync(path.join(externalReadRoot, "escape"))
    ).startsWith(".."), true);
    assert.equal(resolveDeclaredReadScopes(
      ["{{paths.rootDir}}/external-read-root/**"],
      layout,
      outputRoot
    ).ok, true);
    assert.equal(resolveDeclaredReadScopes(
      ["{{paths.rootDir}}/dangling-read-root/**"],
      layout,
      outputRoot
    ).ok, true);
    assert.equal(resolveDeclaredReadScopes(
      ["{{paths.rootDir}}/external-read-root/escape/**"],
      layout,
      outputRoot
    ).ok, false);
    assert.equal(resolveDeclaredReadScopes(
      ["{{paths.rootDir}}/dangling-read-root/escape/**"],
      layout,
      outputRoot
    ).ok, false);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("authored and local recursive read scopes tolerate descendant symlink mounts", {
  skip: process.platform === "win32"
}, () => {
  const container = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-ledger-symlink-"));
  try {
    const rootDir = path.join(container, "project");
    const externalRoot = path.join(container, "external");
    const layout = resolveHarnessLayout(rootDir);
    mkdirSync(layout.authoredRoot, { recursive: true });
    mkdirSync(layout.localRoot, { recursive: true });
    mkdirSync(externalRoot, { recursive: true });
    symlinkSync(externalRoot, path.join(layout.authoredRoot, "raw-local"));
    symlinkSync(externalRoot, path.join(layout.localRoot, "raw-local"));
    const outputRoot = path.join(layout.tasksRoot, "task-read");

    assert.equal(resolveDeclaredReadScopes(
      ["{{paths.authoredRoot}}/**", "{{paths.localRoot}}/**"],
      layout,
      outputRoot
    ).ok, true);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("recursive read scopes treat symlinks as leaves inside and outside node_modules", {
  skip: process.platform === "win32"
}, () => {
  const container = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-read-node-modules-"));
  try {
    const rootDir = path.join(container, "project");
    const externalRoot = path.join(container, "external");
    const dependencyReadRoot = path.join(rootDir, "dependency-read-root");
    const escapedReadRoot = path.join(rootDir, "escaped-read-root");
    mkdirSync(path.join(dependencyReadRoot, "node_modules/.bin"), { recursive: true });
    mkdirSync(escapedReadRoot, { recursive: true });
    mkdirSync(externalRoot, { recursive: true });
    symlinkSync(externalRoot, path.join(dependencyReadRoot, "node_modules/.bin/tool"));
    symlinkSync(externalRoot, path.join(escapedReadRoot, "escape"));
    const layout = resolveHarnessLayout(rootDir);
    const outputRoot = path.join(layout.tasksRoot, "task-read");

    assert.equal(resolveDeclaredReadScopes(
      ["{{paths.rootDir}}/dependency-read-root/**"],
      layout,
      outputRoot
    ).ok, true);
    assert.equal(resolveDeclaredReadScopes(
      ["{{paths.rootDir}}/escaped-read-root/**"],
      layout,
      outputRoot
    ).ok, true);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});
