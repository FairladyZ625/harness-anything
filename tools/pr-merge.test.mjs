// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./pr-merge.mjs", import.meta.url));

function run(command, args, { cwd, env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    assert.fail(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function git(cwd, ...args) {
  return run("git", args, { cwd }).stdout.trim();
}

function makeFakeGh(root) {
  const bin = path.join(root, "bin");
  const gh = path.join(bin, "gh");
  mkdirSync(bin);
  writeFileSync(
    gh,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const statePath = process.env.PR_STATE_PATH;
const data = JSON.parse(readFileSync(statePath, "utf8"));
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify(data));
} else if (args[0] === "pr" && args[1] === "checks") {
  if (!args.includes("--required")) process.exit(3);
  process.stdout.write("required-checks pass\\n");
} else if (args[0] === "pr" && args[1] === "merge") {
  const expected = ["--merge", "--admin", "--match-head-commit", data.headRefOid];
  if (!expected.every((token) => args.includes(token))) process.exit(4);
  data.state = "MERGED";
  writeFileSync(statePath, JSON.stringify(data));
  process.stdout.write("merged by fake gh\\n");
} else {
  process.stderr.write(\`unexpected gh args: \${args.join(" ")}\\n\`);
  process.exit(2);
}
`,
  );
  chmodSync(gh, 0o755);
  return bin;
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pr-merge-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const main = path.join(root, "main");
  const prWorktree = path.join(root, "pr-worktree");
  const statePath = path.join(root, "pr-state.json");

  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--initial-branch=main", seed);
  git(seed, "config", "user.name", "PR Merge Test");
  git(seed, "config", "user.email", "pr-merge@example.test");
  writeFileSync(path.join(seed, "base.txt"), "base\n");
  git(seed, "add", "base.txt");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(root, "clone", remote, main);

  git(seed, "checkout", "-b", "codex/pr-123");
  writeFileSync(path.join(seed, "feature.txt"), "feature\n");
  git(seed, "add", "feature.txt");
  git(seed, "commit", "-m", "feature");
  const headRefOid = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "-u", "origin", "codex/pr-123");
  git(seed, "checkout", "main");
  writeFileSync(path.join(seed, "base.txt"), "base\nupstream\n");
  git(seed, "add", "base.txt");
  git(seed, "commit", "-m", "upstream");
  const upstreamHead = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "origin", "main");

  git(main, "fetch", "origin", "codex/pr-123");
  git(main, "branch", "codex/pr-123", "origin/codex/pr-123");
  git(main, "worktree", "add", prWorktree, "codex/pr-123");
  writeFileSync(
    statePath,
    JSON.stringify({
      number: 123,
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      headRefName: "codex/pr-123",
      headRefOid,
      isCrossRepository: false,
      mergeable: "MERGEABLE",
      url: "https://example.test/pull/123",
    }),
  );

  const fakeBin = makeFakeGh(root);
  const env = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    PR_STATE_PATH: statePath,
    HARNESS_TASK_BOUND: "",
    HARNESS_ACTOR: "",
    HARNESS_CANONICAL_ROOT: "",
  };
  return { env, headRefOid, main, prWorktree, remote, statePath, upstreamHead };
}

test("merges, cleans the PR branch and worktree, and fast-forwards local main", (t) => {
  const setup = fixture(t);
  const initialHead = git(setup.main, "rev-parse", "HEAD");
  assert.notEqual(initialHead, setup.upstreamHead);

  const result = run(process.execPath, [helper, "123"], { cwd: setup.main, env: setup.env });

  assert.match(result.stdout, /required-checks pass/u);
  assert.match(result.stdout, /Local main synchronized/u);
  assert.equal(git(setup.main, "rev-parse", "HEAD"), setup.upstreamHead);
  assert.equal(git(setup.main, "branch", "--show-current"), "main");
  assert.equal(existsSync(setup.prWorktree), false);
  assert.equal(git(setup.main, "branch", "--list", "codex/pr-123"), "");
  assert.equal(git(setup.main, "ls-remote", "--heads", "origin", "refs/heads/codex/pr-123"), "");
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "MERGED");
});

test("refuses a dirty main before merge or cleanup", (t) => {
  const setup = fixture(t);
  writeFileSync(path.join(setup.main, "dirty.txt"), "do not discard\n");
  const initialHead = git(setup.main, "rev-parse", "HEAD");

  const result = run(process.execPath, [helper, "123"], {
    cwd: setup.main,
    env: setup.env,
    allowFailure: true,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /main worktree is dirty/u);
  assert.equal(git(setup.main, "rev-parse", "HEAD"), initialHead);
  assert.equal(existsSync(setup.prWorktree), true);
  assert.notEqual(git(setup.main, "ls-remote", "--heads", "origin", "refs/heads/codex/pr-123"), "");
  assert.equal(JSON.parse(readFileSync(setup.statePath, "utf8")).state, "OPEN");
});
