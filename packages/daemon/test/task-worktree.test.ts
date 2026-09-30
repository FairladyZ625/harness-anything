// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection, type TaskV2, type WriteReceiptDraft } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import {
  applyTaskWorktreeLifecycle,
  materializeTaskWorktree,
  prepareTaskStartWorktree,
  reconcileClosedTaskWorktrees,
  taskWorkspaceView,
} from "../src/task-worktree.ts";
import { prepareWorkerWorktree, reclaimWorkerWorktree } from "../src/squad-worker-checkout.ts";
import { remoteDefaultBranch, repositoryBaseRef } from "../src/schedule-occurrence-workspace.ts";
import { readWorktreeSetupSucceeded, runWorktreeSetup, worktreeSetupFailure } from "../src/worktree-setup.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

const taskId = "task_12345678",
  binding = { branch: taskId, path: `.worktrees/${taskId}` };

test("attach cancels a rejected Squad child through the task lifecycle writer", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-startup-squad-orphan-")),
    repoId = workspaceId("startup-squad-orphan"),
    cellBinding = { actor, source: "local" as const },
    orphanTaskId = "task-squad-orphan",
    squadRunId = "squad_0123456789abcdef01234567",
    leaderDispatchId = "dispatch_000000000000000000000001";
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);
  const first = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "first-open" });
  assert.equal(
    (await first.run({ kind: "task-create", taskId: orphanTaskId, title: "Rejected Squad child" }, cellBinding))
      .outcome,
    "applied",
  );
  await first.close();
  // Model a coordinator crash after marking dirty and appending its authoritative stream.
  const projection = makeTaskProjection({ rootDir, eventStore: makeTaskEventReader({ repoId, rootDir }) });
  projection.markSquadRunProjectionDirty();
  projection.close();
  openDispatchStream(rootDir, {
    dispatchId: leaderDispatchId,
    taskId: "task-squad-parent",
    executionId: "execution-squad-parent",
    agentId: "fable",
    runtimeSessionId: "runtime-squad-leader",
    instanceId: "runtime-squad-instance",
    startedAt: "2026-09-29T00:00:00.000Z",
  });
  appendRuntimeWorkerRecord(rootDir, leaderDispatchId, {
    kind: "squad_run_state",
    squadRunId,
    revision: 1,
    state: {
      schema: "squad-run/v1",
      squadRunId,
      stateDispatchId: leaderDispatchId,
      squadId: "core-squad",
      taskId: "task-squad-parent",
      runtimeInstanceId: "runtime-squad-instance",
      cwd: rootDir,
      baseSha: null,
      mission: "Rejected child fixture",
      model: null,
      effort: null,
      leaderAgentId: "fable",
      roster: "fable -> sol",
      workers: ["sol"],
      leaderTurnBudget: 1,
      binding: cellBinding,
      leaderTurns: [],
      leaderProviderSessionId: null,
      currentLeaderRuntimeSessionId: null,
      workerAttempts: [
        {
          attemptId: "worker-sol",
          workerId: "sol",
          leaderTurnId: "leader-1",
          taskId: orphanTaskId,
          executionId: "execution-squad-orphan",
          ownedPaths: [],
          ownershipCheck: null,
          dispatchId: null,
          runtimeSessionId: null,
          worktree: null,
          rejection: "runtime admission rejected",
        },
      ],
      observedWorkerRuntimeSessionIds: [],
      workerWaits: [],
      pendingLeaderTriggers: [],
      phase: "failed",
      revision: 1,
      error: "leader budget exhausted",
    },
  });
  const reopened = await openBootstrappedRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "startup-reconciliation",
  });
  t.after(() => reopened.close());
  assert.equal(
    (await reopened.run({ kind: "task-create", taskId: "task-after-reconcile", title: "Queue sentinel" }, cellBinding))
      .outcome,
    "applied",
    "a write queued after attach waits behind startup reconciliation",
  );
  const shown = JSON.parse(
    String((await reopened.run({ kind: "task-show", taskId: orphanTaskId }, cellBinding)).evidence),
  ) as { readonly task: { readonly status: string } };
  assert.equal(shown.task.status, "cancelled");
});
// The binding is derived from the task and the output shape of the preset snapshot it was compiled from.
const repositoryDiff = () => ({ profile: { outputShape: "repository-diff" } });

/**
 * The lifecycle as the repository drives it: a start's checkout finishes before the write is queued, and the
 * queued write is `write` wrapped by the close-time reclaim.
 */
async function lifecycle(
  root: string,
  task: (id: string) => TaskV2 | null,
  action: { readonly kind: string; readonly taskId?: string },
  options: { readonly source?: unknown; readonly setup?: readonly string[]; readonly write?: () => WriteReceiptDraft },
) {
  const input = {
      rootDir: root,
      readTask: task,
      readPresetSnapshot: repositoryDiff,
      readSetup: () => options.setup ?? [],
    },
    source = options.source ?? "local",
    annotate = (await prepareTaskStartWorktree(input, action, source)) ?? ((receipt: WriteReceiptDraft) => receipt);
  return annotate(await applyTaskWorktreeLifecycle(input, action, source, async () => (options.write ?? applied)()));
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
    assert.deepEqual(taskWorkspaceView(fixture.root, task, "tasks/x", repositoryDiff, null), {
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
    assert.equal(taskWorkspaceView(fixture.root, task, "tasks/x", repositoryDiff, null)?.kind, "worktree");
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("the base is the repository's own default branch: origin/HEAD, else the main checkout's branch", async () => {
  const fixture = repositoryFixture();
  try {
    // A remote without origin/HEAD: the main checkout's branch, as its origin copy.
    assert.equal(repositoryBaseRef(fixture.root), "origin/main");
    // From a linked worktree the fallback is still the main checkout's branch, not the worktree's own.
    const linked = (await materializeTaskWorktree(fixture.root, boundTask("active"), repositoryDiff, []))!.cwd;
    assert.equal(remoteDefaultBranch(linked), "origin/main");
    // A remote whose default branch is not main.
    git(fixture.root, "push", "-q", "origin", "main:trunk");
    git(fixture.root, "fetch", "-q", "origin");
    git(fixture.root, "remote", "set-head", "origin", "trunk");
    assert.equal(repositoryBaseRef(fixture.root), "origin/trunk");
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
    assert.equal(repositoryBaseRef(local), "master");
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

test("a task read sees only the setup steps that succeeded in this worktree, not the ones Settings declares", async () => {
  const fixture = repositoryFixture();
  try {
    const checkout = await materializeTaskWorktree(fixture.root, boundTask("active"), repositoryDiff, []);
    // Checked out before Settings declared anything: nothing has run here yet.
    assert.deepEqual(readWorktreeSetupSucceeded(checkout!.cwd), []);
    await runWorktreeSetup({ rootDir: fixture.root, cwd: checkout!.cwd, taskId, steps: ["run: true", "run: false"] });
    assert.deepEqual(readWorktreeSetupSucceeded(checkout!.cwd), ["run: true"]);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("a run step still going at the timeout fails like any other step and names the timeout and its log", async () => {
  const fixture = repositoryFixture();
  try {
    const task = boundTask("active"),
      checkout = await materializeTaskWorktree(fixture.root, task, repositoryDiff, []),
      startedAt = Date.now(),
      result = await runWorktreeSetup({
        rootDir: fixture.root,
        cwd: checkout!.cwd,
        taskId,
        steps: ["run: echo installing; sleep 30"],
        stepTimeoutMs: 300,
      });
    assert.ok(Date.now() - startedAt < 10_000, "the step is stopped at the timeout, not waited out");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.detail, "timed out after 0.3s");
    assert.match(
      worktreeSetupFailure(checkout!.cwd, result, `run ha task start ${taskId} again`),
      /setup step 1 \(run: echo installing; sleep 30\) failed: timed out after 0\.3s\. Log: .*harness-setup\/step-1\.log\./u,
    );
    assert.match(readFileSync(result.log, "utf8"), /^\$ run: echo installing; sleep 30\ninstalling\n/u);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test(
  "a run step stopped at the timeout takes the processes it started with it",
  { skip: process.platform === "win32" ? "POSIX process groups" : false },
  async () => {
    const fixture = repositoryFixture();
    try {
      const task = boundTask("active"),
        checkout = await materializeTaskWorktree(fixture.root, task, repositoryDiff, []),
        pidFile = path.join(fixture.base, "install.pid"),
        result = await runWorktreeSetup({
          rootDir: fixture.root,
          cwd: checkout!.cwd,
          taskId,
          // Like `npm ci`: the shell waits on a process it started, which would keep writing the worktree.
          steps: [`run: sleep 30 & echo $! > ${pidFile}; wait`],
          stepTimeoutMs: 300,
        });
      assert.equal(result.ok, false);
      const pid = Number(readFileSync(pidFile, "utf8"));
      for (const deadline = Date.now() + 5_000; alive(pid); ) {
        assert.ok(Date.now() < deadline, `the step's child ${pid} outlived the refused step`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  },
);

/** A killed orphan left unreaped (a container whose init reaps nothing) is a zombie, not a running process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // The process can be reaped between the signal probe and the stat read; a missing stat means it is gone.
    return process.platform !== "linux" || !/^\d+ \(.*\) Z /u.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

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
    assert.equal(taskWorkspaceView(gitless, boundTask("planned"), "tasks/x", repositoryDiff, null)?.kind, "worktree");
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
      taskWorkspaceView(
        fixture.root,
        boundTask("active"),
        "tasks/task_12345678-lifecycle",
        () => ({
          profile: { outputShape: "task-package-artifact" },
        }),
        path.join(fixture.root, "harness"),
      ),
      { kind: "task-package", path: "harness/tasks/task_12345678-lifecycle" },
    );
    // The agenda passes no authored root and so reads no files: a task-package workspace is simply not shown there.
    assert.equal(
      taskWorkspaceView(
        fixture.root,
        boundTask("active"),
        "tasks/task_12345678-lifecycle",
        () => ({
          profile: { outputShape: "task-package-artifact" },
        }),
        null,
      ),
      null,
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
        const view = taskWorkspaceView(fixture.root, task, "tasks/x", repositoryDiff, null);
        assert.equal(view?.kind === "worktree" && view.state, scenario.expect.present ? "retained" : "reclaimed");
      } finally {
        rmSync(fixture.base, { recursive: true, force: true });
      }
    });
});

test("a worktree retained at close is reclaimed by a later close on this node once it is clean", async (t) => {
  for (const clean of [true, false])
    await t.test(clean ? "cleaned: reclaimed" : "still dirty: retained", async () => {
      const fixture = repositoryFixture(),
        otherId = "task_87654321",
        tasks = new Map<string, TaskV2>([
          [taskId, boundTask("active")],
          [otherId, { ...boundTask("active"), taskId: otherId }],
        ]),
        readTask = (id: string) => tasks.get(id) ?? null,
        close = (id: string) => {
          tasks.set(id, { ...tasks.get(id)!, status: "cancelled" });
          return lifecycle(fixture.root, readTask, { kind: "task-transition", taskId: id }, {});
        };
      try {
        const cwd = (await materializeTaskWorktree(fixture.root, readTask(taskId), repositoryDiff, []))!.cwd,
          otherCwd = (await materializeTaskWorktree(fixture.root, readTask(otherId), repositoryDiff, []))!.cwd,
          // A worktree no task is bound to (a schedule occurrence, a Squad worker) is not this rule's to reclaim.
          unbound = path.join(fixture.root, ".worktrees", "occ-unbound");
        mkdirSync(unbound);
        writeFileSync(path.join(cwd, "draft.txt"), "draft\n");
        assert.match(String((await close(taskId)).warnings?.[0]), /retained .*uncommitted changes/u);
        if (clean) rmSync(path.join(cwd, "draft.txt"));
        const later = await close(otherId);
        assert.equal(existsSync(otherCwd), false);
        assert.equal(existsSync(cwd), !clean);
        assert.equal(git(fixture.root, "branch", "--list", taskId).length > 0, !clean);
        assert.equal(existsSync(unbound), true);
        if (clean)
          assert.match(String((later as { summary?: string }).summary), new RegExp(`${taskId} and branch`, "u"));
        assert.equal(later.warnings, undefined);
      } finally {
        rmSync(fixture.base, { recursive: true, force: true });
      }
    });
});

test("the standalone reconciliation reclaims what a failed close left behind once it is clean", async (t) => {
  // The daemon-start pass and the close pass run the same function; only the report differs.
  for (const clean of [true, false])
    await t.test(clean ? "cleaned: reclaimed with a note" : "still dirty: retained row only", async () => {
      const fixture = repositoryFixture(),
        otherId = "task_87654321",
        openId = "task_55555555",
        tasks = new Map<string, TaskV2>([
          [taskId, boundTask("active")],
          [otherId, { ...boundTask("active"), taskId: otherId }],
          [openId, { ...boundTask("active"), taskId: openId }],
        ]),
        readTask = (id: string) => tasks.get(id) ?? null;
      try {
        const cwd = (await materializeTaskWorktree(fixture.root, readTask(taskId), repositoryDiff, []))!.cwd,
          otherCwd = (await materializeTaskWorktree(fixture.root, readTask(otherId), repositoryDiff, []))!.cwd,
          openCwd = (await materializeTaskWorktree(fixture.root, readTask(openId), repositoryDiff, []))!.cwd;
        writeFileSync(path.join(cwd, "draft.txt"), "draft\n");
        writeFileSync(path.join(otherCwd, "draft.txt"), "draft\n");
        // Both tasks close while dirty: the close-time reclaim fails once, both worktrees stay.
        for (const id of [taskId, otherId]) {
          tasks.set(id, { ...tasks.get(id)!, status: "cancelled" });
          await lifecycle(fixture.root, readTask, { kind: "task-transition", taskId: id }, {});
        }
        assert.equal(existsSync(cwd) && existsSync(otherCwd), true);
        // The daemon-start pass runs once the dirt is gone; the still-dirty task keeps its worktree.
        rmSync(path.join(otherCwd, "draft.txt"));
        if (clean) rmSync(path.join(cwd, "draft.txt"));
        const rows = await reconcileClosedTaskWorktrees({
            rootDir: fixture.root,
            readTask,
            readPresetSnapshot: repositoryDiff,
            readSetup: () => [],
          }),
          rowOf = (id: string) => rows.find((row) => row.taskId === id);
        assert.deepEqual(
          rows.map((row) => [row.taskId, row.named, row.result.outcome]).sort(),
          clean
            ? [
                [taskId, false, "removed"],
                [otherId, false, "removed"],
              ]
            : [
                [taskId, false, "retained"],
                [otherId, false, "removed"],
              ],
        );
        if (clean) assert.equal(rowOf(taskId)!.detail, null, "a plain removal says nothing by itself");
        else assert.match(String(rowOf(taskId)!.detail), /retained .*uncommitted changes/u);
        // A named close passes its own task in, so a retained worktree is that write's warning to carry.
        assert.equal(rowOf(otherId)!.named, false);
        assert.equal(existsSync(otherCwd), false, "the clean closed task's worktree is reclaimed");
        assert.equal(existsSync(cwd), !clean, "the dirty one is still kept");
        assert.equal(existsSync(openCwd), true, "an open task's worktree is not this pass's to touch");
        assert.equal(git(fixture.root, "branch", "--list", otherId).length, 0);
        assert.equal(git(fixture.root, "branch", "--list", openId).length > 0, true);
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
          { squadRunId: "squad_0123456789abcdef01234567", cwd: fixture.root },
          baseSha,
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
