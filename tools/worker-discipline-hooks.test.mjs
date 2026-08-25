// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("public pre-commit rejects artifacts and harness paths", (context) => {
  const root = makeRepo(context, "hook-artifact-guard-");
  installHook(root, "pre-commit");
  for (const directory of ["artifacts", "harness"]) {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, directory, "receipt.md"), "private\n");
    git(root, "add", `${directory}/receipt.md`);
    const result = runHook(root, "pre-commit");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Refusing to commit authored or task artifacts/u);
    git(root, "reset", "--quiet", "HEAD", "--", `${directory}/receipt.md`);
  }
});

test("canonical hooks reject worker commit and checkout", (context) => {
  const root = makeRepo(context, "hook-canonical-guard-");
  installHook(root, "pre-commit");
  installHook(root, "pre-checkout");
  installHook(root, "git");
  writeFileSync(path.join(root, "source.txt"), "worker change\n");
  git(root, "add", "source.txt");
  const env = {
    ...process.env,
    HARNESS_ACTOR: "agent:worker-test",
    HARNESS_CANONICAL_ROOT: root,
    PATH: `${path.join(root, "tools", "git-hooks")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const commit = spawnSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "commit", "-m", "worker"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(commit.status, 1, commit.stderr);
  assert.match(commit.stderr, /Refusing a worker git commit in the canonical repository root/u);
  const checkoutViaGit = spawnSync("git", ["-C", root, "checkout", "-b", "worker-branch"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(checkoutViaGit.status, 1, checkoutViaGit.stderr);
  assert.match(checkoutViaGit.stderr, /Refusing a worker branch checkout in the canonical repository root/u);
  const checkout = spawnSync(path.join(root, "tools", "git-hooks", "pre-checkout"), [], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(checkout.status, 1, checkout.stderr);
  assert.match(checkout.stderr, /Refusing a worker checkout in the canonical repository root/u);
});

test("worker handoff templates carry framework-owned publication rules", () => {
  const templatePaths = [
    "packages/preset/assets/software-coding/templates/task.worker.flow/en-US.md",
    "packages/preset/assets/software-coding/templates/task.worker.flow/zh-CN.md",
    "packages/preset/assets/software-coding/presets/worker-dispatch/templates/task.worker.flow/en-US.md",
    "packages/preset/assets/software-coding/presets/worker-dispatch/templates/task.worker.flow/zh-CN.md",
  ];
  for (const relativePath of templatePaths) {
    const body = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    assert.match(body, /origin\/main/u);
    assert.match(body, /mergify-queue-metadata-edit-noop/u);
    assert.match(body, /ha doc sync --submit --path tasks\/<pkg>\/artifacts\/reports\/<file>\.md/u);
    assert.doesNotMatch(body, /Do not push|不要 push/u);
  }
  const prompt = readFileSync(path.join(repositoryRoot, "packages/daemon/src/agent-role-prompts.ts"), "utf8");
  assert.match(prompt, /canonical repository root/u);
  assert.match(prompt, /mergify-queue-metadata-edit-noop/u);
  assert.match(prompt, /ha doc sync --submit --path tasks/u);
});

function makeRepo(context, prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "hook-test@example.invalid");
  git(root, "config", "user.name", "Hook Test");
  writeFileSync(path.join(root, "README.md"), "fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "--quiet", "--no-verify", "-m", "fixture");
  return root;
}

function installHook(root, name) {
  const hooks = path.join(root, "tools", "git-hooks");
  mkdirSync(hooks, { recursive: true });
  copyFileSync(path.join(repositoryRoot, "tools", "git-hooks", name), path.join(hooks, name));
  chmodSync(path.join(hooks, name), 0o755);
  git(root, "config", "core.hooksPath", "tools/git-hooks");
}

function runHook(root, name) {
  return spawnSync(path.join(root, "tools", "git-hooks", name), [], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HARNESS_ACTOR: "agent:worker-test", HARNESS_CANONICAL_ROOT: path.join(root, "other") },
  });
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}
