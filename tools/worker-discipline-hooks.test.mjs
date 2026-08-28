// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    assert.match(result.stderr, /ha doc sync --submit --task <task-id>/u);
    assert.doesNotMatch(result.stderr, /--path|--execution-id/u);
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

test(
  "git wrapper skips filesystem-identical PATH aliases",
  { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false },
  async (context) => {
    const root = makeRepo(context, "hook-path-alias-"),
      hooks = path.join(root, "tools", "git-hooks"),
      hooksAlias = path.join(path.dirname(root), `${path.basename(root)}-hooks-alias`);
    installHook(root, "git");
    symlinkSync(hooks, hooksAlias, "dir");
    context.after(() => rmSync(hooksAlias, { force: true }));

    const result = await spawnWithDeadline("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${hooksAlias}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(result.timedOut, false, `git wrapper recursively invoked itself\n${result.stderr}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(realpathSync(result.stdout.trim()), root);
  },
);

test("task-bound git wrapper permits only explicit codex branch push targets", (context) => {
  const root = makeRepo(context, "hook-push-guard-"),
    bare = path.join(path.dirname(root), `${path.basename(root)}.git`);
  context.after(() => rmSync(bare, { recursive: true, force: true }));
  installHook(root, "git");
  git(root, "init", "--bare", bare);
  git(root, "checkout", "-b", "codex/push-guard");
  git(root, "remote", "add", "origin", bare);
  const env = {
    ...process.env,
    HARNESS_TASK_BOUND: "1",
    PATH: `${path.join(root, "tools", "git-hooks")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const refused = spawnSync("git", ["-C", root, "push", "origin", "HEAD:main"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /outside refs\/heads\/codex/u);
  const allowed = spawnSync("git", ["-C", root, "push", "origin", "HEAD:refs/heads/codex/push-guard"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(git(bare, "show-ref", "--verify", "refs/heads/codex/push-guard"), /codex\/push-guard/u);
});

test("GitHub askpass answers only standard HTTPS GitHub prompts", (context) => {
  const root = makeRepo(context, "hook-askpass-guard-"),
    secret = randomUUID();
  installHook(root, "git-askpass");
  const helper = path.join(root, "tools", "git-hooks", "git-askpass"),
    env = { ...process.env, HARNESS_GITHUB_TOKEN: secret },
    username = spawnSync(helper, ["Username for 'https://github.com':"], { encoding: "utf8", env }),
    password = spawnSync(helper, ["Password for 'https://x-access-token@github.com':"], { encoding: "utf8", env }),
    hostile = spawnSync(helper, ["Password for 'https://github.com.example.invalid':"], { encoding: "utf8", env });
  assert.deepEqual([username.status, username.stdout.trim()], [0, "x-access-token"]);
  assert.deepEqual([password.status, digest(password.stdout.trim())], [0, digest(secret)]);
  assert.deepEqual([hostile.status, hostile.stdout], [1, ""]);
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
    assert.match(body, /ha doc sync --submit --task <task-id>/u);
    assert.doesNotMatch(body, /ha doc sync --submit .*--(?:path|execution-id)/u);
    assert.doesNotMatch(body, /Do not push|不要 push/u);
  }
  const prompt = readFileSync(path.join(repositoryRoot, "packages/daemon/src/agent-role-prompts.ts"), "utf8");
  assert.match(prompt, /canonical repository root/u);
  assert.match(prompt, /ha doc sync --submit --task <task-id>/u);
  assert.doesNotMatch(prompt, /ha doc sync --submit .*--(?:path|execution-id)/u);
});

function makeRepo(context, prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
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

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function spawnWithDeadline(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
        ...options,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stdout = [],
      stderr = [];
    let timedOut = false;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") reject(error);
      }
    }, 2_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
        timedOut,
      });
    });
  });
}
