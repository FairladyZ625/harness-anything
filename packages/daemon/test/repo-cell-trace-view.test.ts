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
import { runGitHistoryLog, runGitHistoryLogAsync, runProcessText } from "../src/daemon-host/process-port.ts";
import {
  makeWorkspaceGitHistoryPort,
  prepareWorkspaceGitHistorySnapshot,
} from "../src/daemon-host/repo-cell-trace-view.ts";
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

test("runGitHistoryLogAsync preserves exit status, error code, and bounded stderr without blocking", async () => {
  const missing = await runGitHistoryLogAsync(path.join(tmpdir(), `ha-missing-${Date.now()}`), ["log", "-1"]);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.exitCode, null);
    assert.equal(missing.errorCode, "ENOENT");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "ha-trace-git-async-"));
  try {
    writeFileSync(path.join(dir, ".git"), "gitdir: ./missing-git-dir\n");
    const broken = await runGitHistoryLogAsync(dir, ["log", "-1"]);
    assert.equal(broken.ok, false);
    if (!broken.ok) {
      assert.equal(broken.exitCode, 128);
      assert.equal(broken.errorCode, null);
      assert.ok(broken.stderr.length > 0 && Buffer.byteLength(broken.stderr) <= 512, "bounded stderr digest");
    }
  } finally {
    removeTempRepository(dir);
  }
});

test("prepareWorkspaceGitHistorySnapshot collects history and collisions asynchronously and fails closed on path drift", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-trace-snapshot-"));
  try {
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
    const dirtyWorktree = path.join(dir, ".worktrees", TASK_C);
    git(dir, "worktree", "add", "-q", "--detach", dirtyWorktree, "HEAD");
    write(dirtyWorktree, TARGET, "export const a = 4;\n");

    let gitInvocations = 0;
    const snapshot = await prepareWorkspaceGitHistorySnapshot({
      rootDir: dir,
      paths: [TARGET, OTHER],
      excludeTaskId: TASK_A,
      runGit: async (root, args, timeoutMs) => {
        gitInvocations += 1;
        return runGitHistoryLogAsync(root, args, timeoutMs);
      },
    });
    const afterPrepare = gitInvocations;
    assert.ok(afterPrepare >= 2, "pre-collection runs git log and worktree status asynchronously");

    const history = snapshot.readPathHistory({ paths: [TARGET, OTHER], maxCommits: 10 });
    assert.equal(history.availability, "available");
    if (history.availability === "available") {
      assert.deepEqual(
        parseGitHistory(history.stdout).map((commit) => [commit.prNumber, commit.taskId]),
        [
          [12, TASK_A],
          [null, null],
        ],
      );
    }
    const branches = snapshot.readBranchCollisions!({ paths: [TARGET, OTHER], maxCommits: 10 });
    assert.equal(branches.availability, "available");
    if (branches.availability === "available") {
      assert.deepEqual(
        [...parseBranchCollisions(branches.stdout, [TARGET, OTHER])],
        [[TASK_C, { branch: TASK_C, commits: 1, tracePaths: new Set([TARGET]) }]],
      );
    }
    assert.deepEqual(snapshot.readDirtyWorktreeCollisions!({ paths: [TARGET, OTHER], excludeTaskId: TASK_A }), {
      collisions: [{ taskId: TASK_C, tracePaths: [TARGET] }],
      scannedWorktrees: 1,
      notScannedWorktrees: 0,
      truncated: false,
    });
    assert.equal(gitInvocations, afterPrepare, "consuming a matching snapshot spawns zero git subprocesses");

    // Path drift between pre-collection and publication returns structured unavailable without calling git.
    const driftedHistory = snapshot.readPathHistory({ paths: [OTHER], maxCommits: 10 });
    assert.equal(driftedHistory.availability, "unavailable");
    if (driftedHistory.availability === "unavailable") {
      assert.equal(driftedHistory.reason, "git_worktree_unavailable");
      assert.match(driftedHistory.message, /snapshot does not match/u);
    }
    const driftedBranches = snapshot.readBranchCollisions!({ paths: [OTHER], maxCommits: 10 });
    assert.equal(driftedBranches.availability, "unavailable");
    assert.deepEqual(snapshot.readDirtyWorktreeCollisions!({ paths: [OTHER], excludeTaskId: TASK_A }), {
      collisions: [],
      scannedWorktrees: 0,
      notScannedWorktrees: 0,
      truncated: false,
    });
    assert.equal(gitInvocations, afterPrepare, "path drift never falls back to spawning git");

    // Empty path snapshots invoke zero git processes and fail closed if paths appear before publication.
    let emptyCalls = 0;
    const emptySnapshot = await prepareWorkspaceGitHistorySnapshot({
      rootDir: dir,
      paths: [],
      runGit: async (root, args, timeoutMs) => {
        emptyCalls += 1;
        return runGitHistoryLogAsync(root, args, timeoutMs);
      },
    });
    assert.equal(emptyCalls, 0);
    assert.equal(emptySnapshot.readPathHistory({ paths: [TARGET], maxCommits: 5 }).availability, "unavailable");
    assert.equal(emptyCalls, 0);
  } finally {
    removeTempRepository(dir);
  }
});
