// harness-test-tier: fast
import test from "node:test";
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
  const cut = { status: "ready", watermark: 7, sourceRevision: 7, warnings: [] };
  const projection = {
    readTaskIndex: (query: TaskProjectionListQuery = {}) => {
      let selected = rows.filter((row) => query.status === undefined || row.status === query.status);
      if (query.cursor) {
        const [after] = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
        selected = selected.filter((row) => row.taskId > after);
      }
      const visible = query.limit === undefined ? selected : selected.slice(0, query.limit);
      return {
        ...cut,
        rows: visible,
        page:
          query.limit === undefined
            ? null
            : {
                limit: query.limit,
                cursor: query.cursor ?? null,
                nextCursor:
                  selected.length > query.limit
                    ? Buffer.from(JSON.stringify([visible.at(-1)!.taskId])).toString("base64url")
                    : null,
              },
      };
    },
    read: (id: string) => ({
      ...cut,
      packagePath: null,
      snapshot: {
        ...snapshot,
        task: {
          ...snapshot.task,
          ...rows.find((row) => row.taskId === id),
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
          snapshot: projection.read(row.taskId).snapshot,
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
  return { projection, rows };
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
  const { projection } = presentationFixture();
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
  const { projection } = presentationFixture();
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
