// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TaskV2 } from "@harness-anything/kernel";
import { dispatchStreamPath, openDispatchStream } from "../src/dispatch-stream.ts";
import { renameLegacyTaskWorktrees } from "../src/task-worktree-legacy-rename.ts";
import { checkoutTaskWorktree } from "../src/task-worktree.ts";

const repositoryDiff = () => ({ profile: { outputShape: "repository-diff" } });

test("migrate renames an old-name worktree and its branch to the task id, and the task starts there", async () => {
  const fixture = repositoryFixture();
  try {
    const task = legacyTask("task_0a1b2c3d4e5f60718293a4b5c6"),
      legacy = path.join(fixture.root, ".worktrees", "renamed-0a1b2c3d");
    git(fixture.root, "worktree", "add", "-q", "-b", "codex/renamed-0a1b2c3d", legacy, "main");
    commit(legacy, "work.txt");
    const head = git(legacy, "rev-parse", "HEAD");

    assert.deepEqual(renameLegacyTaskWorktrees(fixture.root, [task], repositoryDiff, false), [
      { taskId: task.taskId, status: "worktree-rename", from: legacy },
    ]);
    assert.equal(existsSync(legacy), true, "a dry run moves nothing");

    assert.deepEqual(renameLegacyTaskWorktrees(fixture.root, [task], repositoryDiff, true), [
      { taskId: task.taskId, status: "worktree-renamed", from: legacy },
    ]);
    const renamed = path.join(fixture.root, ".worktrees", task.taskId);
    assert.equal(existsSync(legacy), false);
    assert.equal(git(renamed, "branch", "--show-current"), task.taskId);
    assert.equal(git(renamed, "rev-parse", "HEAD"), head);
    assert.equal(git(fixture.root, "branch", "--list", "codex/renamed-0a1b2c3d"), "");
    // The next start finds the renamed checkout in place.
    const checkout = await checkoutTaskWorktree(
      fixture.root,
      task.taskId,
      { branch: task.taskId, path: `.worktrees/${task.taskId}` },
      [],
    );
    assert.deepEqual(checkout, { cwd: renamed, branch: task.taskId, baseRef: null, setup: { ok: true, ran: [] } });
    // Nothing is left to rename.
    assert.deepEqual(renameLegacyTaskWorktrees(fixture.root, [task], repositoryDiff, true), []);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("migrate leaves an old-name worktree with uncommitted work or a live worker in place and says why", () => {
  const fixture = repositoryFixture();
  try {
    const dirty = legacyTask("task_1111111122222222333333334a", "dirty"),
      busy = legacyTask("task_5555555566666666777777778b", "busy"),
      dirtyTree = path.join(fixture.root, ".worktrees", "dirty-11111111"),
      busyTree = path.join(fixture.root, ".worktrees", "busy-55555555");
    git(fixture.root, "worktree", "add", "-q", "-b", "codex/dirty-11111111", dirtyTree, "main");
    writeFileSync(path.join(dirtyTree, "draft.txt"), "draft\n");
    git(fixture.root, "worktree", "add", "-q", "-b", "codex/busy-55555555", busyTree, "main");
    liveDispatch(fixture.root, busyTree);

    assert.deepEqual(renameLegacyTaskWorktrees(fixture.root, [dirty, busy], repositoryDiff, true), [
      { taskId: dirty.taskId, status: "manual", reason: "worktree_uncommitted_changes", worktree: dirtyTree },
      { taskId: busy.taskId, status: "manual", reason: "worktree_in_use_by_live_dispatch", worktree: busyTree },
    ]);
    assert.equal(existsSync(dirtyTree), true);
    assert.equal(existsSync(busyTree), true);
    assert.equal(git(busyTree, "branch", "--show-current"), "codex/busy-55555555");
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

/** A dispatch whose worker (this test process) is running with its cwd inside the worktree. */
function liveDispatch(rootDir: string, cwd: string): void {
  const dispatchId = "dispatch_0123456789abcdef01234567";
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId: "runtime_legacy_rename",
    instanceId: "instance-1",
    startedAt: "2026-09-28T00:00:00.000Z",
    dispatchOpId: "legacy-rename-op",
    kindId: "codex",
    permissionMode: null,
    binding: { actor: { principal: { personId: "person-1" }, executor: null }, source: "local" },
    cwd,
    prompt: "work in the old worktree",
    model: "gpt-5.6-sol",
    reasoningEffort: null,
    fast: false,
  } as Parameters<typeof openDispatchStream>[1]);
  appendFileSync(
    dispatchStreamPath(rootDir, dispatchId),
    `${JSON.stringify({ schema: "runtime-dispatch-stream/v1", kind: "process_started", pid: process.pid })}\n`,
  );
}

function legacyTask(taskId: string, slug = "renamed"): TaskV2 {
  return {
    schema: "task/v2",
    taskId,
    title: "旧名迁移",
    taskClass: "standard",
    status: "active",
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
      slug,
      surfaces: [],
      fromLegacyId: null,
    },
  };
}

function commit(cwd: string, file: string): void {
  writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", file);
}

function repositoryFixture(): { readonly base: string; readonly root: string } {
  const base = mkdtempSync(path.join(tmpdir(), "ha-legacy-worktree-")),
    root = path.join(base, "canonical");
  git(base, "init", "-q", "-b", "main", root);
  git(root, "config", "user.name", "Legacy Test");
  git(root, "config", "user.email", "legacy@example.invalid");
  writeFileSync(path.join(root, ".gitignore"), ".worktrees\n.harness\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "base");
  return { base, root };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
