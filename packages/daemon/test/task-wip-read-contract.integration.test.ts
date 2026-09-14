// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ActorIdentity } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const actor: ActorIdentity = { principal: { personId: "person-wip" }, executor: null } as const;
type Cell = Awaited<ReturnType<typeof openRepoCell>>;

test("the served WIP snapshot passes the same protocol validator the GUI client uses, root or no root", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-wip-contract-"));
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-wip-contract"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-wip-contract",
      now: () => "2026-09-14T00:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    // Contrast 1 — no root: a leaf-only worktable serves a snapshot that validates.
    await createReadyTask(cell, rootDir, "task_LEAF", "Leaf work");
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_LEAF", executionId: "exe_leaf" }, binding)).outcome,
      "applied",
    );
    const noRoots = await cell.read("repo.tasks.wip");
    assert.deepEqual(noRoots.roots, []);
    assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.wip", noRoots), noRoots);
    // A declared root (milestone container) and a derived root (three children, never executed).
    await createReadyTask(cell, rootDir, "task_MILESTONE", "Milestone container", { taskClass: "milestone" });
    assert.equal(
      (
        await cell.run(
          { kind: "task-transition", taskId: "task_MILESTONE", status: "blocked", reason: "Parking the container" },
          binding,
        )
      ).outcome,
      "applied",
    );
    await createReadyTask(cell, rootDir, "task_DERIVED", "Derived container");
    for (let index = 0; index < 3; index++)
      await createReadyTask(cell, rootDir, `task_DERIVED_CHILD_${index}`, `Child ${index}`, {
        parentTaskId: "task_DERIVED",
      });
    assert.equal(
      (
        await cell.run(
          { kind: "task-transition", taskId: "task_DERIVED", status: "blocked", reason: "Parking the container" },
          binding,
        )
      ).outcome,
      "applied",
    );
    // Contrast 2 — legit roots: the producer's four-field root rows validate through the same
    // parser. This is the row the old exact-key-count check rejected as invalid_result. The
    // projection serves status groups in taskId order, so the rows are compared sorted.
    const withRoots = await cell.read("repo.tasks.wip");
    assert.deepEqual(
      [...withRoots.roots].sort((left, right) => left.taskId.localeCompare(right.taskId)),
      [
        { taskId: "task_DERIVED", reason: "derived", directChildCount: 3, threshold: 3 },
        { taskId: "task_MILESTONE", reason: "declared", directChildCount: 0, threshold: 3 },
      ],
    );
    assert.deepEqual(parseDaemonGuiReadResult("repo.tasks.wip", withRoots), withRoots);
    // Contrast 3 — undeclared field: a root row carrying anything beyond the declared fields is
    // refused. The old length-only check accepted exactly this row (five keys, four checked).
    const drifted = { ...withRoots, roots: [{ ...withRoots.roots[0]!, undeclared: true }] };
    assert.throws(() => parseDaemonGuiReadResult("repo.tasks.wip", drifted), /must be a valid task WIP snapshot/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function createReadyTask(
  cell: Cell,
  rootDir: string,
  taskId: string,
  title: string,
  options: { readonly taskClass?: "milestone" | "long_running"; readonly parentTaskId?: string } = {},
): Promise<void> {
  const binding = { actor, source: "local" as const };
  await createRealizedTaskPlanFixture(
    rootDir,
    async () => {
      const created = await cell.run({ kind: "task-create", taskId, title, ...options }, binding);
      await waitForFixturePublication(cell, created.opId, binding);
      return created;
    },
    (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    title,
  );
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Task WIP Test");
  git(rootDir, "config", "user.email", "task-wip@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
