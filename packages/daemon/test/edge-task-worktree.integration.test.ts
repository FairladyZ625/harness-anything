// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { TaskWorktreeBindingV1 } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, dispatchStreamPath, openDispatchStream } from "../src/dispatch-stream.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";
import { pushWorkerBranch } from "../src/runtime-worker-push.ts";
import type { RuntimeSpawnerInput } from "../src/runtime-spawn-types.ts";
import { makeRuntimeSpawner } from "../src/runtime-spawner.ts";
import { checkoutTaskWorktree } from "../src/task-worktree.ts";
import { noWorktreeSetup } from "../src/worktree-setup.ts";

// dec_57370FF2021DADF04E3B21724D: an edge node holds no ledger, so the center delivers the task's worktree binding
// (CH1), the edge dispatch works in that worktree (CH2), and a node that takes a task over continues the branch the
// previous node pushed (CH3). Two clones of one bare remote stand for two nodes; each holds its mirrored ledger.

const taskId = "task_e0000000000000000000beef",
  binding: TaskWorktreeBindingV1 = { branch: taskId, path: `.worktrees/${taskId}` },
  packagePath = path.join("harness", "tasks", `${taskId}-edge`),
  edgeBinding = {
    actor: { principal: { personId: "fleet-edge" }, executor: null },
    source: { kind: "node" as const, nodeId: "node-a" },
  };

test("an edge dispatch without a cwd launches in the worktree the center's binding names", async (t) => {
  const fixture = nodesFixture(t),
    edge = edgeSpawner(fixture.nodeA, binding);
  await assert.rejects(
    edge.spawn({ taskId, runtimeInstanceId: "edge-instance", dispatchKey: "edge-worker" }),
    launched,
  );
  const cwd = path.join(fixture.nodeA, binding.path);
  assert.deepEqual(edge.launchedIn, [cwd]);
  assert.equal(git(cwd, "branch", "--show-current"), taskId);
  assert.equal(git(cwd, "rev-parse", "HEAD"), git(fixture.nodeA, "rev-parse", "origin/main"));
  assert.match(edge.prompts[0]!, new RegExp(`Worker repository root: ${cwd}\\n`, "u"));
  assert.match(edge.prompts[0]!, new RegExp(`Worktree ${cwd} is checked out on ${taskId} from origin/main\\.`, "u"));
  // The mission names the mirrored task package under the worker's own root, where the worker can read it.
  const reached = path.join(cwd, packagePath);
  assert.match(edge.prompts[0]!, new RegExp(`Task package root: ${reached}\n`, "u"));
  assert.match(edge.prompts[0]!, new RegExp(`Your task package is ${reached}\\.`, "u"));
  assert.equal(edge.prompts[0]!.includes(path.join(fixture.nodeA, packagePath)), false);
  assert.equal(readFileSync(path.join(reached, "task_plan.md"), "utf8"), "# Plan\n");
  assert.equal(git(cwd, "status", "--porcelain"), "", "the linked ledger is ignored, not untracked");

  // Two tasks on one node each get their own checkout; the second leaves the first where it is.
  const otherId = "task_e0000000000000000000cafe",
    other = edgeSpawner(fixture.nodeA, { branch: otherId, path: `.worktrees/${otherId}` });
  await assert.rejects(
    other.spawn({ taskId: otherId, runtimeInstanceId: "edge-instance", dispatchKey: "edge-other" }),
    launched,
  );
  assert.deepEqual(other.launchedIn, [path.join(fixture.nodeA, ".worktrees", otherId)]);
  assert.equal(git(cwd, "branch", "--show-current"), taskId);
});

test("edge dispatch cwd follows its worktree or artifact package, including the reviewer seat", async (t) => {
  const fixture = nodesFixture(t),
    reviewer = edgeSpawner(fixture.nodeA, binding);
  await assert.rejects(
    reviewer.spawn({
      taskId,
      runtimeInstanceId: "edge-instance",
      dispatchKey: "edge-reviewer",
      role: "reviewer",
      executionId: "execution-a",
    }),
    launched,
    "a reviewer",
  );
  const reviewCwd = path.join(fixture.nodeA, binding.path);
  assert.deepEqual(reviewer.launchedIn, [reviewCwd], "a reviewer");
  assert.equal(git(reviewCwd, "branch", "--show-current"), taskId);
  assert.match(reviewer.prompts[0]!, new RegExp(`Task package root: ${path.join(reviewCwd, packagePath)}\n`, "u"));
  assert.deepEqual(readdirSync(path.join(fixture.nodeA, ".worktrees")), [taskId]);

  const cases: readonly {
    readonly name: string;
    readonly payload: JsonObject;
    readonly worktree?: TaskWorktreeBindingV1 | null;
  }[] = [
    { name: "a requested cwd", payload: { cwd: { scope: "repo-root" } } },
    { name: "a task the center binds no worktree to", payload: {}, worktree: null },
  ];
  for (const [index, scenario] of cases.entries()) {
    const edge = edgeSpawner(fixture.nodeA, scenario.worktree === undefined ? binding : scenario.worktree);
    await assert.rejects(
      edge.spawn({
        taskId,
        runtimeInstanceId: "edge-instance",
        dispatchKey: `edge-root-${index}`,
        ...scenario.payload,
      }),
      launched,
      scenario.name,
    );
    assert.deepEqual(
      edge.launchedIn,
      [scenario.worktree === null ? path.join(fixture.nodeA, packagePath) : fixture.nodeA],
      scenario.name,
    );
    assert.match(edge.prompts[0]!, new RegExp(`Task package root: ${path.join(fixture.nodeA, packagePath)}\n`, "u"));
    assert.deepEqual(readdirSync(path.join(fixture.nodeA, ".worktrees")), [taskId], scenario.name);
  }
  // A dry-run preview assembles the prompt and checks nothing else out.
  const preview = edgeSpawner(fixture.nodeA, binding),
    previewed = await preview.spawn({
      taskId,
      runtimeInstanceId: "edge-instance",
      dispatchKey: "edge-preview",
      dryRun: true,
    });
  assert.equal(previewed.schema, "agent-dispatch-preview/v1");
  assert.deepEqual(readdirSync(path.join(fixture.nodeA, ".worktrees")), [taskId]);
});

test("a Git-less edge has no worktree to give and works in its workspace root", async (t) => {
  const gitless = mkdtempSync(path.join(tmpdir(), "ha-edge-worktree-gitless-"));
  t.after(() => rmSync(gitless, { recursive: true, force: true }));
  const edge = edgeSpawner(gitless, binding);
  await assert.rejects(
    edge.spawn({ taskId, runtimeInstanceId: "edge-instance", dispatchKey: "edge-gitless" }),
    launched,
  );
  assert.deepEqual(edge.launchedIn, [gitless]);
  assert.equal(existsSync(path.join(gitless, ".worktrees")), false);
});

test("a node that takes a task over continues from the branch the previous node pushed", async (t) => {
  const fixture = nodesFixture(t),
    first = (await checkoutTaskWorktree(fixture.nodeA, taskId, binding, noWorktreeSetup()))!;
  assert.equal(first.baseRef, "origin/main");
  const delivered = commit(first.cwd, "node-a.txt");
  assert.deepEqual(await pushWorkerBranch({ cwd: first.cwd, canonicalRoot: fixture.nodeA, taskId }), {
    attempted: true,
    ok: true,
    branch: taskId,
    head: delivered,
    pushedCommit: delivered,
  });

  const second = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!;
  assert.equal(second.baseRef, `origin/${taskId}`, "the checkout names the pushed branch it continues");
  assert.equal(git(second.cwd, "rev-parse", "HEAD"), delivered);
  assert.equal(git(second.cwd, "branch", "--show-current"), taskId);
  // The continuing node's own delivery fast-forwards the published branch.
  const continued = commit(second.cwd, "node-b.txt");
  assert.equal((await pushWorkerBranch({ cwd: second.cwd, canonicalRoot: fixture.nodeB, taskId })).attempted, true);
  assert.equal(git(fixture.remote, "rev-parse", `refs/heads/${taskId}`), continued);
  assert.equal(git(fixture.remote, "merge-base", "--is-ancestor", delivered, continued), "");
});

test("a node whose checkout predates another node's push cannot overwrite the published task branch", async (t) => {
  const fixture = nodesFixture(t),
    // Both nodes check the task out before either delivers: each starts from the default branch.
    onA = (await checkoutTaskWorktree(fixture.nodeA, taskId, binding, noWorktreeSetup()))!,
    onB = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!,
    fromA = commit(onA.cwd, "node-a.txt");
  commit(onB.cwd, "node-b.txt");
  assert.equal((await pushWorkerBranch({ cwd: onA.cwd, canonicalRoot: fixture.nodeA, taskId })).attempted, true);
  assert.equal(git(fixture.remote, "rev-parse", `refs/heads/${taskId}`), fromA);

  const late = await pushWorkerBranch({ cwd: onB.cwd, canonicalRoot: fixture.nodeB, taskId });
  assert.equal(late.attempted && !late.ok, true, JSON.stringify(late));
  assert.match(late.attempted && !late.ok ? late.detail : "", /stale info|rejected/u);
  assert.equal(git(fixture.remote, "rev-parse", `refs/heads/${taskId}`), fromA, "the first delivery stays published");
});

test("a node refused before it worked takes the task over from what the other node pushed", async (t) => {
  const fixture = nodesFixture(t),
    // Node B's dispatch was refused after its checkout: an idle worktree at the default branch stays behind.
    idle = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!,
    onA = (await checkoutTaskWorktree(fixture.nodeA, taskId, binding, noWorktreeSetup()))!,
    delivered = commit(onA.cwd, "node-a.txt");
  assert.equal((await pushWorkerBranch({ cwd: onA.cwd, canonicalRoot: fixture.nodeA, taskId })).attempted, true);
  assert.equal(git(idle.cwd, "rev-parse", "HEAD"), git(fixture.nodeB, "rev-parse", "origin/main"));

  const resumed = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!;
  assert.equal(resumed.cwd, idle.cwd);
  assert.equal(resumed.baseRef, null, "the checkout was already here");
  assert.equal(git(resumed.cwd, "rev-parse", "HEAD"), delivered, "the idle checkout is brought up to the push");
  const continued = commit(resumed.cwd, "node-b.txt"),
    pushed = await pushWorkerBranch({ cwd: resumed.cwd, canonicalRoot: fixture.nodeB, taskId });
  assert.equal(pushed.attempted && pushed.ok, true, JSON.stringify(pushed));
  assert.equal(git(fixture.remote, "rev-parse", `refs/heads/${taskId}`), continued);
  assert.equal(git(fixture.remote, "merge-base", "--is-ancestor", delivered, continued), "");
  // The node that pushed last is not behind: its next checkout fetches and changes nothing.
  await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup());
  assert.equal(git(resumed.cwd, "rev-parse", "HEAD"), continued);
});

test("an idle checkout a refused dispatch cut is advanced to the present default branch on retry", async (t) => {
  const fixture = nodesFixture(t),
    // The refused dispatch's checkout: cut from the default branch before the prerequisite landed on it.
    idle = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!,
    stale = git(idle.cwd, "rev-parse", "HEAD");
  // The prerequisite merges and this node's view of the default branch moves with it.
  const merged = commit(fixture.nodeA, "prerequisite.txt");
  git(fixture.nodeA, "push", "-q", "origin", "main");
  git(fixture.nodeB, "fetch", "-q", "origin", "main");

  const retry = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!;
  assert.equal(retry.cwd, idle.cwd);
  assert.equal(retry.baseRef, null, "the checkout was already here");
  assert.equal(git(retry.cwd, "rev-parse", "HEAD"), merged, "the idle checkout starts the retry on current main");
  assert.equal(git(retry.cwd, "merge-base", "--is-ancestor", stale, merged), "", "the advance is a fast-forward");
});

test("an advancing default branch leaves a checkout that holds work of its own exactly where it is", async (t) => {
  for (const scenario of ["a commit of its own", "an uncommitted change"] as const) {
    const fixture = nodesFixture(t),
      checkout = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!;
    if (scenario === "a commit of its own") commit(checkout.cwd, "node-b.txt");
    else writeFileSync(path.join(checkout.cwd, "src", "index.txt"), "edited on node b\n");
    commit(fixture.nodeA, "prerequisite.txt");
    git(fixture.nodeA, "push", "-q", "origin", "main");
    git(fixture.nodeB, "fetch", "-q", "origin", "main");
    const head = git(checkout.cwd, "rev-parse", "HEAD"),
      status = git(checkout.cwd, "status", "--porcelain");

    await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup());
    assert.equal(git(checkout.cwd, "rev-parse", "HEAD"), head, scenario);
    assert.equal(git(checkout.cwd, "status", "--porcelain"), status, scenario);
  }
});

test("a checkout behind the published branch that holds work of its own is refused and left untouched", async (t) => {
  for (const scenario of ["a commit of its own", "an uncommitted change"] as const) {
    const fixture = nodesFixture(t),
      onB = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!,
      onA = (await checkoutTaskWorktree(fixture.nodeA, taskId, binding, noWorktreeSetup()))!;
    commit(onA.cwd, "node-a.txt");
    assert.equal((await pushWorkerBranch({ cwd: onA.cwd, canonicalRoot: fixture.nodeA, taskId })).attempted, true);
    if (scenario === "a commit of its own") commit(onB.cwd, "node-b.txt");
    else writeFileSync(path.join(onB.cwd, "src", "index.txt"), "edited on node b\n");
    const head = git(onB.cwd, "rev-parse", "HEAD"),
      status = git(onB.cwd, "status", "--porcelain"),
      message = await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()).then(
        () => assert.fail(`${scenario} was expected to stay refused`),
        (error: unknown) => {
          assert.ok(error instanceof Error, scenario);
          assert.equal((error as { code?: unknown }).code, "task_worktree_diverged", scenario);
          assert.equal(error.message.includes(onB.cwd), true, scenario);
          assert.equal(error.message.includes(`origin/${taskId}`), true, scenario);
          return error.message;
        },
      );
    assert.equal(
      message.includes(
        scenario === "a commit of its own"
          ? `git -C ${onB.cwd} rebase origin/${taskId}`
          : `git -C ${onB.cwd} status --short`,
      ),
      true,
      `${scenario}: the refusal names one command that can be run as written`,
    );
    assert.equal(git(onB.cwd, "rev-parse", "HEAD"), head, scenario);
    assert.equal(git(onB.cwd, "status", "--porcelain"), status, scenario);
  }
});

test("a checkout a stopped runtime left mid-rebase or mid-merge is recovered before dispatch", async (t) => {
  for (const operation of ["rebase", "merge"] as const) {
    const fixture = nodesFixture(t),
      onB = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!;
    // A published commit plus newer local work: recovering the operation must keep both.
    commit(onB.cwd, "task-change.txt");
    assert.equal((await pushWorkerBranch({ cwd: onB.cwd, canonicalRoot: fixture.nodeB, taskId })).attempted, true);
    const localTip = commit(onB.cwd, "task-change-2.txt");
    // Main edits the file the task changed, so the operation stops on a conflict and is left behind.
    writeFileSync(path.join(fixture.nodeA, "task-change.txt"), "main\n");
    git(fixture.nodeA, "add", "task-change.txt");
    git(fixture.nodeA, "commit", "-qm", "main moves");
    git(fixture.nodeA, "push", "-q", "origin", "main");
    git(fixture.nodeB, "fetch", "-q", "origin");
    conflicting(onB.cwd, operation, "origin/main");
    assert.equal(
      existsSync(gitPath(onB.cwd, "rebase-merge")) || existsSync(gitPath(onB.cwd, "rebase-apply")),
      operation === "rebase",
      operation,
    );
    assert.equal(existsSync(gitPath(onB.cwd, "MERGE_HEAD")), operation === "merge", operation);

    const resumed = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!;
    assert.equal(resumed.cwd, onB.cwd, operation);
    assert.equal(git(onB.cwd, "rev-parse", "HEAD"), localTip, `${operation}: the local commits are kept`);
    assert.equal(git(onB.cwd, "status", "--porcelain"), "", `${operation}: the half-done operation is gone`);
    assert.equal(existsSync(gitPath(onB.cwd, "rebase-merge")), false, operation);
    assert.equal(existsSync(gitPath(onB.cwd, "rebase-apply")), false, operation);
    assert.equal(existsSync(gitPath(onB.cwd, "MERGE_HEAD")), false, operation);
  }
});

test("a live dispatch keeps the rebase it is in, and the retry after it exits clears it", async (t) => {
  const fixture = nodesFixture(t),
    onB = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!;
  commit(onB.cwd, "task-change.txt");
  assert.equal((await pushWorkerBranch({ cwd: onB.cwd, canonicalRoot: fixture.nodeB, taskId })).attempted, true);
  writeFileSync(path.join(fixture.nodeA, "task-change.txt"), "main\n");
  git(fixture.nodeA, "add", "task-change.txt");
  git(fixture.nodeA, "commit", "-qm", "main moves");
  git(fixture.nodeA, "push", "-q", "origin", "main");
  git(fixture.nodeB, "fetch", "-q", "origin");
  const localTip = git(onB.cwd, "rev-parse", "HEAD");
  conflicting(onB.cwd, "rebase", "origin/main");
  const stoppedHead = git(onB.cwd, "rev-parse", "HEAD"),
    status = git(onB.cwd, "status", "--porcelain"),
    dispatchId = liveDispatch(fixture.nodeB, onB.cwd);

  await assert.rejects(
    checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()),
    (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "task_worktree_diverged",
    "a live dispatch's rebase is not aborted",
  );
  assert.equal(existsSync(gitPath(onB.cwd, "rebase-merge")), true, "the live dispatch keeps its worktree");
  assert.equal(git(onB.cwd, "rev-parse", "HEAD"), stoppedHead);
  assert.equal(git(onB.cwd, "status", "--porcelain"), status);

  // The runtime exits: the next retry may clear the rebase it left behind.
  appendRuntimeWorkerRecord(fixture.nodeB, dispatchId, { kind: "process_exit", exitCode: 0, signal: null });
  await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup());
  assert.equal(existsSync(gitPath(onB.cwd, "rebase-merge")), false);
  assert.equal(git(onB.cwd, "rev-parse", "HEAD"), localTip, "abort restores the branch the runtime had");
  assert.equal(git(onB.cwd, "status", "--porcelain"), "");
});

test("a rewritten checkout continues after the default branch moves past the commit it was rebased onto", async (t) => {
  const fixture = nodesFixture(t),
    onA = (await checkoutTaskWorktree(fixture.nodeA, taskId, binding, noWorktreeSetup()))!,
    onB = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!;
  commit(onA.cwd, "task-change.txt");
  commit(onB.cwd, "task-change.txt");
  assert.equal((await pushWorkerBranch({ cwd: onA.cwd, canonicalRoot: fixture.nodeA, taskId })).attempted, true);

  // Node B rewrites its copy of the task commit onto the default branch...
  commit(fixture.nodeA, "main-change.txt");
  git(fixture.nodeA, "push", "-q", "origin", "main");
  git(fixture.nodeB, "fetch", "-q", "origin");
  git(onB.cwd, "rebase", "-q", "origin/main");
  const rebased = git(onB.cwd, "rev-parse", "HEAD");
  // ...and the default branch moves on again before the retry, so the checkout no longer contains its tip.
  commit(fixture.nodeA, "main-change-2.txt");
  git(fixture.nodeA, "push", "-q", "origin", "main");
  git(fixture.nodeB, "fetch", "-q", "origin");

  const resumed = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!;
  assert.equal(resumed.cwd, onB.cwd);
  assert.equal(git(onB.cwd, "rev-parse", "HEAD"), rebased, "the local rewrite is the newer progress");
  assert.equal(git(onB.cwd, "status", "--porcelain"), "");
  assert.equal(git(onB.cwd, "rev-parse", "origin/main"), git(fixture.nodeA, "rev-parse", "origin/main"));
  assert.notEqual(
    git(onB.cwd, "merge-base", "origin/main", "HEAD"),
    git(fixture.nodeA, "rev-parse", "origin/main"),
    "the checkout may still be based on the previous default branch",
  );
});

test("a clean rebase-equivalent task checkout continues when the published branch has the old commits", async (t) => {
  const fixture = nodesFixture(t),
    onA = (await checkoutTaskWorktree(fixture.nodeA, taskId, binding, noWorktreeSetup()))!,
    onB = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!;
  commit(onA.cwd, "task-change.txt");
  commit(onB.cwd, "task-change.txt");
  assert.equal((await pushWorkerBranch({ cwd: onA.cwd, canonicalRoot: fixture.nodeA, taskId })).attempted, true);

  const defaultTip = commit(fixture.nodeA, "main-change.txt");
  git(fixture.nodeA, "push", "-q", "origin", "main");
  git(fixture.nodeB, "fetch", "-q", "origin");
  git(onB.cwd, "rebase", "-q", "origin/main");
  const rebased = git(onB.cwd, "rev-parse", "HEAD");

  const resumed = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, noWorktreeSetup()))!;
  assert.equal(resumed.cwd, onB.cwd);
  assert.equal(git(onB.cwd, "rev-parse", "HEAD"), rebased);
  assert.equal(git(onB.cwd, "merge-base", "origin/main", "HEAD"), defaultTip);
  assert.equal(git(onB.cwd, "status", "--porcelain"), "");
});

const launchSentinel = "edge launch reached";
function launched(error: unknown): boolean {
  return error instanceof Error && error.message === launchSentinel;
}

/** A remote-edge spawner whose center read delivers `worktree`; it stops at the launch boundary and records the cwd. */
function edgeSpawner(rootDir: string, worktree: TaskWorktreeBindingV1 | null) {
  const launchedIn: string[] = [],
    prompts: string[] = [],
    spawner = makeRuntimeSpawner({
      repoId: "edge-repo",
      rootDir,
      daemonGeneration: 1,
      runtimeNode: { nodeId: "node-a" },
      runtimeDaemonRoute: { userRoot: path.join(rootDir, ".user"), daemonId: "edge", endpoint: "/tmp/edge.sock" },
      remote: {
        existing: async () => null,
        taskContext: async () => ({
          executionId: "execution-a",
          mission: (packageRoot: string) => `Your task package is ${packageRoot}.`,
          packageRoot: path.join(rootDir, packagePath),
          causalContext: null,
          worktree,
        }),
        readRuntimeSessions: async () => [],
        publish: async () => assert.fail("the launch boundary precedes every publication"),
        archive: async () => assert.fail("nothing settles before launch"),
      },
      stream: { publish: () => ({}) as never },
      now: () => "2026-10-01T00:00:00.000Z",
      readSettings: () => ({ worktree: { setup: [] }, runtime: { allowedInstances: ["edge-instance"] } }) as never,
      runtimeInstances: () => [{ instanceId: "edge-instance", enabled: true, kindId: "codex" }] as never,
      prepareLaunch: async (_instanceId, request) => {
        launchedIn.push(request.cwd);
        prompts.push(request.prompt);
        throw new Error(launchSentinel);
      },
      schedule: () => undefined,
    } as unknown as RuntimeSpawnerInput);
  return { launchedIn, prompts, spawn: (payload: JsonObject) => spawner.spawn(payload, edgeBinding) };
}

function nodesFixture(t: TestContext): { readonly remote: string; readonly nodeA: string; readonly nodeB: string } {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-edge-worktree-"))),
    remote = path.join(base, "remote.git"),
    seed = path.join(base, "seed"),
    nodeA = path.join(base, "node-a"),
    nodeB = path.join(base, "node-b");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  git(base, "init", "--bare", "-q", "-b", "main", remote);
  git(base, "init", "-q", "-b", "main", seed);
  identify(seed);
  mkdirSync(path.join(seed, "src"));
  writeFileSync(path.join(seed, "src", "index.txt"), "base\n");
  writeFileSync(path.join(seed, ".gitignore"), "/harness/\n.worktrees\n.harness\n.user\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "base");
  git(seed, "push", "-q", remote, "main");
  for (const node of [nodeA, nodeB]) {
    git(base, "clone", "-q", remote, node);
    identify(node);
    // The node's mirrored ledger: ignored by the project repository, so no worktree checks it out.
    mkdirSync(path.join(node, packagePath), { recursive: true });
    writeFileSync(path.join(node, packagePath, "task_plan.md"), "# Plan\n");
    writeFileSync(path.join(node, "harness", "harness.yaml"), "layout:\n");
  }
  return { remote, nodeA, nodeB };
}

function identify(root: string): void {
  git(root, "config", "user.name", "Edge Worktree Test");
  git(root, "config", "user.email", "edge-worktree@example.invalid");
}

function commit(cwd: string, file: string): string {
  writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", `feat: ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

function git(cwd: string, ...args: string[]): string {
  // A task-bound host injects GIT_AUTHOR_*/GIT_COMMITTER_* and its own git config; env beats both repo config
  // and -c flags, so the fixture must not inherit either.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
  for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"])
    delete env[name];
  delete env.HARNESS_TASK_BOUND;
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }).trim();
}

/** Where git keeps one in-progress operation's state; resolute because the daemon does not run inside the checkout. */
function gitPath(cwd: string, name: string): string {
  return path.resolve(cwd, git(cwd, "rev-parse", "--git-path", name));
}

/** An operation the fixture expects to stop on a conflict: git's exit status is the assertion. */
function conflicting(cwd: string, ...args: string[]): void {
  let status: number | undefined;
  try {
    git(cwd, ...args);
  } catch (error) {
    status = (error as { status?: number }).status;
  }
  assert.equal(status, 1, `git ${args.join(" ")} was expected to stop on a conflict`);
}

/** A dispatch whose worker (this test process) is running with its cwd inside the worktree. */
function liveDispatch(rootDir: string, cwd: string): string {
  const dispatchId = "dispatch_0123456789abcdef01234567";
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId: "runtime_edge_live",
    instanceId: "instance-1",
    startedAt: "2026-10-21T00:00:00.000Z",
    dispatchOpId: "edge-live-op",
    kindId: "codex",
    permissionMode: null,
    binding: { actor: { principal: { personId: "person-1" }, executor: null }, source: "local" },
    cwd,
    prompt: "work in the task worktree",
    model: "gpt-5.6-sol",
    reasoningEffort: null,
    fast: false,
  } as Parameters<typeof openDispatchStream>[1]);
  appendFileSync(
    dispatchStreamPath(rootDir, dispatchId),
    `${JSON.stringify({ schema: "runtime-dispatch-stream/v1", kind: "process_started", pid: process.pid })}\n`,
  );
  return dispatchId;
}
