// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveTaskWorktreeBinding } from "@harness-anything/kernel";
import { repositoryBaseRef } from "../src/schedule-occurrence-workspace.ts";
import { prepareWorkerWorktree, resolveSquadCwd } from "../src/squad-worker-checkout.ts";
import { noWorktreeSetup } from "../src/worktree-setup.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";

test("each squad assignment uses its own child task binding and preserves the Commander baseline", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-worker-checkout-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: rootDir });
    writeFileSync(path.join(rootDir, "baseline.txt"), "baseline\n");
    execFileSync("git", ["add", "baseline.txt"], { cwd: rootDir });
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "baseline"],
      {
        cwd: rootDir,
      },
    );
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: rootDir });
    execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: rootDir });
    execFileSync("git", ["branch", "-m", "task_0123456789abcdef0123456789"], { cwd: rootDir });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
      first = await prepareWorkerWorktree(baseSha, childBinding("task_child_1"), noSetup(rootDir, "task_child_1")),
      second = await prepareWorkerWorktree(baseSha, childBinding("task_child_2"), noSetup(rootDir, "task_child_2"));

    assert.notEqual(first?.cwd, second?.cwd);
    assert.notEqual(first?.branch, second?.branch);
    assert.equal(first?.branch, "task_child_1");
    assert.equal(first?.cwd, path.join(rootDir, ".worktrees/task_child_1"));
    assert.equal(first?.baseSha, baseSha);
    assert.equal(second?.baseSha, baseSha);
    assert.deepEqual(
      await prepareWorkerWorktree(baseSha, childBinding("task_child_1"), noSetup(rootDir, "task_child_1")),
      first,
    );

    writeFileSync(path.join(first!.cwd, "worker.txt"), "worker\n");
    execFileSync("git", ["add", "worker.txt"], { cwd: first!.cwd });
    execFileSync("git", ["commit", "-m", "worker change"], {
      cwd: first!.cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    });
    const childSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: first!.cwd, encoding: "utf8" }).trim();

    execFileSync("git", ["switch", "-c", "comparison/cherry-pick", baseSha], { cwd: rootDir });
    execFileSync("git", ["cherry-pick", childSha], {
      cwd: rootDir,
      env: { ...process.env, GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" },
    });
    const cherryPickedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
    assert.notEqual(cherryPickedSha, childSha, "cherry-pick recreates the child commit");

    execFileSync("git", ["switch", "task_0123456789abcdef0123456789"], { cwd: rootDir });
    execFileSync("git", ["merge", "--no-ff", "--no-edit", first!.branch], { cwd: rootDir });
    execFileSync("git", ["merge-base", "--is-ancestor", childSha, "HEAD"], { cwd: rootDir });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("worker checkout follows its child binding even when the Commander changes branch or detaches", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "squad-checkout-branch-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", rootDir]);
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: rootDir });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: rootDir });
  writeFileSync(path.join(rootDir, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "seed.txt"], { cwd: rootDir });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: rootDir });
  execFileSync("git", ["branch", "-m", "delivery/mission"], { cwd: rootDir });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
    named = await prepareWorkerWorktree(baseSha, childBinding("task_named"), noSetup(rootDir, "task_named"));
  assert.equal(named?.branch, "task_named");

  execFileSync("git", ["checkout", "-q", "--detach"], { cwd: rootDir });
  const detached = await prepareWorkerWorktree(
    baseSha,
    childBinding("task_detached"),
    noSetup(rootDir, "task_detached"),
  );
  assert.equal(detached?.branch, "task_detached");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: detached!.cwd, encoding: "utf8" }).trim(), baseSha);
});

test("a worker checkout runs the repository's setup steps with the child task id", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "squad-checkout-setup-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "task_0123456789abcdef0123456789", rootDir]);
  execFileSync(
    "git",
    ["-c", "user.name=F", "-c", "user.email=f@example.com", "commit", "-q", "--allow-empty", "-m", "seed"],
    {
      cwd: rootDir,
    },
  );
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
    worker = await prepareWorkerWorktree(baseSha, childBinding("task_child"), {
      rootDir,
      taskId: "task_child",
      setup: ['run: echo "$HARNESS_TASK_ID" > setup.out'],
      setupStepTimeoutMs: noWorktreeSetup().setupStepTimeoutMs,
    });
  assert.equal(readFileSync(path.join(worker!.cwd, "setup.out"), "utf8"), "task_child\n");
});

test("a task-bound squad run refuses an unborn repository before launch and keeps Git-less edges rootless", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-worker-unborn-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", rootDir]);
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: rootDir });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: rootDir });
  const taskId = "task_child_unborn",
    binding = childBinding(taskId)!,
    query = (() => binding) as unknown as Parameters<typeof resolveSquadCwd>[2];
  await assert.rejects(
    resolveSquadCwd(rootDir, undefined, query, taskId, noWorktreeSetup()),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "worktree_base_unavailable");
      assert.equal((error as Error & { reason?: string }).reason, "unborn");
      return true;
    },
  );
  assert.equal(existsSync(path.join(rootDir, ".worktrees", taskId)), false);

  // dec_BBA713052997C3EF5F5D3DD952 CH3: a Git-less edge still records no workspace instead of failing.
  const gitless = mkdtempSync(path.join(tmpdir(), "ha-squad-worker-gitless-"));
  t.after(() => rmSync(gitless, { recursive: true, force: true }));
  assert.equal(await resolveSquadCwd(gitless, undefined, query, taskId, noWorktreeSetup()), gitless);
});

test("a task-bound squad run refuses a committed detached repository with no default base", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-worker-detached-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", rootDir]);
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "first"],
    {
      cwd: rootDir,
    },
  );
  execFileSync("git", ["checkout", "--quiet", "--detach"], { cwd: rootDir });
  assert.equal(repositoryBaseRef(rootDir), null);
  const taskId = "task_child_detached",
    binding = childBinding(taskId)!,
    query = (() => binding) as unknown as Parameters<typeof resolveSquadCwd>[2];
  await assert.rejects(
    resolveSquadCwd(rootDir, undefined, query, taskId, noWorktreeSetup()),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "worktree_base_unavailable");
      assert.equal((error as Error & { reason?: string }).reason, "detached");
      assert.match(error.message, /no resolvable default base commit/u);
      return true;
    },
  );
  assert.equal(existsSync(path.join(rootDir, ".worktrees", taskId)), false);
});

test("a task-bound squad run uses its worktree when the repository has a default base", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-worker-default-base-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main", rootDir]);
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "first"],
    {
      cwd: rootDir,
    },
  );
  const taskId = "task_child_default_base",
    binding = childBinding(taskId)!,
    query = (() => binding) as unknown as Parameters<typeof resolveSquadCwd>[2],
    cwd = await resolveSquadCwd(rootDir, undefined, query, taskId, noWorktreeSetup());
  assert.equal(cwd, path.join(rootDir, binding.path));
  assert.notEqual(cwd, rootDir);
});

function childBinding(taskId: string) {
  return deriveTaskWorktreeBinding({ taskId, taskClass: "standard", outputShape: "repository-diff" });
}

function noSetup(rootDir: string, taskId = "task_child") {
  return { rootDir, taskId, ...noWorktreeSetup() };
}

test("a squad checkout preserves a backoff group's Git conflict and aborts it only after closure", async (t) => {
  {
    const rootDir = mkdtempSync(path.join(tmpdir(), "squad-conflict-owner-"));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    git(rootDir, "init", "-q", "-b", "main");
    git(rootDir, "config", "user.name", "Fixture");
    git(rootDir, "config", "user.email", "fixture@example.com");
    const commit = (cwd: string, text: string) => {
      writeFileSync(path.join(cwd, "conflict.txt"), text);
      git(cwd, "add", "conflict.txt");
      git(cwd, "commit", "-qm", text);
    };
    commit(rootDir, "base");
    const base = git(rootDir, "rev-parse", "HEAD"),
      taskId = "task_conflict_run",
      binding = childBinding(taskId)!,
      worker = (await prepareWorkerWorktree(base, binding, noSetup(rootDir, taskId)))!;
    commit(worker.cwd, "worker");
    commit(rootDir, "commander");
    assert.throws(() => git(worker.cwd, "merge", "main"));
    const mergeHead = path.resolve(worker.cwd, git(worker.cwd, "rev-parse", "--git-path", "MERGE_HEAD")),
      options = { source: "local" as const, instanceId: "instance" },
      admitted = lifecycleEvent("R", "owner", options),
      outcome = lifecycleEvent("O", "owner", options);
    let waiting = true,
      reads = 0;
    const read = dispatchLifecycleReadOf(() => [
      { ...admitted, payload: { ...admitted.payload, cwd: worker.cwd } } as never,
      {
        ...outcome,
        payload: {
          ...outcome.payload,
          outcome: "failed",
          ...(waiting ? { attempt: { fallbackState: "scheduled" } } : {}),
        },
      } as never,
    ]);
    const canonicalRead: typeof read = (query) => {
      reads++;
      return read(query);
    };
    const reopen = () =>
      resolveSquadCwd(
        rootDir,
        undefined,
        (() => binding) as unknown as Parameters<typeof resolveSquadCwd>[2],
        taskId,
        noWorktreeSetup(),
        canonicalRead,
      );
    await reopen();
    assert.equal(existsSync(mergeHead), true, "a stopped backoff attempt still owns the workspace");
    waiting = false;
    await reopen();
    assert.equal(existsSync(mergeHead), false);
    assert.equal(readFileSync(path.join(worker.cwd, "conflict.txt"), "utf8"), "worker");
    assert.equal(reads, 2, "both decisions use the supplied canonical port");
  }
});
