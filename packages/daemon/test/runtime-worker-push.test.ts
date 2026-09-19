// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  pushWorkerBranch,
  readWorkerGitIdentity,
  workerGitIdentityEnvironment,
  workerWorktreeDirty,
} from "../src/runtime-worker-push.ts";

test("worker push publishes only a codex branch with force-with-lease", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-")),
    bare = path.join(root, "remote.git"),
    worker = path.join(root, "worker");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--bare", bare);
  git(root, "init", "-q", "project");
  const canonical = path.join(root, "project");
  git(canonical, "config", "user.email", "push-test@example.invalid");
  git(canonical, "config", "user.name", "Push Test");
  writeFileSync(path.join(canonical, "README.md"), "fixture\n");
  git(canonical, "add", "README.md");
  git(canonical, "commit", "--quiet", "-m", "fixture");
  git(canonical, "remote", "add", "origin", bare);
  git(canonical, "push", "--quiet", "origin", "HEAD:main");
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "codex/push-test");
  writeFileSync(path.join(worker, "change.txt"), "worker\n");
  git(worker, "add", "change.txt");
  git(worker, "commit", "--quiet", "-m", "feat: worker change");

  const result = await pushWorkerBranch({ cwd: worker, canonicalRoot: canonical });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.equal(result.branch, "codex/push-test");
  assert.equal(result.head, git(worker, "rev-parse", "HEAD").trim());
  const remoteRef = git(bare, "show-ref", "--verify", "refs/heads/codex/push-test").trim();
  assert.ok(remoteRef.startsWith(`${String(result.head)} `), `remote holds the pushed head: ${remoteRef}`);
});

test("worker push refuses the first commit outside the conventional identity and names both emails", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-identity-")),
    bare = path.join(root, "remote.git"),
    worker = path.join(root, "worker");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--bare", bare);
  git(root, "init", "-q", "project");
  const canonical = path.join(root, "project");
  git(canonical, "config", "user.email", "push-test@example.invalid");
  git(canonical, "config", "user.name", "Push Test");
  writeFileSync(path.join(canonical, "README.md"), "fixture\n");
  git(canonical, "add", "README.md");
  git(canonical, "commit", "--quiet", "-m", "fixture");
  git(canonical, "remote", "add", "origin", bare);
  git(canonical, "push", "--quiet", "origin", "HEAD:main");
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "codex/identity-refuse");
  for (const name of ["first", "second"])
    git(
      worker,
      "-c",
      "user.name=Stale Worker",
      "-c",
      "user.email=stale-worker@example.invalid",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      `feat: ${name} stale change`,
    );
  // git log lists the range newest-first, so the named offender is the stale commit at HEAD.
  const staleHead = git(worker, "rev-parse", "HEAD").trim();

  const result = await pushWorkerBranch({ cwd: worker, canonicalRoot: canonical });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(result.branch, "codex/identity-refuse");
  assert.match(
    result.detail,
    new RegExp(
      `commit ${staleHead} carries author <stale-worker@example.invalid> ` +
        "and committer <stale-worker@example.invalid>, " +
        "not the conventional identity <push-test@example.invalid>",
      "u",
    ),
  );
  assert.equal(
    refExists(bare, "refs/heads/codex/identity-refuse"),
    false,
    "the refused branch never reaches the remote",
  );
});

test("worker push refuses when the canonical repository resolves no git identity", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-no-identity-")),
    bare = path.join(root, "remote.git"),
    worker = path.join(root, "worker");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--bare", bare);
  git(root, "init", "-q", "project");
  const canonical = path.join(root, "project");
  writeFileSync(path.join(canonical, "README.md"), "fixture\n");
  git(canonical, "add", "README.md");
  git(
    canonical,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  git(canonical, "remote", "add", "origin", bare);
  git(canonical, "push", "--quiet", "origin", "HEAD:main");
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "codex/no-identity");
  git(
    worker,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "feat: worker change",
  );

  // The identity read must be hermetic: an ambient global gitconfig would otherwise answer for
  // a repository whose own config resolves nothing.
  const result = await pushWorkerBranch({ cwd: worker, canonicalRoot: canonical, env: hermeticGitEnvironment() });
  assert.equal(result.ok, false);
  assert.match(
    result.detail,
    /resolves no git user\.name\/user\.email, so the conventional worker identity cannot be verified/u,
  );
});

test("worker push refuses when origin/main cannot bound the worker commits", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-no-main-")),
    worker = path.join(root, "worker");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "project");
  const canonical = path.join(root, "project");
  git(canonical, "config", "user.email", "push-test@example.invalid");
  git(canonical, "config", "user.name", "Push Test");
  git(canonical, "commit", "--allow-empty", "--quiet", "-m", "fixture");
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "codex/no-main");
  git(worker, "commit", "--allow-empty", "--quiet", "-m", "feat: worker change");

  const result = await pushWorkerBranch({ cwd: worker, canonicalRoot: canonical });
  assert.equal(result.ok, false);
  assert.match(result.detail, /worker commits cannot be bounded against origin\/main: /u);
});

test("worker push records a single failure without retrying", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-failure-")),
    bare = path.join(root, "remote.git"),
    canonical = path.join(root, "project");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--bare", bare);
  git(root, "init", "-q", "project");
  git(canonical, "config", "user.email", "push-test@example.invalid");
  git(canonical, "config", "user.name", "Push Test");
  writeFileSync(path.join(canonical, "README.md"), "fixture\n");
  git(canonical, "add", "README.md");
  git(canonical, "commit", "--quiet", "-m", "fixture");
  git(canonical, "remote", "add", "origin", bare);
  git(canonical, "push", "--quiet", "origin", "HEAD:main");
  // The remote-tracking origin/main survives the repoint, so the identity check bounds the
  // worker commits and the failure below is the transport failure it must report once.
  git(canonical, "remote", "set-url", "origin", path.join(root, "missing.git"));
  const worker = path.join(root, "worker");
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "codex/push-failure");
  git(worker, "commit", "--allow-empty", "--quiet", "-m", "feat: worker change");
  const result = await pushWorkerBranch({ cwd: worker, canonicalRoot: canonical });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(result.branch, "codex/push-failure");
  assert.equal(result.head, git(worker, "rev-parse", "HEAD").trim());
  assert.match(result.detail, /does not appear to be a git repository|No such file|not found/iu);
});

test("a worker push that never answers ends as a timed-out push failure", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-hang-")),
    bare = path.join(root, "remote.git"),
    canonical = path.join(root, "project"),
    worker = path.join(root, "worker"),
    hooks = path.join(root, "hooks"),
    release = path.join(root, "release");
  context.after(() => {
    writeFileSync(release, "");
    rmSync(root, { recursive: true, force: true });
  });
  git(root, "init", "--bare", bare);
  git(root, "init", "-q", "project");
  git(canonical, "config", "user.email", "push-test@example.invalid");
  git(canonical, "config", "user.name", "Push Test");
  git(canonical, "commit", "--allow-empty", "--quiet", "-m", "fixture");
  git(canonical, "remote", "add", "origin", bare);
  git(canonical, "push", "--quiet", "origin", "HEAD:main");
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "codex/push-hang");
  // Stands in for a stalled remote or a credential dialog nobody answers.
  mkdirSync(hooks);
  writeFileSync(
    path.join(hooks, "pre-push"),
    `#!/bin/sh\nwhile [ -d '${root}' ] && [ ! -f '${release}' ]; do sleep 0.05; done\n`,
    { mode: 0o755 },
  );
  git(canonical, "config", "core.hooksPath", hooks);

  const result = await Promise.race([
    pushWorkerBranch({ cwd: worker, canonicalRoot: canonical, timeoutMs: 300 }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("the hanging push never settled")), 10_000).unref();
    }),
  ]);
  assert.deepEqual(result, {
    attempted: true,
    ok: false,
    branch: "codex/push-hang",
    head: git(worker, "rev-parse", "HEAD").trim(),
    detail: "git push timed out after 300 ms",
  });
});

test("canonical roots never trigger worker push", async () => {
  assert.deepEqual(await pushWorkerBranch({ cwd: "/tmp/project", canonicalRoot: "/tmp/project/" }), {
    attempted: false,
    reason: "not-a-worker-worktree",
  });
});

test("worker worktree status is read without changing the worktree", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-dirty-")),
    canonical = path.join(root, "project"),
    worker = path.join(root, "worker");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "project");
  git(canonical, "config", "user.email", "push-test@example.invalid");
  git(canonical, "config", "user.name", "Push Test");
  git(canonical, "commit", "--allow-empty", "--quiet", "-m", "fixture");
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "codex/dirty-test");

  assert.equal(await workerWorktreeDirty({ cwd: worker, canonicalRoot: canonical }), false);
  writeFileSync(path.join(worker, "uncommitted.txt"), "dirty\n");
  assert.equal(await workerWorktreeDirty({ cwd: worker, canonicalRoot: canonical }), true);
  assert.match(git(worker, "status", "--porcelain"), /uncommitted\.txt/u);
  assert.equal(await workerWorktreeDirty({ cwd: canonical, canonicalRoot: canonical }), false);

  // The worktrees this question exists for are the abandoned ones, and those carry far more than a
  // single path: a bound that a real turn's leftovers overrun answers with a thrown error instead.
  for (let index = 0; index < 64; index += 1)
    writeFileSync(path.join(worker, `left-behind-${String(index)}-with-a-realistic-name.txt`), "dirty\n");
  assert.equal(git(worker, "status", "--porcelain").length > 1024, true);
  assert.equal(await workerWorktreeDirty({ cwd: worker, canonicalRoot: canonical }), true);
});

test("the injected identity overrides a misconfigured worktree for commits and rebases", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-identity-env-")),
    bare = path.join(root, "remote.git"),
    worker = path.join(root, "worker");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--bare", bare);
  git(root, "init", "-q", "project");
  const canonical = path.join(root, "project");
  git(canonical, "config", "user.email", "conventional@example.invalid");
  git(canonical, "config", "user.name", "Conventional Identity");
  git(canonical, "commit", "--allow-empty", "--quiet", "-m", "fixture");
  git(canonical, "remote", "add", "origin", bare);
  git(canonical, "push", "--quiet", "origin", "HEAD:main");
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "codex/identity-env");
  // The failure shape this guards against: the worktree resolves a different identity than the
  // canonical root, so implicit inheritance would publish the wrong committer.
  git(canonical, "config", "extensions.worktreeConfig", "true");
  git(worker, "config", "--worktree", "user.email", "misconfigured-worktree@example.invalid");
  git(worker, "config", "--worktree", "user.name", "Misconfigured Worktree");
  assert.equal(git(worker, "config", "--get", "user.email").trim(), "misconfigured-worktree@example.invalid");

  const identity = await readWorkerGitIdentity({
    cwd: canonical,
    env: hermeticGitEnvironment(),
  });
  assert.deepEqual(identity, { name: "Conventional Identity", email: "conventional@example.invalid" });
  const workerEnvironment = {
    ...hermeticGitEnvironment(),
    ...workerGitIdentityEnvironment(identity!),
  };
  writeFileSync(path.join(worker, "committed.txt"), "worker\n");
  gitEnv(workerEnvironment, worker, "add", "committed.txt");
  gitEnv(workerEnvironment, worker, "commit", "--quiet", "-m", "feat: worker change");
  assert.equal(
    git(worker, "log", "-1", "--format=%an|%ae|%cn|%ce").trim(),
    "Conventional Identity|conventional@example.invalid|Conventional Identity|conventional@example.invalid",
  );

  // A rebase recreates commits with a fresh committer; the injected environment pins that too.
  git(canonical, "commit", "--allow-empty", "--quiet", "-m", "chore: move main forward");
  git(canonical, "push", "--quiet", "origin", "HEAD:main");
  gitEnv(workerEnvironment, worker, "rebase", "origin/main");
  assert.equal(
    git(worker, "log", "-1", "--format=%an|%ae|%cn|%ce").trim(),
    "Conventional Identity|conventional@example.invalid|Conventional Identity|conventional@example.invalid",
  );
});

function git(root, ...args) {
  // The task-bound git wrapper on a worker's PATH refuses fixture pushes to main, so the
  // harness-side git here states it is not a task-bound worker.
  const env = { ...process.env };
  delete env.HARNESS_TASK_BOUND;
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env });
}

function gitEnv(env, root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env });
}

// A worker environment carries no ambient git identity of its own.
function hermeticGitEnvironment() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"])
    delete env[name];
  delete env.HARNESS_TASK_BOUND;
  return env;
}

function refExists(root: string, ref: string): boolean {
  return spawnSync("git", ["-C", root, "show-ref", "--verify", "--quiet", ref]).status === 0;
}
