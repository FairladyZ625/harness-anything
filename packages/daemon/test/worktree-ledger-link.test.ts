// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { addManagedWorktree, reclaimManagedWorktree } from "../src/schedule-occurrence-workspace.ts";
import { runWorktreeSetup, workerLedgerPath } from "../src/worktree-setup.ts";

const plan = path.join("harness", "tasks", "task-x", "task_plan.md"),
  skill = path.join("harness", "skills", "review", "SKILL.md");

test("a managed worktree reads and writes the one ledger under its own root, and git sees none of it", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", "task-x"), branch: "task-x", baseRef: "origin/main" },
    mirror = path.join(worktree.cwd, "harness");
  await addManagedWorktree(root, worktree);
  assert.equal(existsSync(mirror), false, "git checks out no ledger of its own");
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId: "task-x", steps: [] });
  // Every later start or dispatch prepares again: it keeps what is linked and links what the ledger has gained.
  mkdirSync(path.join(root, "harness", "facts"));
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId: "task-x", steps: [] });

  // A real directory of links to the ledger's directories; its files and its own git directory stay out.
  assert.equal(lstatSync(mirror).isDirectory(), true);
  assert.deepEqual(readdirSync(mirror).sort(), ["facts", "skills", "tasks"]);
  for (const name of readdirSync(mirror)) {
    assert.equal(lstatSync(path.join(mirror, name)).isSymbolicLink(), true, name);
    assert.equal(realpathSync(path.join(mirror, name)), realpathSync(path.join(root, "harness", name)), name);
  }
  assert.equal(readFileSync(path.join(worktree.cwd, plan), "utf8"), "# Plan\n");
  writeFileSync(path.join(mirror, "tasks", "task-x", "closeout.md"), "# Closeout\n");
  assert.equal(readFileSync(path.join(root, "harness", "tasks", "task-x", "closeout.md"), "utf8"), "# Closeout\n");

  assert.equal(git(worktree.cwd, "status", "--porcelain"), "", "the ledger directory is ignored, not untracked");
  git(worktree.cwd, "add", "-A");
  assert.equal(git(worktree.cwd, "diff", "--cached", "--name-only"), "", "git add -A stages nothing of the ledger");
  // The probe tools/check-private-boundary.mjs runs in every checkout: git refuses a path beyond a link.
  git(worktree.cwd, "check-ignore", "--no-index", "-q", "harness/__boundary_probe__");
  assert.equal(git(root, "status", "--porcelain"), "", "the canonical checkout stays clean");

  // Every ledger path handed to the worker resolves under the worker's own root.
  assert.equal(workerLedgerPath(root, worktree.cwd, path.join(root, plan)), path.join(worktree.cwd, plan));
  assert.equal(workerLedgerPath(root, worktree.cwd, path.join(root, skill)), path.join(worktree.cwd, skill));
  // Controls: a reviewer runs in the canonical checkout and keeps its paths; a cwd that holds no ledger, a cwd
  // whose `harness` is some other directory, and a path outside the ledger are left alone.
  assert.equal(workerLedgerPath(root, root, path.join(root, plan)), path.join(root, plan));
  mkdirSync(path.dirname(path.join(root, "packages", "copy", plan)), { recursive: true });
  writeFileSync(path.join(root, "packages", "copy", plan), "# A stale copy\n");
  assert.equal(workerLedgerPath(root, path.join(root, "packages"), path.join(root, plan)), path.join(root, plan));
  assert.equal(
    workerLedgerPath(root, path.join(root, "packages", "copy"), path.join(root, plan)),
    path.join(root, plan),
  );
  assert.equal(workerLedgerPath(root, worktree.cwd, path.join(root, "README.md")), path.join(root, "README.md"));
});

test("reclaiming a managed worktree removes the links and leaves the ledger", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", "task-x"), branch: "task-x", baseRef: "origin/main" };
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId: "task-x", steps: [] });

  assert.deepEqual(await reclaimManagedWorktree(root, worktree), {
    outcome: "removed",
    archiveTag: null,
    unmergedCommits: 0,
  });
  assert.equal(existsSync(worktree.cwd), false);
  assert.equal(readFileSync(path.join(root, plan), "utf8"), "# Plan\n", "the ledger itself is untouched");
});

test("a worktree kept for uncommitted work keeps its work and loses only the links", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", "task-x"), branch: "task-x", baseRef: "origin/main" };
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId: "task-x", steps: [] });
  writeFileSync(path.join(worktree.cwd, "README.md"), "edited in the worktree\n");

  assert.deepEqual(await reclaimManagedWorktree(root, worktree), {
    outcome: "retained",
    reason: "uncommitted changes",
  });
  assert.equal(readFileSync(path.join(worktree.cwd, "README.md"), "utf8"), "edited in the worktree\n");
  assert.deepEqual(readdirSync(path.join(worktree.cwd, "harness")), []);
  assert.equal(readFileSync(path.join(root, plan), "utf8"), "# Plan\n");
});

/** A project repository as `ha init` leaves it: the ledger directory is ignored, so no worktree checks it out. */
function repositoryFixture(t: TestContext): string {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-worktree-ledger-"))),
    remote = path.join(base, "remote.git"),
    root = path.join(base, "canonical");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  git(base, "init", "--bare", "-q", remote);
  git(base, "init", "-q", "-b", "main", root);
  git(root, "config", "user.name", "Worktree Test");
  git(root, "config", "user.email", "worktree@example.invalid");
  writeFileSync(path.join(root, "README.md"), "base\n");
  writeFileSync(path.join(root, ".gitignore"), "/harness/\n/.harness/\n/.worktrees/\n");
  git(root, "add", "README.md", ".gitignore");
  git(root, "commit", "-qm", "base");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  for (const [file, body] of [
    [plan, "# Plan\n"],
    [skill, "# Review\n"],
    [path.join("harness", "harness.yaml"), "layout:\n"],
    [path.join("harness", ".git", "HEAD"), "ref: refs/heads/main\n"],
  ] as const) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
  }
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
