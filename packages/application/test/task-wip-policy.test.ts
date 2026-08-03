// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  enteringExecutionWip,
  taskWipPublicationRevalidation,
  type TaskWipSnapshotV1
} from "../src/authority/task-wip-policy.ts";

test("activation succeeds while an execution slot remains", async () => {
  const revalidate = taskWipPublicationRevalidation(async () => ({
    limit: 2,
    tasks: [
      task("task_ACTIVE", "Active task", "active", "active"),
      task("task_IDEA", "Idea task", "planned", "active")
    ]
  }), "task_NEW");

  await assert.doesNotReject(revalidate);
});

test("exactly-full activation names a task to return and the command to retry", async () => {
  const revalidate = taskWipPublicationRevalidation(async () => ({
    limit: 2,
    tasks: [
      task("task_ACTIVE", "Active task", "active", "active"),
      task("task_BLOCKED", "Blocked task", "blocked", "active")
    ]
  }), "task_NEW");

  await assert.rejects(revalidate, (error: Error) =>
    /TASK_WIP_LIMIT_REACHED/u.test(error.message)
    && /2\/2/u.test(error.message)
    && /settings\.tasks\.wipLimit=2/u.test(error.message)
    && /ha task transition task_BLOCKED planned/u.test(error.message)
    && /ha task transition task_NEW active/u.test(error.message));
});

test("over-limit reporting excludes planned ideas and archived packages", async () => {
  const plannedIdeas = Array.from({ length: 100 }, (_, index) =>
    task(`task_IDEA_${index}`, `Idea ${index}`, "planned", "active"));
  const revalidate = taskWipPublicationRevalidation(async () => ({
    limit: 1,
    tasks: [
      ...plannedIdeas,
      task("task_ACTIVE", "Active task", "active", "active"),
      task("task_REVIEW", "Review task", "in_review", "active"),
      task("task_ARCHIVED", "Archived task", "active", "archived")
    ]
  }), "task_NEW");

  await assert.rejects(revalidate, (error: Error) =>
    /2\/1/u.test(error.message)
    && /task_ACTIVE/u.test(error.message)
    && /task_REVIEW/u.test(error.message)
    && !/task_IDEA_/u.test(error.message)
    && !/task_ARCHIVED/u.test(error.message)
    && /Planned tasks remain in the idea inbox and are not counted or removed/u.test(error.message));
});

test("container tasks with children do not occupy execution workstations", async () => {
  const revalidate = taskWipPublicationRevalidation(async () => ({
    limit: 2,
    tasks: [
      task("task_ROOT_A", "Milestone root", "active", "active", true),
      task("task_ROOT_B", "Operations ledger", "active", "active", true),
      task("task_LEAF", "Executable leaf", "active", "active")
    ]
  }), "task_NEW");

  await assert.doesNotReject(revalidate);
});

test("closeout backfill with delivery evidence does not consume a WIP slot", async () => {
  const revalidate = taskWipPublicationRevalidation(async () => ({
    limit: 1,
    tasks: [
      task("task_ACTIVE", "Active task", "active", "active"),
      { ...task("task_BACKFILL", "Delivered backfill", "planned", "active"), hasCloseoutEvidence: true }
    ]
  }), "task_BACKFILL");

  await assert.doesNotReject(revalidate);
});

test("planned work without delivery evidence still consumes a WIP slot", async () => {
  const revalidate = taskWipPublicationRevalidation(async () => ({
    limit: 1,
    tasks: [
      task("task_ACTIVE", "Active task", "active", "active"),
      task("task_NEW", "New work", "planned", "active")
    ]
  }), "task_NEW");

  await assert.rejects(revalidate, /TASK_WIP_LIMIT_REACHED/u);
});

test("activating a container is admitted even when every leaf workstation is occupied", async () => {
  const revalidate = taskWipPublicationRevalidation(async () => ({
    limit: 1,
    tasks: [
      task("task_LEAF", "Executable leaf", "active", "active"),
      task("task_NEW_ROOT", "New milestone root", "planned", "active", true)
    ]
  }), "task_NEW_ROOT");

  await assert.doesNotReject(revalidate);
});

test("publication revalidation observes a changed configured limit", async () => {
  let limit = 2;
  const snapshot = (): Promise<TaskWipSnapshotV1> => Promise.resolve({
    limit,
    tasks: [task("task_ACTIVE", "Active task", "active", "active")]
  });
  const revalidate = taskWipPublicationRevalidation(snapshot, "task_NEW");

  await assert.doesNotReject(revalidate);
  limit = 1;
  await assert.rejects(revalidate, /1\/1/u);
});

test("only entry to the execution world consumes a slot", () => {
  assert.equal(enteringExecutionWip("planned", "active", "active", "active"), true);
  assert.equal(enteringExecutionWip("planned", "active", "blocked", "active"), true);
  assert.equal(enteringExecutionWip("planned", "active", "planned", "active"), false);
  assert.equal(enteringExecutionWip("active", "active", "planned", "active"), false);
  assert.equal(enteringExecutionWip("active", "archived", "active", "active"), true);
});

function task(
  taskId: string,
  title: string,
  status: TaskWipSnapshotV1["tasks"][number]["status"],
  packageDisposition: TaskWipSnapshotV1["tasks"][number]["packageDisposition"],
  isContainer = false
): TaskWipSnapshotV1["tasks"][number] {
  return { taskId, title, status, packageDisposition, isContainer };
}
