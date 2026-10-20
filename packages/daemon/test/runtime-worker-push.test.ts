// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  pushTaskWorkerBranch,
  pushWorkerBranch,
  configureWorkerGitIdentity,
  readWorkerGitIdentity,
  squadWorkerBranchHasDelivery,
} from "../src/runtime-worker-push.ts";
import { readBeforeWriteQueue } from "../src/write-queue-external-reads.ts";
import type { RepoCellApiContext } from "../src/repo-cell-api.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";

test("squad delivery is witnessed only on a squad-cut branch, never on an ordinary branch with a similar name", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-squad-witness-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main", "repo");
  const repo = path.join(root, "repo");
  git(repo, "config", "user.email", "squad-test@example.invalid");
  git(repo, "config", "user.name", "Squad Test");
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "--quiet", "-m", "fixture");
  // A sibling whose name is the current branch minus its last character: dropping the last
  // character of an ordinary branch name must not turn it into a commander branch.
  git(repo, "branch", "mai");
  writeFileSync(path.join(repo, "work.txt"), "ordinary\n");
  git(repo, "add", "work.txt");
  git(repo, "commit", "--quiet", "-m", "ordinary work");
  assert.equal(await squadWorkerBranchHasDelivery({ cwd: repo }), false);

  git(repo, "checkout", "--quiet", "-b", "main--squad-worker-1");
  assert.equal(await squadWorkerBranchHasDelivery({ cwd: repo }), false, "no commits beyond the commander branch yet");
  writeFileSync(path.join(repo, "squad.txt"), "delivered\n");
  git(repo, "add", "squad.txt");
  git(repo, "commit", "--quiet", "-m", "squad work");
  assert.equal(await squadWorkerBranchHasDelivery({ cwd: repo }), true);
});

test("worker push publishes only the dispatched task's own branch with force-with-lease", async (context) => {
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
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "task_push_test");
  writeFileSync(path.join(worker, "change.txt"), "worker\n");
  git(worker, "add", "change.txt");
  git(worker, "commit", "--quiet", "-m", "feat: worker change");

  const result = await pushTaskWorkerBranch({ cwd: worker, canonicalRoot: canonical, taskId: "task_push_test" });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.equal(result.branch, "task_push_test");
  assert.equal(result.head, git(worker, "rev-parse", "HEAD").trim());
  const remoteRef = git(bare, "show-ref", "--verify", "refs/heads/task_push_test").trim();
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
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "task_identity_refuse");
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

  const result = await pushWorkerBranch({ cwd: worker, canonicalRoot: canonical, taskId: "task_identity_refuse" });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(result.branch, "task_identity_refuse");
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
    refExists(bare, "refs/heads/task_identity_refuse"),
    false,
    "the refused branch never reaches the remote",
  );
});

test("worker push validates only the commits above the published remote cut", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-published-")),
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
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "task_published_cut");
  // Ancestors a human already published under a personal identity: rewriting them is the forced
  // history rewrite this flow forbids, so the worker must publish on top of them as they are.
  for (const name of ["first", "second"])
    git(
      worker,
      "-c",
      "user.name=Published Human",
      "-c",
      "user.email=human@example.invalid",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      `fix: ${name} published change`,
    );
  git(worker, "push", "--quiet", "origin", "HEAD:refs/heads/task_published_cut");
  const published = git(worker, "rev-parse", "HEAD").trim();

  writeFileSync(path.join(worker, "change.txt"), "worker\n");
  git(worker, "add", "change.txt");
  git(worker, "commit", "--quiet", "-m", "feat: worker change");

  const result = await pushTaskWorkerBranch({
    cwd: worker,
    canonicalRoot: canonical,
    taskId: "task_published_cut",
  });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, true, JSON.stringify(result));
  const head = git(worker, "rev-parse", "HEAD").trim();
  assert.equal(result.pushedCommit, head);
  const remoteRef = git(bare, "show-ref", "--verify", "refs/heads/task_published_cut").trim();
  assert.ok(
    remoteRef.startsWith(`${head} `),
    `the remote advances from the published ${published} to the pushed head: ${remoteRef}`,
  );
});

test("worker push still refuses a personal-identity commit above the published remote cut", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-above-cut-")),
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
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "task_stale_above_cut");
  git(
    worker,
    "-c",
    "user.name=Published Human",
    "-c",
    "user.email=human@example.invalid",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "fix: published change",
  );
  git(worker, "push", "--quiet", "origin", "HEAD:refs/heads/task_stale_above_cut");
  const published = git(worker, "rev-parse", "HEAD").trim();
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
    "feat: stale worker change",
  );
  const staleHead = git(worker, "rev-parse", "HEAD").trim();

  const result = await pushTaskWorkerBranch({
    cwd: worker,
    canonicalRoot: canonical,
    taskId: "task_stale_above_cut",
  });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
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
    git(bare, "rev-parse", "refs/heads/task_stale_above_cut").trim(),
    published,
    "the refusal leaves the published cut where it was",
  );
});

test("worker push after a rebase checks only the worker's commits, not the default branch's new merges", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-rebased-")),
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
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "task_rebased_branch");
  writeFileSync(path.join(worker, "change.txt"), "worker\n");
  git(worker, "add", "change.txt");
  git(worker, "commit", "--quiet", "-m", "feat: worker change");
  const first = await pushTaskWorkerBranch({ cwd: worker, canonicalRoot: canonical, taskId: "task_rebased_branch" });
  assert.equal(first.ok, true, JSON.stringify(first));

  // The default branch gains a merge the hosting service authored, the way a merged pull request
  // lands; the worker then rebases its published branch onto it.
  git(
    canonical,
    "-c",
    "user.name=Hosting Service",
    "-c",
    "user.email=noreply@hosting.invalid",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "Merge pull request #1",
  );
  const merge = git(canonical, "rev-parse", "HEAD").trim();
  git(worker, "rebase", "--quiet", merge);

  const rebased = await pushTaskWorkerBranch({ cwd: worker, canonicalRoot: canonical, taskId: "task_rebased_branch" });
  assert.equal(rebased.ok, true, JSON.stringify(rebased));
  const head = git(worker, "rev-parse", "HEAD").trim();
  assert.equal(git(bare, "rev-parse", "refs/heads/task_rebased_branch").trim(), head);
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
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "task_no_identity");
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
  const result = await pushWorkerBranch({
    cwd: worker,
    canonicalRoot: canonical,
    taskId: "task_no_identity",
    env: hermeticGitEnvironment(),
  });
  assert.equal(result.ok, false);
  assert.match(
    result.detail,
    /resolves no git user\.name\/user\.email, so the conventional worker identity cannot be verified/u,
  );
});

test("worker push refuses when no default branch can bound the worker commits", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-no-main-")),
    worker = path.join(root, "worker");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "project");
  const canonical = path.join(root, "project");
  git(canonical, "config", "user.email", "push-test@example.invalid");
  git(canonical, "config", "user.name", "Push Test");
  git(canonical, "commit", "--allow-empty", "--quiet", "-m", "fixture");
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "task_no_main");
  git(worker, "commit", "--allow-empty", "--quiet", "-m", "feat: worker change");
  // No origin and no branch checked out in the main checkout: nothing names a default branch.
  git(canonical, "checkout", "--quiet", "--detach");

  const result = await pushWorkerBranch({ cwd: worker, canonicalRoot: canonical, taskId: "task_no_main" });
  assert.equal(result.ok, false);
  assert.match(result.detail, /worker commits cannot be bounded: the repository has no default branch/u);
});

test("worker push leaves a checkout on any branch but the dispatched task's own", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-other-branch-")),
    worker = path.join(root, "worker");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "project");
  const canonical = path.join(root, "project");
  git(canonical, "config", "user.email", "push-test@example.invalid");
  git(canonical, "config", "user.name", "Push Test");
  git(canonical, "commit", "--allow-empty", "--quiet", "-m", "fixture");
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "codex/retired-name");
  assert.deepEqual(await pushWorkerBranch({ cwd: worker, canonicalRoot: canonical, taskId: "task_other" }), {
    attempted: false,
    reason: "not-task-branch",
  });
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
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "task_push_failure");
  git(worker, "commit", "--allow-empty", "--quiet", "-m", "feat: worker change");
  const result = await pushWorkerBranch({ cwd: worker, canonicalRoot: canonical, taskId: "task_push_failure" });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(result.branch, "task_push_failure");
  assert.equal(result.head, git(worker, "rev-parse", "HEAD").trim());
  assert.equal(result.code, undefined, "an ordinary transport failure carries no dedicated remediation code");
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
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "task_push_hang");
  // Stands in for a stalled remote or a credential dialog nobody answers.
  mkdirSync(hooks);
  writeFileSync(
    path.join(hooks, "pre-push"),
    `#!/bin/sh\nwhile [ -d '${root}' ] && [ ! -f '${release}' ]; do sleep 0.05; done\n`,
    { mode: 0o755 },
  );
  git(canonical, "config", "core.hooksPath", hooks);

  const result = await Promise.race([
    pushWorkerBranch({ cwd: worker, canonicalRoot: canonical, taskId: "task_push_hang", timeoutMs: 300 }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("the hanging push never settled")), 10_000).unref();
    }),
  ]);
  // This dispatch never submitted, so the delivery commit the push would publish is the HEAD itself.
  const workerHead = git(worker, "rev-parse", "HEAD").trim();
  assert.deepEqual(result, {
    attempted: true,
    ok: false,
    branch: "task_push_hang",
    head: workerHead,
    pushedCommit: workerHead,
    detail: "git push timed out after 300 ms",
  });
});

test("canonical roots never trigger worker push", async () => {
  assert.deepEqual(await pushWorkerBranch({ cwd: "/tmp/project", canonicalRoot: "/tmp/project/", taskId: "task_x" }), {
    attempted: false,
    reason: "not-a-worker-worktree",
  });
});

test("the dispatch identity is scoped to its worktree for commits and rebases", async (context) => {
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
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "task_identity_env");
  // The failure shape this guards against: the worktree resolves a different identity than the
  // canonical root, so implicit inheritance would publish the wrong committer.
  git(canonical, "config", "extensions.worktreeConfig", "true");
  git(worker, "config", "--worktree", "user.email", "misconfigured-worktree@example.invalid");
  git(worker, "config", "--worktree", "user.name", "Misconfigured Worktree");
  assert.equal(git(worker, "config", "--get", "user.email").trim(), "misconfigured-worktree@example.invalid");

  await configureWorkerGitIdentity(worker, "person-worker");
  const identity = await readWorkerGitIdentity({ cwd: worker, env: hermeticGitEnvironment() });
  assert.deepEqual(identity, { name: "person-worker", email: "person-worker@users.noreply.github.com" });
  assert.deepEqual(await readWorkerGitIdentity({ cwd: canonical, env: hermeticGitEnvironment() }), {
    name: "Conventional Identity",
    email: "conventional@example.invalid",
  });
  writeFileSync(path.join(worker, "committed.txt"), "worker\n");
  git(worker, "add", "committed.txt");
  git(worker, "commit", "--quiet", "-m", "feat: worker change");
  assert.equal(
    git(worker, "log", "-1", "--format=%an|%ae|%cn|%ce").trim(),
    "person-worker|person-worker@users.noreply.github.com|person-worker|person-worker@users.noreply.github.com",
  );

  // A rebase recreates commits with a fresh committer; worktree config applies to both identities.
  git(canonical, "commit", "--allow-empty", "--quiet", "-m", "chore: move main forward");
  git(canonical, "push", "--quiet", "origin", "HEAD:main");
  git(worker, "rebase", "origin/main");
  assert.equal(
    git(worker, "log", "-1", "--format=%an|%ae|%cn|%ce").trim(),
    "person-worker|person-worker@users.noreply.github.com|person-worker|person-worker@users.noreply.github.com",
  );
});

test("a workflow-scope rejection reports the dedicated code and the CEO handoff push command", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-workflow-")),
    bare = path.join(root, "remote.git"),
    canonical = path.join(root, "project"),
    worker = path.join(root, "worker"),
    receivePack = path.join(root, "receive-pack");
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
  git(canonical, "worktree", "add", "--quiet", worker, "-b", "task_workflow_scope");
  writeFileSync(path.join(worker, "change.txt"), "worker\n");
  git(worker, "add", "change.txt");
  git(worker, "commit", "--quiet", "-m", "feat: worker change");
  // GitHub refuses a workflow-bearing push from a credential without the workflow scope; the stub
  // receive-pack replays that refusal so the mapping sees real git-transport stderr.
  writeFileSync(
    receivePack,
    "#!/bin/sh\n" +
      "echo 'remote: error: GH006: refusing to allow an OAuth App to create or update workflow " +
      "`.github/workflows/ci.yml` without `workflow` scope' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  git(canonical, "config", "remote.origin.receivepack", receivePack);

  const result = await pushWorkerBranch({ cwd: worker, canonicalRoot: canonical, taskId: "task_workflow_scope" });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, "push_workflow_scope_required");
  const head = git(worker, "rev-parse", "HEAD").trim();
  assert.match(
    result.detail,
    new RegExp(
      "^GitHub rejected the push: the branch publishes \\.github/workflows changes and the hosted " +
        "credential lacks the workflow scope\\. The CEO can publish it with local credentials: " +
        `git -C ${worker} push --force-with-lease origin ${head}:refs/heads/task_workflow_scope\\. ` +
        "Git said: .*refusing to allow an OAuth App to create or update workflow",
      "u",
    ),
  );
});

test("the queued task-push receipt points the publisher at ha task pr", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-worker-push-receipt-")),
    bare = path.join(root, "remote.git");
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
  const worktree = path.join(canonical, ".worktrees", "task_push_receipt");
  git(canonical, "worktree", "add", "--quiet", worktree, "-b", "task_push_receipt");
  writeFileSync(path.join(worktree, "change.txt"), "worker\n");
  git(worktree, "add", "change.txt");
  git(worktree, "commit", "--quiet", "-m", "feat: worker change");

  const cell = {
    rootDir: canonical,
    projection: {
      read: () => ({
        snapshot: {
          task: { taskId: "task_push_receipt", taskClass: "standard", presetSnapshotDigest: "digest" },
        },
      }),
      readPresetSnapshot: () => ({ snapshot: { profile: { outputShape: "repository-diff" } } }),
    },
    store: { readHead: () => ({ revision: 7 }) },
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    withHumanSummary: (receipt: unknown) => receipt,
    input: {},
  } as unknown as RepoCellApiContext;
  const publication = await readBeforeWriteQueue(cell, { kind: "task-push", taskId: "task_push_receipt" }, {
    actor: { principal: { personId: "person-owner" }, executor: null },
    source: "local",
  } satisfies RepoCellBinding);
  assert.ok(publication, "task-push prepares its publication outside the write queue");
  const receipt = (await publication({ kind: "task-push", taskId: "task_push_receipt" }, {
    actor: { principal: { personId: "person-owner" }, executor: null },
    source: "local",
  } satisfies RepoCellBinding)) as {
    readonly evidence: string;
    readonly next: readonly { readonly command: string }[];
  };
  assert.match(receipt.evidence, /Worker branch pushed: task_push_receipt @/u);
  assert.deepEqual(receipt.next, [
    {
      command: "ha task pr task_push_receipt",
      reason: "publish the pushed branch as the task's pull request",
    },
  ]);
});

function git(root, ...args) {
  // Fixture commits carry only the identity the fixture states: a host GIT_AUTHOR_*/GIT_COMMITTER_*
  // outranks both repository config and -c, and the task-bound git wrapper refuses pushes to main.
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: hermeticGitEnvironment() });
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
