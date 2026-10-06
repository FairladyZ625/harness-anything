// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { TaskWorktreeBindingV1 } from "@harness-anything/kernel";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";
import { pushWorkerBranch } from "../src/runtime-worker-push.ts";
import type { RuntimeSpawnerInput } from "../src/runtime-spawn-types.ts";
import { makeRuntimeSpawner } from "../src/runtime-spawner.ts";
import { checkoutTaskWorktree } from "../src/task-worktree.ts";

// dec_57370FF2021DADF04E3B21724D: an edge node holds no ledger, so the center delivers the task's worktree binding
// (CH1), the edge dispatch works in that worktree (CH2), and a node that takes a task over continues the branch the
// previous node pushed (CH3). Two clones of one bare remote stand for two nodes; each holds its mirrored ledger.

const taskId = "task_e0000000000000000000beef",
  binding: TaskWorktreeBindingV1 = { branch: taskId, path: `.worktrees/${taskId}` },
  packagePath = path.join("harness", "tasks", taskId),
  edgeBinding = {
    actor: { principal: { personId: "fleet-edge" }, executor: null },
    source: { kind: "node" as const, nodeId: "node-a" },
  };

test("an edge dispatch without a cwd launches in the worktree the center's binding names", async (t) => {
  const fixture = nodesFixture(t),
    edge = edgeSpawner(fixture.nodeA, binding);
  await assert.rejects(
    edge.spawn({ taskId, runtimeInstanceId: "edge-instance", idempotencyKey: "edge-worker" }),
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
    other.spawn({ taskId: otherId, runtimeInstanceId: "edge-instance", idempotencyKey: "edge-other" }),
    launched,
  );
  assert.deepEqual(other.launchedIn, [path.join(fixture.nodeA, ".worktrees", otherId)]);
  assert.equal(git(cwd, "branch", "--show-current"), taskId);
});

test("an edge dispatch that is not an implementation run stays in the node's main checkout", async (t) => {
  const fixture = nodesFixture(t),
    cases: readonly {
      readonly name: string;
      readonly payload: JsonObject;
      readonly worktree?: TaskWorktreeBindingV1 | null;
    }[] = [
      { name: "a reviewer", payload: { role: "reviewer", executionId: "execution-a" } },
      { name: "a requested cwd", payload: { cwd: { scope: "repo-root" } } },
      { name: "a task the center binds no worktree to", payload: {}, worktree: null },
    ];
  for (const [index, scenario] of cases.entries()) {
    const edge = edgeSpawner(fixture.nodeA, scenario.worktree === undefined ? binding : scenario.worktree);
    await assert.rejects(
      edge.spawn({
        taskId,
        runtimeInstanceId: "edge-instance",
        idempotencyKey: `edge-root-${index}`,
        ...scenario.payload,
      }),
      launched,
      scenario.name,
    );
    assert.deepEqual(edge.launchedIn, [fixture.nodeA], scenario.name);
    assert.match(edge.prompts[0]!, new RegExp(`Task package root: ${path.join(fixture.nodeA, packagePath)}\n`, "u"));
    assert.equal(existsSync(path.join(fixture.nodeA, ".worktrees")), false, scenario.name);
  }
  // A dry-run preview assembles the prompt and checks nothing out.
  const preview = edgeSpawner(fixture.nodeA, binding),
    previewed = await preview.spawn({
      taskId,
      runtimeInstanceId: "edge-instance",
      idempotencyKey: "edge-preview",
      dryRun: true,
    });
  assert.equal(previewed.schema, "agent-dispatch-preview/v1");
  assert.equal(existsSync(path.join(fixture.nodeA, ".worktrees")), false);
});

test("a Git-less edge has no worktree to give and works in its workspace root", async (t) => {
  const gitless = mkdtempSync(path.join(tmpdir(), "ha-edge-worktree-gitless-"));
  t.after(() => rmSync(gitless, { recursive: true, force: true }));
  const edge = edgeSpawner(gitless, binding);
  await assert.rejects(
    edge.spawn({ taskId, runtimeInstanceId: "edge-instance", idempotencyKey: "edge-gitless" }),
    launched,
  );
  assert.deepEqual(edge.launchedIn, [gitless]);
  assert.equal(existsSync(path.join(gitless, ".worktrees")), false);
});

test("a node that takes a task over continues from the branch the previous node pushed", async (t) => {
  const fixture = nodesFixture(t),
    first = (await checkoutTaskWorktree(fixture.nodeA, taskId, binding, []))!;
  assert.equal(first.baseRef, "origin/main");
  const delivered = commit(first.cwd, "node-a.txt");
  assert.deepEqual(await pushWorkerBranch({ cwd: first.cwd, canonicalRoot: fixture.nodeA, taskId }), {
    attempted: true,
    ok: true,
    branch: taskId,
    head: delivered,
    pushedCommit: delivered,
  });

  const second = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, []))!;
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
    onA = (await checkoutTaskWorktree(fixture.nodeA, taskId, binding, []))!,
    onB = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, []))!,
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
    idle = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, []))!,
    onA = (await checkoutTaskWorktree(fixture.nodeA, taskId, binding, []))!,
    delivered = commit(onA.cwd, "node-a.txt");
  assert.equal((await pushWorkerBranch({ cwd: onA.cwd, canonicalRoot: fixture.nodeA, taskId })).attempted, true);
  assert.equal(git(idle.cwd, "rev-parse", "HEAD"), git(fixture.nodeB, "rev-parse", "origin/main"));

  const resumed = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, []))!;
  assert.equal(resumed.cwd, idle.cwd);
  assert.equal(resumed.baseRef, null, "the checkout was already here");
  assert.equal(git(resumed.cwd, "rev-parse", "HEAD"), delivered, "the idle checkout is brought up to the push");
  const continued = commit(resumed.cwd, "node-b.txt"),
    pushed = await pushWorkerBranch({ cwd: resumed.cwd, canonicalRoot: fixture.nodeB, taskId });
  assert.equal(pushed.attempted && pushed.ok, true, JSON.stringify(pushed));
  assert.equal(git(fixture.remote, "rev-parse", `refs/heads/${taskId}`), continued);
  assert.equal(git(fixture.remote, "merge-base", "--is-ancestor", delivered, continued), "");
  // The node that pushed last is not behind: its next checkout fetches and changes nothing.
  await checkoutTaskWorktree(fixture.nodeB, taskId, binding, []);
  assert.equal(git(resumed.cwd, "rev-parse", "HEAD"), continued);
});

test("an idle checkout a refused dispatch cut is advanced to the present default branch on retry", async (t) => {
  const fixture = nodesFixture(t),
    // The refused dispatch's checkout: cut from the default branch before the prerequisite landed on it.
    idle = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, []))!,
    stale = git(idle.cwd, "rev-parse", "HEAD");
  // The prerequisite merges and this node's view of the default branch moves with it.
  const merged = commit(fixture.nodeA, "prerequisite.txt");
  git(fixture.nodeA, "push", "-q", "origin", "main");
  git(fixture.nodeB, "fetch", "-q", "origin", "main");

  const retry = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, []))!;
  assert.equal(retry.cwd, idle.cwd);
  assert.equal(retry.baseRef, null, "the checkout was already here");
  assert.equal(git(retry.cwd, "rev-parse", "HEAD"), merged, "the idle checkout starts the retry on current main");
  assert.equal(git(retry.cwd, "merge-base", "--is-ancestor", stale, merged), "", "the advance is a fast-forward");
});

test("an advancing default branch leaves a checkout that holds work of its own exactly where it is", async (t) => {
  for (const scenario of ["a commit of its own", "an uncommitted change"] as const) {
    const fixture = nodesFixture(t),
      checkout = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, []))!;
    if (scenario === "a commit of its own") commit(checkout.cwd, "node-b.txt");
    else writeFileSync(path.join(checkout.cwd, "src", "index.txt"), "edited on node b\n");
    commit(fixture.nodeA, "prerequisite.txt");
    git(fixture.nodeA, "push", "-q", "origin", "main");
    git(fixture.nodeB, "fetch", "-q", "origin", "main");
    const head = git(checkout.cwd, "rev-parse", "HEAD"),
      status = git(checkout.cwd, "status", "--porcelain");

    await checkoutTaskWorktree(fixture.nodeB, taskId, binding, []);
    assert.equal(git(checkout.cwd, "rev-parse", "HEAD"), head, scenario);
    assert.equal(git(checkout.cwd, "status", "--porcelain"), status, scenario);
  }
});

test("a checkout behind the published branch that holds work of its own is refused and left untouched", async (t) => {
  for (const scenario of ["a commit of its own", "an uncommitted change"] as const) {
    const fixture = nodesFixture(t),
      onB = (await checkoutTaskWorktree(fixture.nodeB, taskId, binding, []))!,
      onA = (await checkoutTaskWorktree(fixture.nodeA, taskId, binding, []))!;
    commit(onA.cwd, "node-a.txt");
    assert.equal((await pushWorkerBranch({ cwd: onA.cwd, canonicalRoot: fixture.nodeA, taskId })).attempted, true);
    if (scenario === "a commit of its own") commit(onB.cwd, "node-b.txt");
    else writeFileSync(path.join(onB.cwd, "src", "index.txt"), "edited on node b\n");
    const head = git(onB.cwd, "rev-parse", "HEAD"),
      status = git(onB.cwd, "status", "--porcelain");

    await assert.rejects(
      checkoutTaskWorktree(fixture.nodeB, taskId, binding, []),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === "task_worktree_diverged" &&
        error.message.includes(onB.cwd) &&
        error.message.includes(`origin/${taskId}`),
      scenario,
    );
    assert.equal(git(onB.cwd, "rev-parse", "HEAD"), head, scenario);
    assert.equal(git(onB.cwd, "status", "--porcelain"), status, scenario);
  }
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
      readSettings: () => ({ worktree: { setup: [] } }) as never,
      runtimeInstances: () => [],
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
