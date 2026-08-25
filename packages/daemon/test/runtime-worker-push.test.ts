// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pushWorkerBranch } from "../src/runtime-worker-push.ts";

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
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "codex/push-test");
  writeFileSync(path.join(worker, "change.txt"), "worker\n");
  git(worker, "add", "change.txt");
  git(worker, "commit", "--quiet", "-m", "feat: worker change");

  const result = await pushWorkerBranch({ cwd: worker, canonicalRoot: canonical });
  assert.deepEqual(result, { attempted: true, ok: true, branch: "codex/push-test" });
  assert.match(git(bare, "show-ref", "--verify", "refs/heads/codex/push-test"), /codex\/push-test/u);
});

test("worker push records a single failure without retrying", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-failure-")),
    canonical = path.join(root, "project");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "project");
  git(canonical, "config", "user.email", "push-test@example.invalid");
  git(canonical, "config", "user.name", "Push Test");
  writeFileSync(path.join(canonical, "README.md"), "fixture\n");
  git(canonical, "add", "README.md");
  git(canonical, "commit", "--quiet", "-m", "fixture");
  const worker = path.join(root, "worker");
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "codex/push-failure");
  git(worker, "remote", "add", "origin", path.join(root, "missing.git"));
  const result = await pushWorkerBranch({ cwd: worker, canonicalRoot: canonical });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(result.branch, "codex/push-failure");
  assert.match(result.detail, /does not appear to be a git repository|No such file|not found/iu);
});

test("canonical roots never trigger worker push", async () => {
  assert.deepEqual(await pushWorkerBranch({ cwd: "/tmp/project", canonicalRoot: "/tmp/project/" }), {
    attempted: false,
    reason: "not-a-worker-worktree",
  });
});

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}
