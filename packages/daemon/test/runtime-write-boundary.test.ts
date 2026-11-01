// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { escapesWorkerWorktree, strayWriteWarning } from "../src/runtime-write-boundary.ts";

const rootDir = mkdtempSync(path.join(tmpdir(), "ha-write-boundary-"));
const workerRoot = path.join(rootDir, ".worktrees", "task_aaaaaaaaaaaaaaaaaaaaaaaa");
const ledgerRoot = path.join(rootDir, "harness");
const boundary = { rootDir, workerRoot, ledgerRoot };

test.after(() => rmSync(rootDir, { recursive: true, force: true }));

test("an absolute canonical path is a stray write; worktree, ledger, runtime and relative paths are not", () => {
  assert.equal(escapesWorkerWorktree(path.join(rootDir, "packages/cli/src/index.ts"), boundary), true);
  assert.equal(escapesWorkerWorktree(path.join(rootDir, ".worktrees/other/src/index.ts"), boundary), true);
  assert.equal(escapesWorkerWorktree(path.join(workerRoot, "packages/cli/src/index.ts"), boundary), false);
  assert.equal(escapesWorkerWorktree(path.join(ledgerRoot, "tasks/x/artifacts/rulings/a.md"), boundary), false);
  assert.equal(escapesWorkerWorktree(path.join(rootDir, ".harness/cache/task.sqlite"), boundary), false);
  assert.equal(escapesWorkerWorktree(path.join(rootDir, ".git/index"), boundary), false);
  assert.equal(escapesWorkerWorktree("packages/cli/src/index.ts", boundary), false);
  assert.equal(escapesWorkerWorktree(path.join(tmpdir(), "outside.ts"), boundary), false);
  assert.equal(escapesWorkerWorktree(path.join(rootDir, "..", "outside.ts"), boundary), false);
});

test("a dispatch rooted in the canonical checkout has no stray writes", () => {
  assert.equal(
    escapesWorkerWorktree(path.join(rootDir, "packages/cli/src/index.ts"), {
      rootDir,
      workerRoot: rootDir,
      ledgerRoot,
    }),
    false,
  );
});

test("the warning names the paths, the worktree and the canonical checkout", () => {
  const warning = strayWriteWarning([path.join(rootDir, "a.ts"), path.join(rootDir, "b.ts")], { rootDir, workerRoot });
  assert.match(warning, /Stray write outside the worker worktree/u);
  assert.match(warning, /a\.ts, .*b\.ts/u);
  assert.match(warning, new RegExp(rootDir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(warning, new RegExp(workerRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});
