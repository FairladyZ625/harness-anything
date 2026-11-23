// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseBranchCollisions,
  parseGitHistory,
} from "@harness-anything/application/internal/queries/file-trace-read.ts";
import { runGitHistoryLog, runProcessText } from "../src/daemon-host/process-port.ts";
import { makeWorkspaceGitHistoryPort } from "../src/daemon-host/repo-cell-trace-view.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const TASK_A = "task_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  TASK_C = "task_cccccccccccccccccccccccccc",
  TARGET = "packages/demo/src/target.ts",
  OTHER = "packages/demo/src/other.ts";

function git(cwd: string, ...args: string[]): string {
  return runProcessText(
    "git",
    ["-c", "user.name=Trace Test", "-c", "user.email=trace@example.invalid", "-c", "commit.gpgsign=false", ...args],
    cwd,
  );
}

function write(root: string, file: string, body: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), body);
}

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-trace-git-"));
  try {
    run(dir);
  } finally {
    removeTempRepository(dir);
  }
}

test("a cell without a Git worktree reports git_worktree_unavailable instead of an empty history", () => {
  withDir((dir) => {
    const port = makeWorkspaceGitHistoryPort(dir);
    for (const outcome of [
      port.readPathHistory({ paths: [TARGET], maxCommits: 5 }),
      port.readBranchCollisions!({ paths: [TARGET], maxCommits: 5 }),
    ])
      assert.deepEqual(
        { availability: outcome.availability, reason: outcome.availability === "unavailable" ? outcome.reason : null },
        { availability: "unavailable", reason: "git_worktree_unavailable" },
      );
  });
});

test("an unborn HEAD is a valid repository with no history; a broken repository is git_log_failed with diagnostics", () => {
  withDir((dir) => {
    git(dir, "init", "-q", "-b", "main");
    assert.deepEqual(makeWorkspaceGitHistoryPort(dir).readPathHistory({ paths: [TARGET], maxCommits: 5 }), {
      availability: "available",
      stdout: "",
    });
  });
  withDir((dir) => {
    writeFileSync(path.join(dir, ".git"), "gitdir: ./missing-git-dir\n");
    const outcome = makeWorkspaceGitHistoryPort(dir).readPathHistory({ paths: [TARGET], maxCommits: 5 });
    assert.equal(outcome.availability, "unavailable");
    if (outcome.availability !== "unavailable") return;
    assert.equal(outcome.reason, "git_log_failed");
    assert.match(outcome.message, /exit 128/u, "the exit status is preserved");
    const raw = runGitHistoryLog(dir, ["log", "-1"]);
    assert.equal(raw.ok, false);
    if (!raw.ok) {
      assert.equal(raw.exitCode, 128);
      assert.equal(raw.errorCode, null);
      assert.ok(raw.stderr.length > 0 && Buffer.byteLength(raw.stderr) <= 512, "bounded stderr digest");
    }
  });
});

test("one batched first-parent history covers several paths; unmerged task branches surface as collisions", () => {
  withDir((dir) => {
    git(dir, "init", "-q", "-b", "main");
    write(dir, TARGET, "export const a = 1;\n");
    write(dir, OTHER, "export const b = 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore: seed");
    git(dir, "checkout", "-q", "-b", TASK_A);
    write(dir, TARGET, "export const a = 2;\n");
    git(dir, "commit", "-q", "-am", "feat: change target");
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", `Merge pull request #12 from owner/${TASK_A}`, TASK_A);
    git(dir, "checkout", "-q", "-b", TASK_C);
    write(dir, TARGET, "export const a = 3;\n");
    git(dir, "commit", "-q", "-am", "wip: concurrent edit");
    git(dir, "checkout", "-q", "main");
    const port = makeWorkspaceGitHistoryPort(dir),
      history = port.readPathHistory({ paths: [TARGET, OTHER], maxCommits: 10 });
    assert.equal(history.availability, "available");
    if (history.availability !== "available") return;
    const commits = parseGitHistory(history.stdout);
    assert.deepEqual(
      commits.map((commit) => [commit.prNumber, commit.taskId, commit.files]),
      [
        [12, TASK_A, [TARGET]],
        [null, null, [OTHER, TARGET]],
      ],
      "first-parent: the merge is attributed, the branch-internal commit is not walked",
    );
    const collisions = port.readBranchCollisions!({ paths: [TARGET, OTHER], maxCommits: 10 });
    assert.equal(collisions.availability, "available");
    if (collisions.availability !== "available") return;
    assert.deepEqual(
      [...parseBranchCollisions(collisions.stdout, [TARGET, OTHER])],
      [[TASK_C, { branch: TASK_C, commits: 1, tracePaths: new Set([TARGET]) }]],
    );
    const quiet = port.readBranchCollisions!({ paths: [OTHER], maxCommits: 10 });
    assert.equal(quiet.availability === "available" && parseBranchCollisions(quiet.stdout, [OTHER]).size, 0);
  });
});

test("managed worktrees report only requested dirty paths, with or without staging", () => {
  withDir((dir) => {
    git(dir, "init", "-q", "-b", "main");
    write(dir, TARGET, "export const a = 1;\n");
    write(dir, OTHER, "export const b = 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore: seed");
    const staged = path.join(dir, ".worktrees", TASK_A),
      unstaged = path.join(dir, ".worktrees", TASK_C),
      added = "packages/demo/src/new file.ts";
    git(dir, "worktree", "add", "-qb", TASK_A, staged);
    git(dir, "worktree", "add", "-qb", TASK_C, unstaged);
    write(staged, OTHER, "export const b = 2;\n");
    git(staged, "add", "--", OTHER);
    write(unstaged, TARGET, "export const a = 3;\n");
    write(unstaged, added, "export const c = 1;\n");
    const port = makeWorkspaceGitHistoryPort(dir);
    const scan = port.readDirtyWorktreeCollisions?.({ paths: [TARGET, OTHER, added] });
    assert.deepEqual(
      scan?.collisions.toSorted((a, b) => a.taskId.localeCompare(b.taskId)),
      [
        { taskId: TASK_A, tracePaths: [OTHER] },
        { taskId: TASK_C, tracePaths: [TARGET, added] },
      ],
    );
    assert.deepEqual(
      { scanned: scan?.scannedWorktrees, notScanned: scan?.notScannedWorktrees },
      { scanned: 2, notScanned: 0 },
    );
    assert.deepEqual(port.readDirtyWorktreeCollisions?.({ paths: [TARGET], excludeTaskId: TASK_C }), {
      collisions: [],
      scannedWorktrees: 1,
      notScannedWorktrees: 0,
      truncated: false,
    });
    assert.deepEqual(port.readDirtyWorktreeCollisions?.({ paths: ["packages/demo/src/*.ts"] })?.collisions, []);
    assert.equal(git(unstaged, "rev-parse", "HEAD"), git(dir, "rev-parse", "HEAD"));
  });
});

test("dirty worktree scan prioritizes the most recently active worktree and reports the unscanned remainder", () => {
  withDir((dir) => {
    git(dir, "init", "-q", "-b", "main");
    write(dir, TARGET, "export const a = 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore: seed");
    const managedRoot = path.join(dir, ".worktrees");
    mkdirSync(managedRoot);
    let lastWorktree = "";
    for (let index = 0; index < 33; index++) {
      const taskId = `task_${index.toString(16).padStart(26, "0")}`,
        worktree = path.join(managedRoot, taskId);
      git(dir, "worktree", "add", "-q", "--detach", worktree, "HEAD");
      lastWorktree = worktree;
    }
    write(lastWorktree, TARGET, "export const a = 2;\n");
    const recent = new Date(Date.now() + 60_000);
    utimesSync(lastWorktree, recent, recent);

    const scan = makeWorkspaceGitHistoryPort(dir).readDirtyWorktreeCollisions?.({ paths: [TARGET] });
    assert.ok(scan);
    assert.equal(scan.scannedWorktrees, 32);
    assert.equal(scan.notScannedWorktrees, 1);
    assert.equal(scan.truncated, true);
    assert.deepEqual(scan.collisions, [{ taskId: path.basename(lastWorktree), tracePaths: [TARGET] }]);
  });
});
