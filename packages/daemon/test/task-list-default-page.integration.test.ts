// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { actor, evidence, initRepo } from "./task-surface.fixtures.ts";

test("task list defaults to 50 rows and exposes a continuation cursor", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-list-default-page-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-list-default-page"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-list-default-page",
      now: () => "2026-08-15T03:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    for (let index = 0; index < 51; index += 1)
      assert.equal(
        (
          await cell.run(
            { kind: "task-create", taskId: `task_${String(index).padStart(2, "0")}`, title: `Task ${index}` },
            binding,
          )
        ).outcome,
        "applied",
      );
    const listed = evidence(await cell.run({ kind: "task-list" }, binding));
    assert.equal(listed.rows.length, 50);
    assert.equal(listed.page.limit, 50);
    assert.equal(typeof listed.page.nextCursor, "string");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("completed work presentation agrees across reads while transitions retain raw planned state", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-work-presentation-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-work-presentation"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-work-presentation",
      now: () => "2026-09-30T03:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    for (const [taskId, parentTaskId] of [
      ["task_a_root", null],
      ["task_b_leaf", "task_a_root"],
      ["task_c_open", null],
    ]) {
      assert.equal(
        (
          await cell.run(
            { kind: "task-create", taskId, title: taskId, ...(parentTaskId ? { parentTaskId } : {}) },
            binding,
          )
        ).outcome,
        "applied",
      );
    }
    assert.equal(
      (
        await cell.run(
          { kind: "task-transition", taskId: "task_b_leaf", status: "cancelled", reason: "Scope retired" },
          binding,
        )
      ).outcome,
      "applied",
    );
    const show = evidence(await cell.run({ kind: "task-show", taskId: "task_a_root" }, binding));
    const works = evidence(await cell.run({ kind: "work-list", all: true }, binding));
    const work = evidence(await cell.run({ kind: "work-show", taskId: "task_a_root" }, binding));
    assert.equal(show.task.status, "cancelled");
    assert.equal(works.rows.find((row) => row.taskId === "task_a_root").status, show.task.status);
    assert.equal(work.root.status, show.task.status);
    const planned = evidence(await cell.run({ kind: "task-list", status: "planned", limit: 1 }, binding));
    assert.deepEqual(
      planned.rows.map((row) => row.taskId),
      ["task_c_open"],
    );
    assert.equal(planned.page.nextCursor, null);
    const gui = await cell.read("repo.tasks.list");
    assert.equal(gui.rows.find((row) => row.taskId === "task_a_root")!.snapshot.task!.status, show.task.status);
    const agenda = await cell.read("repo.agenda.read");
    assert.equal(
      agenda.dispatchable.some((row) => row.taskId === "task_a_root"),
      false,
    );
    // The writer still cancels the raw planned root, even though presentation already says cancelled.
    const transition = await cell.run(
      { kind: "task-transition", taskId: "task_a_root", status: "cancelled", reason: "Retire the root itself" },
      binding,
    );
    assert.equal(transition.outcome, "applied", JSON.stringify(transition));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
