// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TaskV2, WriteReceiptDraft } from "@harness-anything/kernel";
import { applyTaskWorktreeLifecycle, materializeTaskWorktree, taskWorktreeView } from "../src/task-worktree.ts";
import { prepareWorkerWorktree, reclaimWorkerWorktree } from "../src/squad-worker-checkout.ts";

const binding = { branch: "codex/lifecycle-12345678", path: ".worktrees/lifecycle-12345678", baseRef: "origin/main" };
// The binding is derived from the task and the output shape of the preset snapshot it was compiled from.
const repositoryDiff = () => ({ profile: { outputShape: "repository-diff" } });

test("the first start checks the bound worktree out once and names it in the receipt", async () => {
  const fixture = repositoryFixture();
  try {
    mkdirSync(path.join(fixture.root, "node_modules"));
    let task = boundTask("active");
    const started = await applyTaskWorktreeLifecycle(
        fixture.root,
        () => task,
        repositoryDiff,
        { kind: "task-start", taskId: task.taskId },
        "local",
        applied(),
      ),
      cwd = path.join(fixture.root, binding.path);
    assert.equal(git(cwd, "branch", "--show-current"), binding.branch);
    assert.equal(git(cwd, "rev-parse", "HEAD"), git(fixture.root, "rev-parse", "origin/main"));
    // Its own store, so workspace packages resolve to the worktree rather than the canonical checkout.
    assert.equal(lstatSync(path.join(cwd, "node_modules")).isDirectory(), true);
    assert.match(String((started as { summary?: unknown }).summary), /Harness manages this worktree; no command/u);
    assert.equal(taskWorktreeView(fixture.root, task, repositoryDiff)?.state, "materialized");
    // A later start or dispatch finds the checkout in place instead of cutting a second one.
    assert.deepEqual(await materializeTaskWorktree(fixture.root, task, repositoryDiff), { cwd, note: null });
    task = boundTask("cancelled");
    assert.equal(taskWorktreeView(fixture.root, task, repositoryDiff)?.state, "retained");
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("a checkout whose directory was removed is restored onto its surviving branch", async () => {
  const fixture = repositoryFixture();
  try {
    const task = boundTask("active"),
      cwd = (await materializeTaskWorktree(fixture.root, task, repositoryDiff))!.cwd;
    writeFileSync(path.join(cwd, "kept.txt"), "kept\n");
    git(cwd, "add", "kept.txt");
    git(cwd, "commit", "-qm", "kept");
    const head = git(cwd, "rev-parse", "HEAD");
    git(fixture.root, "worktree", "remove", cwd);
    await materializeTaskWorktree(fixture.root, task, repositoryDiff);
    assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("a node without the base ref has no worktree to give, and forwarded writes leave checkouts alone", async () => {
  const gitless = mkdtempSync(path.join(tmpdir(), "ha-task-worktree-gitless-")),
    fixture = repositoryFixture();
  try {
    assert.equal(await materializeTaskWorktree(gitless, boundTask("active"), repositoryDiff), null);
    const gitlessStart = await applyTaskWorktreeLifecycle(
      gitless,
      () => boundTask("active"),
      repositoryDiff,
      { kind: "task-start", taskId: "task_12345678" },
      "local",
      applied(),
    );
    assert.match(String((gitlessStart as { summary?: unknown }).summary), /No worktree on this node: origin\/main/u);
    assert.equal(taskWorktreeView(gitless, boundTask("planned"), repositoryDiff)?.state, "bound");
    const receipt = applied(),
      task = boundTask("active");
    for (const source of ["remote_direct", { kind: "assignment", nodeId: "edge", assignmentId: "a" }])
      assert.equal(
        await applyTaskWorktreeLifecycle(
          fixture.root,
          () => task,
          repositoryDiff,
          { kind: "task-start", taskId: "t" },
          source,
          receipt,
        ),
        receipt,
      );
    assert.equal(existsSync(path.join(fixture.root, binding.path)), false);
    assert.equal(
      taskWorktreeView(fixture.root, task, () => ({ profile: { outputShape: "task-package-artifact" } })),
      null,
    );
  } finally {
    rmSync(gitless, { recursive: true, force: true });
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("closing a task reclaims its worktree by the managed-worktree rule", async (t) => {
  const cases = [
    {
      name: "clean with nothing new: worktree and branch removed",
      work: () => undefined,
      expect: { present: false, branch: false, tag: false, summary: /removed/u, warning: null },
    },
    {
      name: "unmerged commit: kept at an archive tag, then removed",
      work: (cwd: string) => commit(cwd, "unmerged.txt"),
      expect: {
        present: false,
        branch: false,
        tag: true,
        summary: /kept at tag archive\/wt-lifecycle-12345678/u,
        warning: null,
      },
    },
    {
      name: "commit already upstream by patch (squash or cherry-pick): removed without a tag",
      work: (cwd: string, root: string) => {
        commit(cwd, "landed.txt");
        git(root, "cherry-pick", git(cwd, "rev-parse", "HEAD"));
        git(root, "push", "-q", "origin", "main");
      },
      expect: { present: false, branch: false, tag: false, summary: /removed/u, warning: null },
    },
    {
      name: "uncommitted changes: retained and reported",
      work: (cwd: string) => writeFileSync(path.join(cwd, "draft.txt"), "draft\n"),
      expect: { present: true, branch: true, tag: false, summary: null, warning: /retained .*uncommitted changes/u },
    },
  ] as const;
  for (const scenario of cases)
    await t.test(scenario.name, async () => {
      const fixture = repositoryFixture();
      try {
        let task = boundTask("active");
        const cwd = (await materializeTaskWorktree(fixture.root, task, repositoryDiff))!.cwd;
        scenario.work(cwd, fixture.root);
        task = boundTask("cancelled");
        const closed = await applyTaskWorktreeLifecycle(
            fixture.root,
            () => task,
            repositoryDiff,
            { kind: "task-transition", taskId: task.taskId },
            "local",
            applied(),
          ),
          summary = (closed as { summary?: string }).summary ?? null;
        assert.equal(existsSync(cwd), scenario.expect.present);
        assert.equal(git(fixture.root, "branch", "--list", binding.branch).length > 0, scenario.expect.branch);
        assert.equal(
          git(fixture.root, "tag", "--list", "archive/wt-lifecycle-12345678").length > 0,
          scenario.expect.tag,
        );
        if (scenario.expect.summary) assert.match(String(summary), scenario.expect.summary);
        else assert.equal(summary, null);
        if (scenario.expect.warning) assert.match(String(closed.warnings?.[0]), scenario.expect.warning);
        else assert.equal(closed.warnings, undefined);
        assert.equal(
          taskWorktreeView(fixture.root, task, repositoryDiff)?.state,
          scenario.expect.present ? "retained" : "reclaimed",
        );
      } finally {
        rmSync(fixture.base, { recursive: true, force: true });
      }
    });
});

test("an applied write that leaves the task open does not touch its worktree", async () => {
  const fixture = repositoryFixture();
  try {
    const task = boundTask("active"),
      cwd = (await materializeTaskWorktree(fixture.root, task, repositoryDiff))!.cwd,
      receipt = applied();
    assert.equal(
      await applyTaskWorktreeLifecycle(
        fixture.root,
        () => task,
        repositoryDiff,
        { kind: "task-transition", taskId: task.taskId },
        "local",
        receipt,
      ),
      receipt,
    );
    assert.equal(existsSync(cwd), true);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("a finished Squad run's worker checkout is reclaimed against the Commander branch", async () => {
  for (const merged of [true, false]) {
    const fixture = repositoryFixture();
    try {
      git(fixture.root, "switch", "-q", "-c", "codex/mission");
      const baseSha = git(fixture.root, "rev-parse", "HEAD"),
        worker = (await prepareWorkerWorktree(
          { squadRunId: "squad_0123456789abcdef01234567", cwd: fixture.root, baseSha },
          "writer",
          "a1",
        ))!;
      commit(worker.cwd, "worker.txt");
      if (merged) git(fixture.root, "merge", "-q", "--no-ff", "-m", "merge worker", worker.branch);
      const result = await reclaimWorkerWorktree(fixture.root, worker);
      assert.equal(existsSync(worker.cwd), false);
      assert.deepEqual(
        result,
        merged
          ? { outcome: "removed", archiveTag: null, unmergedCommits: 0 }
          : { outcome: "removed", archiveTag: `archive/wt-${path.basename(worker.cwd)}`, unmergedCommits: 1 },
      );
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  }
});

function boundTask(status: TaskV2["status"]): TaskV2 {
  return {
    schema: "task/v2",
    taskId: "task_12345678",
    title: "Lifecycle",
    taskClass: "standard",
    status,
    graph: {} as TaskV2["graph"],
    currentNode: "implementation",
    iteration: 0,
    createdBy: { principal: { personId: "person-1" }, executor: null },
    completionGateIds: [],
    presetSnapshotDigest: `sha256:${"0".repeat(64)}`,
    pinned: false,
    metadata: {
      idempotencyKey: null,
      parentTaskId: null,
      workKind: null,
      riskTier: null,
      urgency: null,
      verticalId: "coding",
      presetId: "standard-task",
      profileId: "default",
      moduleKey: null,
      slug: "lifecycle",
      surfaces: [],
      fromLegacyId: null,
    },
  };
}

function applied(): WriteReceiptDraft {
  return { outcome: "applied", opId: "op-worktree" };
}

function commit(cwd: string, file: string): void {
  writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", file);
}

function repositoryFixture(): { readonly base: string; readonly root: string } {
  const base = mkdtempSync(path.join(tmpdir(), "ha-task-worktree-")),
    remote = path.join(base, "remote.git"),
    root = path.join(base, "canonical");
  git(base, "init", "--bare", "-q", remote);
  git(base, "init", "-q", "-b", "main", root);
  git(root, "config", "user.name", "Worktree Test");
  git(root, "config", "user.email", "worktree@example.invalid");
  writeFileSync(path.join(root, "README.md"), "base\n");
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.worktrees\n");
  git(root, "add", "README.md", ".gitignore");
  git(root, "commit", "-qm", "base");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  return { base, root };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
