// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TaskV2, WriteReceiptDraft } from "@harness-anything/kernel";
import { applyTaskWorktreeLifecycle, materializeTaskWorktree, taskWorkspaceView } from "../src/task-worktree.ts";
import { prepareWorkerWorktree, reclaimWorkerWorktree } from "../src/squad-worker-checkout.ts";
import { repositoryBaseRef } from "../src/schedule-occurrence-workspace.ts";

const taskId = "task_12345678",
  binding = { branch: taskId, path: `.worktrees/${taskId}` };
// The binding is derived from the task and the output shape of the preset snapshot it was compiled from.
const repositoryDiff = () => ({ profile: { outputShape: "repository-diff" } });

/** The lifecycle as executeAction drives it: `write` is the ledger write the worktree step wraps. */
function lifecycle(
  root: string,
  task: () => TaskV2,
  action: { readonly kind: string; readonly taskId?: string },
  options: { readonly source?: unknown; readonly setup?: readonly string[]; readonly write?: () => WriteReceiptDraft },
) {
  return applyTaskWorktreeLifecycle(
    { rootDir: root, readTask: task, readPresetSnapshot: repositoryDiff, readSetup: () => options.setup ?? [] },
    action,
    options.source ?? "local",
    async () => (options.write ?? applied)(),
  );
}

test("the first start checks the bound worktree out once, from the default branch, and names both", async () => {
  const fixture = repositoryFixture();
  try {
    let task = boundTask("active");
    const started = await lifecycle(fixture.root, () => task, { kind: "task-start", taskId }, {}),
      cwd = path.join(fixture.root, binding.path);
    assert.equal(git(cwd, "branch", "--show-current"), taskId);
    assert.equal(git(cwd, "rev-parse", "HEAD"), git(fixture.root, "rev-parse", "origin/main"));
    assert.match(
      String((started as { summary?: unknown }).summary),
      new RegExp(`checked out on ${taskId} from origin/main\\. Harness manages this worktree; no command`, "u"),
    );
    assert.deepEqual(taskWorkspaceView(fixture.root, task, "tasks/x", repositoryDiff), {
      kind: "worktree",
      ...binding,
      state: "materialized",
    });
    // A later start or dispatch finds the checkout in place instead of cutting a second one.
    assert.deepEqual(await materializeTaskWorktree(fixture.root, task, repositoryDiff, []), {
      cwd,
      branch: taskId,
      baseRef: null,
      setup: { ok: true, ran: [] },
    });
    task = boundTask("cancelled");
    assert.equal(taskWorkspaceView(fixture.root, task, "tasks/x", repositoryDiff)?.kind, "worktree");
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("the base is the repository's own default branch: origin/HEAD, else the main checkout's branch", async () => {
  const fixture = repositoryFixture();
  try {
    // A remote without origin/HEAD: the main checkout's branch, as its origin copy.
    assert.equal(await repositoryBaseRef(fixture.root), "origin/main");
    // A remote whose default branch is not main.
    git(fixture.root, "push", "-q", "origin", "main:trunk");
    git(fixture.root, "fetch", "-q", "origin");
    git(fixture.root, "remote", "set-head", "origin", "trunk");
    assert.equal(await repositoryBaseRef(fixture.root), "origin/trunk");
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
  const local = mkdtempSync(path.join(tmpdir(), "ha-task-worktree-master-"));
  try {
    // No remote at all, default branch master: the worktree starts from the local master.
    git(local, "init", "-q", "-b", "master");
    git(local, "config", "user.name", "Worktree Test");
    git(local, "config", "user.email", "worktree@example.invalid");
    writeFileSync(path.join(local, ".gitignore"), ".worktrees\n");
    git(local, "add", ".gitignore");
    git(local, "commit", "-qm", "base");
    assert.equal(await repositoryBaseRef(local), "master");
    const checkout = await materializeTaskWorktree(local, boundTask("active"), repositoryDiff, []);
    assert.equal(checkout?.baseRef, "master");
    assert.equal(git(checkout!.cwd, "rev-parse", "HEAD"), git(local, "rev-parse", "master"));
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
});

test("setup steps run once in order inside the worktree with the Harness variables", async () => {
  const fixture = repositoryFixture();
  try {
    const record =
        'echo "$1 $HARNESS_TASK_ID $HARNESS_WORKTREE $HARNESS_REPO_ROOT" >> "$HARNESS_REPO_ROOT/../steps.txt"',
      setup = [`run: sh -c '${record}' - first`, `run: sh -c '${record}' - second`],
      task = boundTask("active"),
      started = await lifecycle(fixture.root, () => task, { kind: "task-start", taskId }, { setup }),
      cwd = path.join(fixture.root, binding.path);
    assert.deepEqual(readFileSync(path.join(fixture.base, "steps.txt"), "utf8").trim().split("\n"), [
      `first ${taskId} ${cwd} ${fixture.root}`,
      `second ${taskId} ${cwd} ${fixture.root}`,
    ]);
    assert.match(
      String((started as { summary?: unknown }).summary),
      /Setup ran: run: sh .* first; run: sh .* second\./u,
    );
    // A second start (or a dispatch) finds every step done and runs none again.
    await lifecycle(fixture.root, () => task, { kind: "task-start", taskId }, { setup });
    assert.equal(readFileSync(path.join(fixture.base, "steps.txt"), "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("a failing setup step refuses the start, keeps the worktree, and a retry reruns only what failed", async () => {
  const fixture = repositoryFixture();
  try {
    const counter = path.join(fixture.base, "count.txt"),
      gate = path.join(fixture.base, "gate"),
      setup = [`run: echo x >> ${counter}`, `run: echo checking; test -e ${gate}`],
      task = boundTask("planned");
    let writes = 0;
    const write = () => {
      writes += 1;
      return applied();
    };
    await assert.rejects(
      lifecycle(fixture.root, () => task, { kind: "task-start", taskId }, { setup, write }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "worktree_setup_failed");
        assert.match(error.message, /setup step 2 \(run: echo checking; test -e .*gate\) failed: exit code 1/u);
        assert.match(error.message, /Log: .*harness-setup\/step-2\.log\./u);
        assert.match(error.message, new RegExp(`run ha task start ${taskId} again`, "u"));
        const log = /Log: (\S+)\. /u.exec(error.message)![1]!;
        assert.equal(readFileSync(log, "utf8"), "$ run: echo checking; test -e " + gate + "\nchecking\n");
        return true;
      },
    );
    assert.equal(writes, 0, "the start is never written while setup fails");
    assert.equal(existsSync(path.join(fixture.root, binding.path)), true, "the worktree is kept");
    writeFileSync(gate, "");
    const started = await lifecycle(fixture.root, () => task, { kind: "task-start", taskId }, { setup, write });
    assert.equal(writes, 1);
    assert.match(String((started as { summary?: unknown }).summary), /Setup ran: run: echo checking/u);
    assert.equal(readFileSync(counter, "utf8"), "x\n", "the step that succeeded does not run again");
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("the node-modules adapter mirrors the root store and removes its mirror before the worktree is reclaimed", async () => {
  const fixture = repositoryFixture();
  try {
    mkdirSync(path.join(fixture.root, "node_modules", "left-pad"), { recursive: true });
    // Without the ignore rule the mirror would read as uncommitted work; the adapter's cleanup is what removes it.
    writeFileSync(path.join(fixture.root, ".gitignore"), ".worktrees\n");
    git(fixture.root, "commit", "-qam", "track node_modules visibility");
    git(fixture.root, "push", "-q", "origin", "main");
    let task = boundTask("active");
    await lifecycle(fixture.root, () => task, { kind: "task-start", taskId }, { setup: ["node-modules"] });
    const cwd = path.join(fixture.root, binding.path);
    assert.equal(lstatSync(path.join(cwd, "node_modules")).isDirectory(), true);
    assert.equal(lstatSync(path.join(cwd, "node_modules", "left-pad")).isSymbolicLink(), true);
    task = boundTask("cancelled");
    const closed = await lifecycle(fixture.root, () => task, { kind: "task-transition", taskId }, {});
    assert.equal(closed.warnings, undefined);
    assert.equal(existsSync(cwd), false);
    assert.equal(existsSync(path.join(fixture.root, "node_modules", "left-pad")), true, "the root store stays");
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("the node-modules adapter fails the step when the repository root has no store to share", async () => {
  const fixture = repositoryFixture();
  try {
    await assert.rejects(
      lifecycle(fixture.root, () => boundTask("active"), { kind: "task-start", taskId }, { setup: ["node-modules"] }),
      /setup step 1 \(node-modules\) failed: .*node_modules does not exist; install dependencies there first/u,
    );
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("a checkout whose directory was removed is restored onto its surviving branch", async () => {
  const fixture = repositoryFixture();
  try {
    const task = boundTask("active"),
      cwd = (await materializeTaskWorktree(fixture.root, task, repositoryDiff, []))!.cwd;
    writeFileSync(path.join(cwd, "kept.txt"), "kept\n");
    git(cwd, "add", "kept.txt");
    git(cwd, "commit", "-qm", "kept");
    const head = git(cwd, "rev-parse", "HEAD");
    git(fixture.root, "worktree", "remove", cwd);
    await materializeTaskWorktree(fixture.root, task, repositoryDiff, []);
    assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("a node without a default branch has no worktree to give, and forwarded writes leave checkouts alone", async () => {
  const gitless = mkdtempSync(path.join(tmpdir(), "ha-task-worktree-gitless-")),
    fixture = repositoryFixture();
  try {
    assert.equal(await materializeTaskWorktree(gitless, boundTask("active"), repositoryDiff, []), null);
    const gitlessStart = await lifecycle(gitless, () => boundTask("active"), { kind: "task-start", taskId }, {});
    assert.match(
      String((gitlessStart as { summary?: unknown }).summary),
      /No worktree on this node: no default branch/u,
    );
    assert.equal(taskWorkspaceView(gitless, boundTask("planned"), "tasks/x", repositoryDiff)?.kind, "worktree");
    const receipt = applied(),
      task = boundTask("active");
    for (const source of ["remote_direct", { kind: "assignment", nodeId: "edge", assignmentId: "a" }])
      assert.equal(
        await lifecycle(fixture.root, () => task, { kind: "task-start", taskId }, { source, write: () => receipt }),
        receipt,
      );
    assert.equal(existsSync(path.join(fixture.root, binding.path)), false);
  } finally {
    rmSync(gitless, { recursive: true, force: true });
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("a task that does not change repository files works in its own task package", () => {
  const fixture = repositoryFixture();
  try {
    assert.deepEqual(
      taskWorkspaceView(fixture.root, boundTask("active"), "tasks/task_12345678-lifecycle", () => ({
        profile: { outputShape: "task-package-artifact" },
      })),
      { kind: "task-package", path: "harness/tasks/task_12345678-lifecycle" },
    );
  } finally {
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
        summary: new RegExp(`kept at tag archive/wt-${taskId}`, "u"),
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
        const cwd = (await materializeTaskWorktree(fixture.root, task, repositoryDiff, []))!.cwd;
        scenario.work(cwd, fixture.root);
        task = boundTask("cancelled");
        const closed = await lifecycle(fixture.root, () => task, { kind: "task-transition", taskId }, {}),
          summary = (closed as { summary?: string }).summary ?? null;
        assert.equal(existsSync(cwd), scenario.expect.present);
        assert.equal(git(fixture.root, "branch", "--list", binding.branch).length > 0, scenario.expect.branch);
        assert.equal(git(fixture.root, "tag", "--list", `archive/wt-${taskId}`).length > 0, scenario.expect.tag);
        if (scenario.expect.summary) assert.match(String(summary), scenario.expect.summary);
        else assert.equal(summary, null);
        if (scenario.expect.warning) assert.match(String(closed.warnings?.[0]), scenario.expect.warning);
        else assert.equal(closed.warnings, undefined);
        const view = taskWorkspaceView(fixture.root, task, "tasks/x", repositoryDiff);
        assert.equal(view?.kind === "worktree" && view.state, scenario.expect.present ? "retained" : "reclaimed");
      } finally {
        rmSync(fixture.base, { recursive: true, force: true });
      }
    });
});

test("an applied write that leaves the task open does not touch its worktree", async () => {
  const fixture = repositoryFixture();
  try {
    const task = boundTask("active"),
      cwd = (await materializeTaskWorktree(fixture.root, task, repositoryDiff, []))!.cwd,
      receipt = applied();
    assert.equal(
      await lifecycle(fixture.root, () => task, { kind: "task-transition", taskId }, { write: () => receipt }),
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
      git(fixture.root, "switch", "-q", "-c", taskId);
      const baseSha = git(fixture.root, "rev-parse", "HEAD"),
        worker = (await prepareWorkerWorktree(
          { squadRunId: "squad_0123456789abcdef01234567", cwd: fixture.root, baseSha },
          "writer",
          "a1",
          { rootDir: fixture.root, taskId: "task_child", steps: [] },
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
    taskId,
    title: "生命周期",
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
