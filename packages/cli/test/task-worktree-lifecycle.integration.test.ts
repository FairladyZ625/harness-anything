// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  cli,
  createRuntimeFixture,
  installIdentities,
  readPublishedDispatch,
  run,
  seedTask,
} from "./runtime-cli.fixtures.ts";

// dec_BBA713052997C3EF5F5D3DD952 end to end through the real CLI and daemon: a repository-diff task is bound at
// create, checked out on first start or dispatch, and reclaimed by the managed-worktree rule when it closes.
test("a task's worktree is bound at create, checked out on start or dispatch, and reclaimed when it closes", async (context) => {
  const fixture = createRuntimeFixture(context),
    { parent, root, env } = fixture;
  gitRepository(root);
  installIdentities(parent, root, env);
  const worktreeOf = (taskId: string) => {
    const shown = JSON.parse(String(run(root, env, ["task", "show", taskId]).evidence)) as {
      readonly workspace: {
        readonly kind: string;
        readonly path: string;
        readonly branch: string;
        readonly state: string;
      } | null;
    };
    assert.equal(shown.workspace?.kind, "worktree", `${taskId} must be bound to a worktree`);
    return { ...shown.workspace!, cwd: path.join(realpathSync(root), shown.workspace!.path) };
  };

  // Clean and nothing new: create binds, start checks out, cancel removes the worktree and its branch.
  const clean = seedTask(root, env, "wt-clean");
  assert.equal(worktreeOf(clean.taskId).state, "bound");
  assert.equal(existsSync(worktreeOf(clean.taskId).cwd), false, "create binds without checking anything out");
  const started = text(root, env, ["task", "start", clean.taskId, "--execution-id", clean.executionId]);
  const cleanTree = worktreeOf(clean.taskId);
  assert.match(started, /from origin\/main\. Harness manages this worktree; no command is needed\./u);
  assert.equal(cleanTree.state, "materialized");
  // dec_8B3FCCD256CAC5B0BF3CCEDE58 CH1: the branch and the directory are the task id itself.
  assert.equal(cleanTree.branch, clean.taskId);
  assert.equal(cleanTree.path, `.worktrees/${clean.taskId}`);
  assert.equal(git(cleanTree.cwd, "branch", "--show-current"), clean.taskId);
  assert.equal(git(cleanTree.cwd, "rev-parse", "HEAD"), git(root, "rev-parse", "origin/main"));
  assert.match(
    text(root, env, ["task", "show", clean.taskId]),
    new RegExp(
      `^workspace: \\.worktrees/${clean.taskId} \\(worktree on branch ${clean.taskId}, materialized; ` +
        "setup: none; managed by Harness",
      "mu",
    ),
  );
  run(root, env, ["task", "release", clean.taskId]);
  const cancelled = text(root, env, ["task", "transition", clean.taskId, "cancelled", "--reason", "demo", "--force"]);
  assert.match(cancelled, /removed/u);
  assert.equal(existsSync(cleanTree.cwd), false);
  assert.equal(git(root, "branch", "--list", cleanTree.branch), "");
  assert.equal(worktreeOf(clean.taskId).state, "reclaimed");

  // An unmerged commit survives at an archive tag when the task is archived.
  const committed = seedTask(root, env, "wt-commit");
  run(root, env, ["task", "start", committed.taskId, "--execution-id", committed.executionId]);
  const committedTree = worktreeOf(committed.taskId);
  writeFileSync(path.join(committedTree.cwd, "result.txt"), "result\n");
  git(committedTree.cwd, "add", "result.txt");
  git(committedTree.cwd, "commit", "-qm", "unmerged result");
  const head = git(committedTree.cwd, "rev-parse", "HEAD");
  run(root, env, ["task", "release", committed.taskId]);
  const archived = text(root, env, ["task", "archive", committed.taskId, "--reason", "demo"]),
    tag = `archive/wt-${path.basename(committedTree.cwd)}`;
  assert.match(archived, new RegExp(`kept at tag ${tag}`, "u"));
  assert.equal(existsSync(committedTree.cwd), false);
  assert.equal(git(root, "rev-parse", `${tag}^{commit}`), head);

  // Uncommitted work is never deleted: the worktree stays and the receipt says why.
  const dirty = seedTask(root, env, "wt-dirty");
  run(root, env, ["task", "start", dirty.taskId, "--execution-id", dirty.executionId]);
  const dirtyTree = worktreeOf(dirty.taskId);
  writeFileSync(path.join(dirtyTree.cwd, "draft.txt"), "draft\n");
  run(root, env, ["task", "release", dirty.taskId]);
  const retained = text(root, env, ["task", "transition", dirty.taskId, "cancelled", "--reason", "demo", "--force"]);
  assert.match(retained, /warning: Worktree retained at .+ \(uncommitted changes\)\./u);
  assert.equal(existsSync(path.join(dirtyTree.cwd, "draft.txt")), true);
  assert.equal(worktreeOf(dirty.taskId).state, "retained");

  // A first dispatch without --cwd checks the worktree out and runs the worker there.
  const dispatched = seedTask(root, env, "wt-dispatch");
  const spawn = run(root, env, [
    "agent",
    "run",
    "terra",
    "--prompt",
    "work here",
    "--task",
    dispatched.taskId,
    "--no-stream",
  ]).spawn as Record<string, unknown>;
  const dispatchedTree = worktreeOf(dispatched.taskId),
    mission = await readPublishedDispatch(
      path.join(dispatched.artifactRoot, "missions", `${String(spawn.dispatchId)}.md`),
    );
  assert.equal(dispatchedTree.state, "materialized");
  assert.match(
    mission,
    new RegExp(`^Worker repository root: ${escapeRegExp(realpathSync(dispatchedTree.cwd))}$`, "mu"),
  );

  const help = spawnSync(process.execPath, [cli, "--root", root, "task", "create", "--help"], {
    encoding: "utf8",
    env,
  });
  assert.match(help.stdout, /no command is needed/u);
});

// dec_8B3FCCD256CAC5B0BF3CCEDE58 end to end: nothing about npm, main or a remote is assumed. A plain repository on
// master with no origin gets a task-id worktree, runs the steps its Settings declare, refuses a start whose step
// fails, reruns only what failed, and reclaims the worktree when the task closes.
test("a repository with no npm, no remote and a master branch runs its declared setup in a task-id worktree", async (context) => {
  const fixture = createRuntimeFixture(context),
    { root, env } = fixture,
    marker = path.join(path.dirname(root), "setup-ran.txt"),
    gate = path.join(path.dirname(root), "allow-second-step");
  git(root, "config", "user.name", "Plain Demo");
  git(root, "config", "user.email", "plain@example.invalid");
  writeFileSync(path.join(root, ".gitignore"), `${readFileSync(path.join(root, ".gitignore"), "utf8")}.worktrees/\n`);
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "base");
  git(root, "branch", "-M", "master");
  assert.equal(existsSync(path.join(root, "package.json")), false);
  assert.match(text(root, env, ["settings", "read"]), /^worktree\.setup: none$/mu);
  // Repository Settings are the principal's to change, not an agent executor's.
  const { HARNESS_ACTOR: _agent, ...owner } = env;
  text(root, owner, [
    "settings",
    "update",
    "--worktree-setup",
    'run: echo "$HARNESS_TASK_ID" >> "$HARNESS_REPO_ROOT/../setup-ran.txt"',
    "--worktree-setup",
    `run: test -e ${gate}`,
  ]);
  assert.match(text(root, env, ["settings", "read"]), /^worktree\.setup: run: echo .*; run: test -e /mu);

  const plain = seedTask(root, env, "wt-plain"),
    refused = spawnSync(
      process.execPath,
      [cli, "--root", root, "task", "start", plain.taskId, "--execution-id", plain.executionId],
      { encoding: "utf8", env },
    );
  console.log(`$ ha task start ${plain.taskId}\n${refused.stdout}${refused.stderr}`.trimEnd());
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /setup step 2 \(run: test -e .+\) failed: exit code 1/u);
  assert.match(`${refused.stdout}${refused.stderr}`, /Log: .+harness-setup\/step-2\.log/u);
  assert.match(`${refused.stdout}${refused.stderr}`, new RegExp(`run ha task start ${plain.taskId} again`, "u"));
  const tree = path.join(realpathSync(root), ".worktrees", plain.taskId);
  assert.equal(existsSync(tree), true, "a failed setup keeps the worktree");
  assert.equal(git(tree, "branch", "--show-current"), plain.taskId);
  assert.equal(git(tree, "rev-parse", "HEAD"), git(root, "rev-parse", "master"));
  assert.equal(readFileSync(marker, "utf8"), `${plain.taskId}\n`);

  writeFileSync(gate, "");
  const started = text(root, env, ["task", "start", plain.taskId, "--execution-id", plain.executionId]);
  assert.match(started, /Setup ran: run: test -e /u);
  assert.equal(readFileSync(marker, "utf8"), `${plain.taskId}\n`, "the step that succeeded does not run again");
  assert.match(
    text(root, env, ["task", "show", plain.taskId]),
    /^workspace: \.worktrees\/\S+ \(worktree on branch \S+, materialized; setup: run: echo .*; run: test -e /mu,
  );

  run(root, env, ["task", "release", plain.taskId]);
  const closed = text(root, env, ["task", "transition", plain.taskId, "cancelled", "--reason", "demo", "--force"]);
  assert.match(closed, /removed/u);
  assert.equal(existsSync(tree), false);
  assert.equal(git(root, "branch", "--list", plain.taskId), "");
});

function text(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): string {
  const result = spawnSync(process.execPath, [cli, "--root", root, ...args], { encoding: "utf8", env });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  // The demonstration record for dec_BBA713052997C3EF5F5D3DD952: what a person sees at each step.
  console.log(`$ ha ${args.join(" ")}\n${result.stdout.trimEnd()}`);
  return result.stdout;
}

// ha init already made the project a Git repository that ignores the Harness roots; give it a first commit on
// main and an origin to cut worktrees from.
function gitRepository(root: string): void {
  const remote = path.join(path.dirname(root), "origin.git"),
    ignore = path.join(root, ".gitignore");
  git(path.dirname(root), "init", "--bare", "-q", remote);
  git(root, "config", "user.name", "Worktree Demo");
  git(root, "config", "user.email", "worktree@example.invalid");
  writeFileSync(ignore, `${readFileSync(ignore, "utf8")}.worktrees/\nnode_modules/\n`);
  writeFileSync(path.join(root, "README.md"), "demo\n");
  git(root, "add", ".gitignore", "README.md");
  git(root, "commit", "-qm", "base");
  git(root, "branch", "-M", "main");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
