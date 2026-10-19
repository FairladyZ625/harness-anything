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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { addManagedWorktree, reclaimManagedWorktree } from "../src/schedule-occurrence-workspace.ts";
import { runWorktreeSetup, workerLedgerPath } from "../src/worktree-setup.ts";

const taskId = "task-x",
  packageName = `${taskId}-fixture`,
  plan = path.join("harness", "tasks", packageName, "task_plan.md"),
  skill = path.join("harness", "skills", "review", "SKILL.md");

test("a managed worktree holds only its own task package link, and out-of-package ledger writes cannot reach the canonical checkout", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", taskId), branch: taskId, baseRef: "origin/main" },
    mirror = path.join(worktree.cwd, "harness");
  await addManagedWorktree(root, worktree);
  assert.equal(existsSync(mirror), false, "git checks out no ledger of its own");
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });
  // Every later start or dispatch prepares again: it keeps the own-package link and sweeps what an
  // older layout left behind.
  mkdirSync(path.join(root, "harness", "facts"));
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });

  // One real directory holding one link: the dispatch's own task package, whose writes are the
  // doc-sync channel. No other ledger directory resolves under the worktree root.
  assert.equal(lstatSync(mirror).isDirectory(), true);
  const workerPackage = path.join(mirror, "tasks", packageName),
    workerPlan = path.join(workerPackage, "task_plan.md"),
    canonicalPlan = path.join(root, plan);
  writeFileSync(workerPlan, "# Updated Plan\n");
  assert.equal(readFileSync(canonicalPlan, "utf8"), "# Updated Plan\n", "existing docs share the doc-sync file");
  writeFileSync(path.join(workerPackage, "closeout.md"), "# Closeout\n");
  assert.equal(
    readFileSync(path.join(root, "harness", "tasks", packageName, "closeout.md"), "utf8"),
    "# Closeout\n",
    "the own package stays the doc-sync write channel into the ledger",
  );

  // A worker deleting or writing an out-of-package private file under its own root fails right
  // there. Runtime consumers instead receive a worker-local copy, so deleting or editing that
  // path cannot change the canonical file (the incident this closes: a deleted skill left every
  // agent referencing it undispatchable).
  const canonicalSkill = path.join(root, skill);
  assert.throws(() => rmSync(path.join(worktree.cwd, skill)), { code: "ENOENT" });
  assert.equal(readFileSync(canonicalSkill, "utf8"), "# Review\n");
  assert.throws(() => writeFileSync(path.join(worktree.cwd, skill), "mutated\n"), { code: "ENOENT" });
  assert.equal(readFileSync(canonicalSkill, "utf8"), "# Review\n");
  assert.deepEqual(readdirSync(mirror).sort(), ["tasks"]);
  assert.equal(lstatSync(path.join(mirror, "tasks")).isSymbolicLink(), false, "tasks holds the link, it is not one");
  assert.deepEqual(readdirSync(path.join(mirror, "tasks")), [packageName]);
  assert.equal(lstatSync(workerPackage).isSymbolicLink(), false, "the package parent stays in the worker checkout");
  assert.equal(existsSync(path.join(mirror, "skills")), false, "out-of-package ledger content does not resolve");
  assert.equal(existsSync(path.join(mirror, "facts")), false);
  const workerSkill = workerLedgerPath(root, worktree.cwd, canonicalSkill);
  assert.notEqual(workerSkill, canonicalSkill);
  assert.equal(readFileSync(workerSkill, "utf8"), "# Review\n");
  writeFileSync(workerSkill, "worker mutation\n");
  assert.equal(readFileSync(canonicalSkill, "utf8"), "# Review\n");
  rmSync(workerSkill);
  assert.equal(readFileSync(canonicalSkill, "utf8"), "# Review\n");
  const workerSkillDirectory = workerLedgerPath(root, worktree.cwd, path.dirname(canonicalSkill));
  assert.equal(readFileSync(path.join(workerSkillDirectory, "SKILL.md"), "utf8"), "# Review\n");
  writeFileSync(path.join(workerSkillDirectory, "SKILL.md"), "directory mutation\n");
  assert.equal(readFileSync(canonicalSkill, "utf8"), "# Review\n");
  // A directory symlink for the own package would resolve `../../skills` from its canonical target and bypass the
  // direct-path check above. The worker package is real, so the same relative write stays inside the worker mirror.
  assert.throws(() =>
    execFileSync(
      process.execPath,
      ["-e", "require('node:fs').rmSync(process.argv[1])", path.join("..", "..", "skills", "review", "SKILL.md")],
      { cwd: workerPackage, stdio: "pipe" },
    ),
  );
  assert.equal(readFileSync(canonicalSkill, "utf8"), "# Review\n");

  assert.equal(git(worktree.cwd, "status", "--porcelain"), "", "the ledger directory is ignored, not untracked");
  git(worktree.cwd, "add", "-A");
  assert.equal(git(worktree.cwd, "diff", "--cached", "--name-only"), "", "git add -A stages nothing of the ledger");
  // The probe tools/check-private-boundary.mjs runs in every checkout: git refuses a path beyond a link.
  git(worktree.cwd, "check-ignore", "--no-index", "-q", "harness/__boundary_probe__");
  assert.equal(git(root, "status", "--porcelain"), "", "the canonical checkout stays clean");

  // Paths under the worker's own package resolve under its own root; anything else in the ledger
  // keeps the canonical path it came from.
  assert.equal(workerLedgerPath(root, worktree.cwd, path.join(root, plan)), path.join(worktree.cwd, plan));
  const isolatedSkill = workerLedgerPath(root, worktree.cwd, path.join(root, skill));
  assert.notEqual(isolatedSkill, path.join(root, skill));
  assert.equal(readFileSync(isolatedSkill, "utf8"), "directory mutation\n");
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

test("a worktree materialized by the all-links layout is swept to the own-package link at the next setup", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", taskId), branch: taskId, baseRef: "origin/main" },
    mirror = path.join(worktree.cwd, "harness");
  await addManagedWorktree(root, worktree);
  mkdirSync(mirror, { recursive: true });
  // The layout before only the own package was linked: every ledger directory as one top-level link,
  // the own package reachable through the tasks link.
  for (const name of ["tasks", "skills", "facts"])
    symlinkDirectory(path.join(root, "harness", name), path.join(mirror, name));

  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });

  assert.deepEqual(readdirSync(mirror).sort(), ["tasks"]);
  assert.deepEqual(readdirSync(path.join(mirror, "tasks")), [packageName]);
  assert.equal(lstatSync(path.join(mirror, "tasks", packageName)).isSymbolicLink(), false);
  assert.equal(existsSync(path.join(mirror, "skills")), false);
});

test("a missing or replaced worker mirror is recreated without following its replacement symlink", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", taskId), branch: taskId, baseRef: "origin/main" },
    mirror = path.join(worktree.cwd, "harness"),
    external = path.join(root, "external"),
    sentinel = path.join(external, "keep.txt");
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });

  rmSync(mirror, { recursive: true, force: true });
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });
  assert.equal(lstatSync(path.join(mirror, "tasks", packageName)).isDirectory(), true);

  mkdirSync(external);
  writeFileSync(sentinel, "keep\n");
  rmSync(mirror, { recursive: true, force: true });
  symlinkDirectory(external, mirror);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });

  assert.equal(lstatSync(mirror).isDirectory(), true);
  assert.equal(lstatSync(path.join(mirror, "tasks", packageName)).isDirectory(), true);
  assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
});

test("an occurrence worktree with no task holds no ledger link", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", "occ-1"), branch: "occ-1", baseRef: "origin/main" },
    mirror = path.join(worktree.cwd, "harness");
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId: null, steps: [] });
  assert.equal(existsSync(mirror), false);
});

test("reclaiming a managed worktree removes the links and leaves the ledger", async (t) => {
  const root = repositoryFixture(t),
    worktree = { cwd: path.join(root, ".worktrees", taskId), branch: taskId, baseRef: "origin/main" };
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });

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
    worktree = { cwd: path.join(root, ".worktrees", taskId), branch: taskId, baseRef: "origin/main" };
  await addManagedWorktree(root, worktree);
  await runWorktreeSetup({ rootDir: root, cwd: worktree.cwd, taskId, steps: [] });
  writeFileSync(path.join(worktree.cwd, "README.md"), "edited in the worktree\n");

  assert.deepEqual(await reclaimManagedWorktree(root, worktree), {
    outcome: "retained",
    reason: "uncommitted changes",
  });
  assert.equal(readFileSync(path.join(worktree.cwd, "README.md"), "utf8"), "edited in the worktree\n");
  assert.deepEqual(readdirSync(path.join(worktree.cwd, "harness")), []);
  assert.equal(readFileSync(path.join(root, plan), "utf8"), "# Plan\n");
});

/** One directory junction, the way the ledger links are made on every platform the daemon runs on. */
function symlinkDirectory(target: string, link: string): void {
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link, "junction");
}

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
  // origin/main as a worktree base, without a push: the fixture stays hermetic and the worker
  // runtime this test also runs under refuses every push that is not a task branch.
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  for (const [file, body] of [
    [plan, "# Plan\n"],
    [path.join("harness", "tasks", packageName, "closeout.md"), "# Old Closeout\n"],
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
