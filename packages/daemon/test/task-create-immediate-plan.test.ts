// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo, write } from "./doc-sync-slice-a.fixtures.ts";

test("create then immediately replace and submit a plan five times", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-immediate-"));
  initRepo(rootDir);
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("create-immediate"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "create-immediate",
  });
  const binding = { actor, source: "local" as const };
  try {
    for (let index = 0; index < 5; index += 1) {
      const taskId = `task-immediate-${index}`;
      const created = await cell.run({ kind: "task-create", taskId, title: "Immediate" }, binding);
      assert.equal(created.outcome, "applied");
      const packagePath = (created as typeof created & { packagePath: string }).packagePath;
      const target = path.join(rootDir, "harness", packagePath);
      const visible = existsSync(path.join(target, "task_plan.md"));
      assert.equal(visible, true, "create must materialize the plan before returning");
      assert.equal(created.proof?.worktreeVisible, true);
      assert.match(readFileSync(path.join(target, "task_plan.md"), "utf8"), /Immediate/u);
      write(rootDir, `${packagePath}/task_plan.md`, "# Replaced title\n\nEntirely authored replacement.\n");
      const submitted = await cell.run({ kind: "doc-submit", taskId }, binding);
      await cell.settlePendingMaterialization("verify immediate plan replacement");
      const scratches = readdirSync(target).filter((name) => name.includes(".conflict-"));
      console.log(JSON.stringify({ index, visible, outcome: submitted.outcome, scratches }));
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      assert.deepEqual(scratches, []);
      const shown = await cell.run({ kind: "doc-show", path: `${packagePath}/task_plan.md` }, binding);
      assert.match(shown.evidence ?? "", /Entirely authored replacement/u);
      assert.equal(
        readFileSync(path.join(target, "task_plan.md"), "utf8"),
        "# Replaced title\n\nEntirely authored replacement.\n",
      );
    }
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("create reports pending materialization when a concurrent edit prevents settlement", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-conflict-"));
  initRepo(rootDir);
  const logical = "tasks/task-concurrent-concurrent/task_plan.md";
  let inject = false;
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("create-concurrent"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "create-concurrent",
    killpoint: (point) => {
      if (inject && point === "after_git_ref_update") {
        inject = false;
        write(rootDir, logical, "# Concurrent draft\n");
      }
    },
  });
  const binding = { actor, source: "local" as const };
  try {
    const preview = await cell.run(
      { kind: "task-create", taskId: "task-concurrent", title: "Concurrent", dryRun: true },
      binding,
    );
    assert.equal(preview.proof?.durable ?? false, false);
    assert.equal(existsSync(path.join(rootDir, "harness", logical)), false);
    inject = true;
    const created = await cell.run({ kind: "task-create", taskId: "task-concurrent", title: "Concurrent" }, binding);
    assert.equal(created.outcome, "pending");
    assert.equal(created.proof?.durable, true);
    assert.equal(created.proof?.worktreeVisible, false);
    assert.match(created.summary ?? "", /materialization is pending/u);
    assert.ok(created.summary?.includes(`ha receipt show ${created.opId} --wait worktree_visible`));
    assert.equal(readFileSync(path.join(rootDir, "harness", logical), "utf8"), "# Concurrent draft\n");
    const receipt = await cell.run(
      { kind: "receipt-show", opId: created.opId, waitFor: ["worktree_visible"], timeoutMs: 0 },
      binding,
    );
    assert.equal(receipt.wait?.state, "timed_out");
    assert.equal(receipt.proof?.worktreeVisible, false);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
