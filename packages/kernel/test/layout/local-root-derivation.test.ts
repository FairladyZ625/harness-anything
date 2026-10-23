// harness-test-tier: fast
// Every piece of local ledger state is derived from layout.localRoot, so a repository that renames
// its local root keeps the default `.harness` directory untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHarnessLayout } from "../../src/layout/index.ts";
import { defaultLifecycleTaskProjectionPath } from "../../src/projection/rebuildable-task-projection.ts";

function repoWithLocalRoot(localRoot: string): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-local-root-"));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    `schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: ${localRoot}\n`,
  );
  return rootDir;
}

test("a renamed local root moves every derived local path off the default directory", () => {
  const rootDir = repoWithLocalRoot(".harness.nosync");
  try {
    const layout = resolveHarnessLayout(rootDir),
      localRoot = path.join(rootDir, ".harness.nosync");
    assert.equal(layout.localRoot, localRoot);
    assert.equal(layout.cacheRoot, path.join(localRoot, "cache"));
    assert.equal(layout.taskProjectionPath, path.join(localRoot, "cache", "task.sqlite"));
    assert.equal(layout.generatedRoot, path.join(localRoot, "generated"));
    assert.equal(layout.claimsRoot, path.join(localRoot, "adopt-claims"));
    assert.equal(layout.settingsLocalPath, path.join(localRoot, "settings.local.json"));
    assert.equal(defaultLifecycleTaskProjectionPath(rootDir), layout.taskProjectionPath);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a directory that belongs to no layout resolves upward, so callers there must name their path", () => {
  // A fleet replica generation directory carries no harness.yaml: the parser walks up and returns
  // the enclosing repository's layout. That is why every fleet reader passes the generation's own
  // projection path explicitly, and why the archive member namespace stays fixed.
  const rootDir = repoWithLocalRoot(".harness.nosync"),
    generationDir = path.join(rootDir, "view", "generations", "generation-1");
  try {
    mkdirSync(generationDir, { recursive: true });
    const layout = resolveHarnessLayout(generationDir);
    assert.equal(layout.rootDir, rootDir);
    assert.equal(layout.taskProjectionPath, path.join(rootDir, ".harness.nosync", "cache", "task.sqlite"));
    assert.notEqual(layout.taskProjectionPath, path.join(generationDir, "cache", "task.sqlite"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a repository without a layout declaration keeps the default local root and its projection", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-local-root-default-"));
  try {
    const layout = resolveHarnessLayout(rootDir);
    assert.equal(layout.localRoot, path.join(rootDir, ".harness"));
    assert.equal(layout.taskProjectionPath, path.join(rootDir, ".harness", "cache", "task.sqlite"));
    assert.equal(defaultLifecycleTaskProjectionPath(rootDir), layout.taskProjectionPath);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
