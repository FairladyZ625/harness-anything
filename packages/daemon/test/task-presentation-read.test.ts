// harness-test-tier: fast
import test from "node:test";
import { presentationQueryFixture } from "../../kernel/test/store/presentation-query.fixture.ts";
import assert from "node:assert/strict";
import { type TaskProjection, type TaskProjectionListQuery, allowsTaskStatusMove } from "@harness-anything/kernel";
import { listTasks, type TaskQueryCell } from "../src/repo-cell-task-query.ts";
import { taskPresentationReads } from "../src/task-presentation-read.ts";
import { workListFromProjection } from "../src/work-read.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";

export function presentationFixture() {
  const snapshot = lifecycleFixture().snapshot;
  const rows = [
    { taskId: "a-root", status: "planned", parentTaskId: null, taskClass: "work" },
    { taskId: "b-leaf", status: "done", parentTaskId: "a-root", taskClass: "standard" },
    { taskId: "c-open", status: "planned", parentTaskId: null, taskClass: "standard" },
  ].map((row) => ({
    ...row,
    title: row.taskId,
    pinned: false,
    updatedAt: "2026-09-30T00:00:00.000Z",
    packageDisposition: "active",
    packagePath: null,
    workKind: null,
    riskTier: null,
    urgency: null,
  }));
  const { db, readIndex, readStatus } = presentationQueryFixture(snapshot, rows);
  const cut = { status: "ready", watermark: 7, sourceRevision: 7, warnings: [] };
  const projection = {
    readTaskIndex: (query: TaskProjectionListQuery = {}) => ({ ...cut, ...readIndex(query) }),
    read: (id: string, presentationStatus = false) => ({
      ...cut,
      packagePath: null,
      snapshot: {
        ...snapshot,
        task: {
          ...snapshot.task,
          ...rows.find((row) => row.taskId === id),
          ...(presentationStatus ? { status: readStatus(id) } : {}),
          metadata: { parentTaskId: rows.find((row) => row.taskId === id)?.parentTaskId ?? null },
        },
      },
    }),
    list: (query: TaskProjectionListQuery = {}) => {
      const index = projection.readTaskIndex(query);
      return {
        ...index,
        rows: index.rows.map((row) => ({
          ...row,
          snapshot: projection.read(row.taskId, query.presentationStatus).snapshot,
          workspaceRevision: 7,
        })),
        ...(index.page ? { page: index.page } : {}),
      };
    },
    readProgress: () => ({ ...cut, rows: [] }),
    readTaskChildCounts: () => ({ "a-root": 1 }),
    getEntity: () => null,
    readDocument: () => ({ document: null }),
    readPresetSnapshot: () => ({ snapshot: null }),
    readTaskCompletionContract: () => ({ ...cut, contract: null }),
  } as unknown as TaskProjection;
  return { projection, rows, db };
}

function taskList(projection: TaskProjection, status: "planned" | "done", limit = 1, cursor?: string) {
  const cell = {
    projection,
    taskListQueryFromAction: () => ({ status, limit, ...(cursor ? { cursor } : {}) }),
    readResult: (_id: string, payload: object) => payload,
    operationId: () => "read",
    input: { repoId: "repo" },
  } as unknown as TaskQueryCell;
  return listTasks(cell, { kind: "task-list" } as never, {} as never) as unknown as {
    rows: { taskId: string; status: string }[];
    page: { nextCursor: string | null };
  };
}

test("task list filters the work root's presented status before paging, leaving lifecycle state intact", () => {
  const { projection, db } = presentationFixture();
  test.after(() => db.close());
  const work = workListFromProjection(projection, { all: true }).rows[0]!;
  const planned = taskList(projection, "planned");
  assert.deepEqual(
    planned.rows.map(({ taskId }) => taskId),
    ["c-open"],
  );
  assert.equal(planned.page.nextCursor, null);
  const done = taskList(projection, "done");
  assert.equal(done.rows[0]!.taskId, work.taskId);
  assert.equal(done.rows[0]!.status, work.status);
  const last = taskList(projection, "done", 1, done.page.nextCursor!);
  assert.deepEqual(
    last.rows.map(({ taskId }) => taskId),
    ["b-leaf"],
  );
  assert.equal(last.page.nextCursor, null);
  assert.equal(projection.read("a-root").snapshot.task!.status, "planned");
  assert.equal(allowsTaskStatusMove(projection.read("a-root").snapshot, "active"), true);
});

test("presentation snapshots page on derived status and never mutate the raw snapshot", () => {
  const { projection, db } = presentationFixture();
  test.after(() => db.close());
  const reads = taskPresentationReads(projection);
  assert.equal(reads.read("a-root").snapshot.task!.status, "done");
  assert.equal(projection.read("a-root").snapshot.task!.status, "planned");
  const first = reads.list({ status: "done", limit: 1 });
  assert.deepEqual(
    first.rows.map(({ taskId }) => taskId),
    ["a-root"],
  );
  const last = reads.list({ status: "done", limit: 1, cursor: first.page!.nextCursor! });
  assert.deepEqual(
    last.rows.map(({ taskId }) => taskId),
    ["b-leaf"],
  );
  assert.equal(last.page!.nextCursor, null);
  assert.deepEqual(
    reads.list({ status: "planned", limit: 1 }).rows.map(({ taskId }) => taskId),
    ["c-open"],
  );
});

test("single task presentation does not open a repository-wide index", () => {
  const { projection, db } = presentationFixture();
  test.after(() => db.close());
  let indexReads = 0;
  const reads = taskPresentationReads({
    ...projection,
    readTaskIndex: (...args) => {
      indexReads += 1;
      return projection.readTaskIndex(...args);
    },
  });
  reads.read("a-root");
  assert.equal(indexReads, 0);
});

test("a page cursor survives the derived root set disappearing between pages", () => {
  const { projection, db } = presentationFixture();
  test.after(() => db.close());
  const reads = taskPresentationReads(projection);
  for (const method of ["list", "readTaskIndex"] as const) {
    const first = reads[method]({ limit: 1 });
    assert.equal(first.rows[0]!.taskId, "a-root");
    db.prepare("UPDATE task_snapshot SET status = 'planned' WHERE task_id = 'b-leaf'").run();
    const second = reads[method]({ limit: 1, cursor: first.page!.nextCursor! });
    assert.equal(second.rows[0]!.taskId, "b-leaf");
    const last = reads[method]({ limit: 1, cursor: second.page!.nextCursor! });
    assert.equal(last.rows[0]!.taskId, "c-open");
    assert.equal(last.page!.nextCursor, null);
    db.prepare("UPDATE task_snapshot SET status = 'done' WHERE task_id = 'b-leaf'").run();
  }
});
