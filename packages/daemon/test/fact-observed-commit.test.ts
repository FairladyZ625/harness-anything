// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { withObservedCommit } from "../src/fact-observed-commit.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";

test("a fact record anchors to the task worktree HEAD while the worktree is checked out", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-observed-commit-"));
  try {
    initRepo(rootDir);
    git(rootDir, "commit", "--allow-empty", "-qm", "test: canonical head");
    const canonical = git(rootDir, "rev-parse", "HEAD");
    // dec_BB2BCE9F995CD3A126E2918734 CH4: untaken records name the canonical checkout HEAD.
    assert.equal(withObservedCommit(rootDir, { kind: "fact-record" }).observedCommit, canonical);
    // A task in execution has its managed worktree under .worktrees/<taskId>; its HEAD wins.
    const worktree = path.join(rootDir, ".worktrees", "task-observed");
    git(rootDir, "worktree", "add", "-q", "--detach", worktree, canonical);
    git(worktree, "commit", "--allow-empty", "-qm", "test: worktree head");
    const workerHead = git(worktree, "rev-parse", "HEAD");
    assert.notEqual(workerHead, canonical);
    assert.equal(
      withObservedCommit(rootDir, { kind: "fact-record", taskId: "task-observed" }).observedCommit,
      workerHead,
    );
    // A closed task's worktree is gone, so the record falls back to the canonical checkout HEAD.
    git(rootDir, "worktree", "remove", "--force", worktree);
    assert.equal(
      withObservedCommit(rootDir, { kind: "fact-record", taskId: "task-observed" }).observedCommit,
      canonical,
    );
    // A value already on the action is respected, never re-resolved.
    assert.equal(
      withObservedCommit(rootDir, { taskId: "task-observed", observedCommit: canonical }).observedCommit,
      canonical,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a checkout that cannot name its HEAD fails closed instead of recording an unanchored fact", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-observed-commit-none-"));
  try {
    // A repository with zero commits: rev-parse HEAD has nothing to resolve.
    git(rootDir, "init", "-q");
    assert.throws(() => withObservedCommit(rootDir, { kind: "fact-record" }), /Cannot resolve the observation commit/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
