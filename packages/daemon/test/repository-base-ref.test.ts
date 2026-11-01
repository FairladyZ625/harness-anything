// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { INITIAL_SETTINGS_V1, writeRepositorySettingsFacet } from "@harness-anything/kernel";
import { observeDeliveryBaseline } from "../src/repo-cell-proof.ts";
import { remoteDefaultBranch, repositoryBaseRef } from "../src/schedule-occurrence-workspace.ts";
import { checkoutTaskWorktree } from "../src/task-worktree.ts";
import { noWorktreeSetup } from "../src/worktree-setup.ts";

test("a declared local delivery ref cuts the task from main when origin/main has unrelated history", async (t) => {
  const root = repository(t),
    main = git(root, "rev-parse", "main");
  declareTarget(root, "refs/heads/main");
  // Neither the checked-out branch nor origin/HEAD is the declared delivery baseline.
  git(root, "switch", "-qc", "maintenance");
  commit(root, "maintenance.txt");
  assert.equal(spawnSync("git", ["-C", root, "merge-base", "main", "origin/main"]).status, 1);
  assert.equal(repositoryBaseRef(root), "refs/heads/main");
  assert.equal(remoteDefaultBranch(root), "origin/main", "published-main judgments still use the remote copy");
  const branch = "task-local-target",
    checkout = await checkoutTaskWorktree(root, branch, { branch, path: `.worktrees/${branch}` }, noWorktreeSetup());
  assert.ok(checkout);
  assert.equal(checkout.baseRef, "refs/heads/main");
  assert.equal(git(checkout.cwd, "rev-parse", "HEAD"), main);
  assert.equal(existsSync(path.join(checkout.cwd, "legacy.txt")), false);
  commit(checkout.cwd, "delivery.txt");
  git(root, "switch", "-q", "main");
  commit(root, "advanced.txt");
  assert.deepEqual(observeDeliveryBaseline(root, branch), { kind: "commit", commitSha: main });
  assert.equal(repositoryBaseRef(checkout.cwd), "refs/heads/main", "linked worktrees read the same declaration");
});

test("an unresolved declared delivery ref refuses checkout instead of choosing origin/main", async (t) => {
  const root = repository(t),
    branch = "task-missing-target",
    binding = { branch, path: `.worktrees/${branch}` };
  declareTarget(root, "refs/heads/missing");
  assert.throws(() => repositoryBaseRef(root), /delivery\.targetRef.*refs\/heads\/missing.*commit/u);
  await assert.rejects(checkoutTaskWorktree(root, branch, binding, noWorktreeSetup()), /delivery\.targetRef/u);
  assert.equal(existsSync(path.join(root, binding.path)), false);
  assert.equal(git(root, "branch", "--list", branch), "");
  assert.equal(remoteDefaultBranch(root), "origin/main");
});

test("a declared remote delivery ref takes precedence over origin/HEAD", async (t) => {
  const root = repository(t),
    main = git(root, "rev-parse", "main");
  git(root, "push", "-q", "origin", "main:release");
  declareTarget(root, "refs/remotes/origin/release");
  assert.equal(repositoryBaseRef(root), "refs/remotes/origin/release");
  const branch = "task-remote-target",
    checkout = await checkoutTaskWorktree(root, branch, { branch, path: `.worktrees/${branch}` }, noWorktreeSetup());
  assert.ok(checkout);
  assert.equal(checkout.baseRef, "refs/remotes/origin/release");
  assert.equal(git(checkout.cwd, "rev-parse", "HEAD"), main);
  assert.equal(remoteDefaultBranch(root), "origin/main");
});

function repository(t: TestContext): string {
  const base = mkdtempSync(path.join(tmpdir(), "ha-declared-base-")),
    root = path.join(base, "repo"),
    remote = path.join(base, "origin.git");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  git(base, "init", "--bare", "-q", "-b", "main", remote);
  git(base, "init", "-q", "-b", "main", root);
  git(root, "config", "user.name", "Baseline Test");
  git(root, "config", "user.email", "baseline@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.worktrees/\n");
  commit(root, "current.txt");
  git(root, "switch", "--orphan", "legacy");
  commit(root, "legacy.txt");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "origin", "legacy:main");
  git(root, "remote", "set-head", "origin", "main");
  git(root, "switch", "-q", "main");
  return root;
}

function declareTarget(root: string, targetRef: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness", "harness.yaml"),
    writeRepositorySettingsFacet("schema: harness-anything/v1\nname: baseline-test\n", {
      ...INITIAL_SETTINGS_V1,
      delivery: { ...INITIAL_SETTINGS_V1.delivery, targetRef },
    }),
  );
}

function commit(root: string, file: string): void {
  writeFileSync(path.join(root, file), `${file}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-qm", file);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
