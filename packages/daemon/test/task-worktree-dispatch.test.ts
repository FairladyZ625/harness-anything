// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { TaskV2, TaskWorktreeBindingV1 } from "@harness-anything/kernel";
import { prepareDispatchWorktree } from "../src/runtime-resume-admission.ts";
import { prepareTaskStartWorktree, taskWorkspaceView } from "../src/task-worktree.ts";
import { noWorktreeSetup } from "../src/worktree-setup.ts";

// Issue #4431: a dispatch of a task that was never started must be refused when there is no default-branch commit
// to cut its worktree from. A null checkout used to mean both "this node cannot make a worktree" and "no worktree
// was requested", so the dispatch resolver fell back to the repository root and the worker committed on main. An
// explicit start is the first-use decision point and keeps reporting "no workspace here"; a later dispatch follows
// that recorded start instead of re-deciding it at provider launch.

const taskId = "task_12345678",
  binding: TaskWorktreeBindingV1 = { branch: taskId, path: `.worktrees/${taskId}` },
  repositoryDiff = () => ({ profile: { outputShape: "repository-diff" } });

test("a task-bound dispatch refuses an unborn repository before launch instead of running at its root", async (t) => {
  const { root } = unbornRepository(t),
    task = boundTask("active"),
    before = readdirSync(root).sort();
  await assert.rejects(
    prepareDispatchWorktree({ rootDir: root }, { taskId, prompt: "implement the task" }, () => binding),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "worktree_base_unavailable");
      assert.match(error.message, new RegExp(`Task ${taskId}'s worktree \\.worktrees/${taskId}`, "u"));
      assert.match(error.message, /has no default-branch commit to cut it from/u);
      return true;
    },
  );
  // The refused dispatch creates no checkout and changes nothing at the repository root.
  assert.equal(existsSync(path.join(root, binding.path)), false);
  assert.deepEqual(readdirSync(root).sort(), before);
  // The task readback names the binding but must never report it as materialized: the state is the declared
  // "bound", not a claim that the missing directory exists.
  assert.deepEqual(taskWorkspaceView(root, task, "tasks/x", repositoryDiff, null), {
    kind: "worktree",
    ...binding,
    state: "bound",
  });
});

test("after the first commit the same dispatch materializes the binding and never uses the repository root", async (t) => {
  const { root } = unbornRepository(t);
  git(root, "commit", "--allow-empty", "-qm", "first");
  const checkout = await prepareDispatchWorktree({ rootDir: root }, { taskId }, () => binding);
  assert.ok(checkout, "a repository with a default-branch commit must give a checkout");
  assert.notEqual(checkout.cwd, root);
  assert.equal(checkout.cwd, path.join(root, binding.path));
  assert.equal(checkout.branch, taskId);
  assert.equal(checkout.baseRef, "main");
  assert.equal(git(checkout.cwd, "rev-parse", "HEAD"), git(root, "rev-parse", "main"));
  assert.equal(taskWorkspaceView(root, boundTask("active"), "tasks/x", repositoryDiff, null)?.state, "materialized");
});

test("a Git-less edge keeps the no-workspace answer instead of a missing-base failure", async (t) => {
  // dec_BBA713052997C3EF5F5D3DD952 CH3: an edge without Git records no workspace rather than failing.
  const root = mkdtempSync(path.join(tmpdir(), "ha-task-worktree-dispatch-gitless-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(await prepareDispatchWorktree({ rootDir: root }, { taskId }, () => binding), null);
});

test("a start of a task-bound task reports the unborn repository instead of failing the lifecycle write", async (t) => {
  const { root } = unbornRepository(t),
    annotate = await prepareTaskStartWorktree(
      {
        rootDir: root,
        readTask: () => boundTask("planned"),
        readPresetSnapshot: repositoryDiff,
        readWorktree: noWorktreeSetup,
      },
      { kind: "task-start", taskId },
      "local",
    );
  assert.ok(annotate, "a task-bound start must still produce its receipt annotation");
  const started = annotate({ outcome: "applied", opId: "op-start" });
  assert.match(String((started as { summary?: unknown }).summary), /has no default-branch commit/u);
  assert.equal(existsSync(path.join(root, binding.path)), false);
});

test("a dispatch after an explicit start keeps the workspace that start recorded", async (t) => {
  const { root } = unbornRepository(t),
    projection = () => ({
      read: () => ({
        status: "ready",
        snapshot: { task: boundTask("active"), executions: [{ executionId: "exe-started" }] },
      }),
    });
  const checkout = await prepareDispatchWorktree(
    { rootDir: root, projection: projection as never },
    { taskId },
    () => binding,
  );
  // The start already answered "no worktree on this node"; the dispatch must not silently change that decision.
  assert.equal(checkout, null);
  assert.equal(existsSync(path.join(root, binding.path)), false);
});

function unbornRepository(t: TestContext): { readonly base: string; readonly root: string } {
  const base = mkdtempSync(path.join(tmpdir(), "ha-task-worktree-dispatch-unborn-")),
    root = path.join(base, "canonical");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(root);
  git(base, "init", "-q", "-b", "main", root);
  git(root, "config", "user.name", "Worktree Dispatch Test");
  git(root, "config", "user.email", "worktree-dispatch@example.invalid");
  return { base, root };
}

/** The task whose binding the dispatcher resolves: a repository-diff standard task, still open. */
function boundTask(status: TaskV2["status"]): TaskV2 {
  return {
    schema: "task/v2",
    taskId,
    title: "dispatch worktree",
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
      slug: "dispatch-worktree",
      surfaces: [],
      fromLegacyId: null,
    },
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
