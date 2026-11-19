// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseBranchCollisions, parseGitHistory } from "@harness-anything/application/internal/queries/file-trace-read.ts";
import { runGitHistoryLog, runProcessText } from "../src/daemon-host/process-port.ts";
import { makeWorkspaceGitHistoryPort } from "../src/daemon-host/repo-cell-trace-view.ts";

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
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

test("a cell without a Git worktree reports git_worktree_unavailable instead of an empty history", () => {
  withDir((dir) => {
    const port = makeWorkspaceGitHistoryPort(dir);
    for (const outcome of [
      port.readPathHistory({ paths: [TARGET], maxCommits: 5 }),
      port.readBranchCollisions!({ path: TARGET, maxCommits: 5 }),
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
    const collisions = port.readBranchCollisions!({ path: TARGET, maxCommits: 10 });
    assert.equal(collisions.availability, "available");
    if (collisions.availability !== "available") return;
    assert.deepEqual([...parseBranchCollisions(collisions.stdout)], [[TASK_C, { branch: TASK_C, commits: 1 }]]);
    const quiet = port.readBranchCollisions!({ path: OTHER, maxCommits: 10 });
    assert.equal(quiet.availability === "available" && parseBranchCollisions(quiet.stdout).size, 0);
  });
});
