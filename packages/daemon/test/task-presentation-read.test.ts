// harness-test-tier: fast
import test from "node:test";
import { presentationQueryFixture } from "../../storage/test/store/presentation-query.fixture.ts";
import assert from "node:assert/strict";
import { type TaskProjection, type TaskProjectionListQuery, allowsTaskStatusMove } from "@harness-anything/kernel";
import { listTasks, taskListPayload, type TaskQueryCell } from "../src/repo-cell-task-query.ts";
import { taskShowFromProjection } from "../src/repo-cell-completion.ts";
import { taskPresentationReads } from "../src/task-presentation-read.ts";
import { workIndexFromProjection, workListFromProjection } from "../src/work-read.ts";
import { createRepoCellApi, type RepoCellApiContext } from "../src/repo-cell-api.ts";
import { dispatchRead } from "../src/repo-cell-command.ts";
import { workspaceStructureFromProjection } from "../src/workspace-scope-read.ts";
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

test("task display and flat pages defer parent-derived fields without blocking or inventing zero children", () => {
  const { projection, db } = presentationFixture();
  test.after(() => db.close());
  const warnings = ["task_parent_metadata_deferred" as const];
  const pending = {
    ...projection,
    read: (id: string, presentation = false) => ({ ...projection.read(id), warnings: presentation ? warnings : [] }),
    readTaskIndex: (query: TaskProjectionListQuery = {}) => ({
      ...projection.readTaskIndex({ ...query, presentationStatus: false }),
      warnings,
    }),
    readTaskChildCounts: () => {
      throw new Error("parent-derived reads must be deferred");
    },
    readRelationQuery: () => ({ status: "ready" as const, rows: [], watermark: 7, sourceRevision: 7, warnings: [] }),
  } as unknown as TaskProjection;
  const first = taskList(pending, "planned") as unknown as {
    rows: { taskId: string; rootAssessment: unknown }[];
    warnings: string[];
    page: { nextCursor: string };
  };
  assert.equal(first.rows[0]?.taskId, "a-root");
  assert.equal(first.rows[0]?.rootAssessment, null);
  assert.deepEqual(first.warnings, warnings);
  const next = taskList(pending, "planned", 1, first.page.nextCursor);
  assert.equal(next.rows[0]?.taskId, "c-open");
  const receipt = taskShowFromProjection("/unused/task-parent-migration", pending, "a-root");
  const shown = JSON.parse(receipt.evidence!);
  assert.equal(shown.task.taskId, "a-root");
  assert.equal(shown.task.status, "planned");
  assert.equal(shown.rootAssessment, null);
  assert.equal(shown.completionNext, null);
  assert.deepEqual(shown.warnings, warnings);
});

test("parent collections preserve pending cuts and deferred metadata instead of publishing empty success", () => {
  const { projection, db } = presentationFixture();
  test.after(() => db.close());
  for (const status of ["pending", "ready"] as const) {
    const queries: TaskProjectionListQuery[] = [];
    const pending = {
      ...projection,
      readTaskIndex: (query: TaskProjectionListQuery = {}) => {
        queries.push(query);
        return {
          ...projection.readTaskIndex(query),
          rows: [],
          status,
          warnings: ["task_parent_metadata_deferred" as const],
        };
      },
    };
    for (const read of [
      () => workListFromProjection(pending, {}),
      () => workIndexFromProjection(pending),
      () => workspaceStructureFromProjection(pending, { rootTaskId: "a-root" }),
    ]) {
      assert.throws(read, { code: "projection_pending", message: "索引迁移中" });
      assert.equal(queries.at(-1)?.requireParentMetadata, true);
    }
    for (const depth of [undefined, "all"]) {
      assert.throws(
        () =>
          taskListPayload(
            {
              readTaskIndex: pending.readTaskIndex,
              readTaskChildCounts: pending.readTaskChildCounts,
              rootThreshold: 5,
            },
            {},
            { kind: "task-list", parentTaskId: "a-root", ...(depth ? { depth } : {}) } as never,
            (code, message) => Object.assign(new Error(message), { code }),
          ),
        { code: "projection_pending" },
      );
    }
  }
});

test("work index API propagates migration failure and restores the complete result after backfill", async () => {
  const { projection, db } = presentationFixture();
  test.after(() => db.close());
  let migrating = true;
  const cell = createRepoCellApi({
    extracted: {},
    mode: "local",
    fleetRoster: null,
    input: { repoId: "probe" },
    state: "attached",
    rootDir: "/unused",
    dispatchRead,
    projection: {
      ...projection,
      readTaskIndex: (query: TaskProjectionListQuery = {}) => {
        if (migrating) {
          assert.equal(query.requireParentMetadata, true);
          throw Object.assign(new Error("索引迁移中"), { code: "projection_pending" });
        }
        return projection.readTaskIndex(query);
      },
    },
  } as unknown as RepoCellApiContext);
  await assert.rejects(cell.read("repo.works.index", {}), { code: "projection_pending", message: "索引迁移中" });
  migrating = false;
  const ready = await cell.read("repo.works.index", {});
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.works[0]?.memberTaskIds, ["b-leaf"]);
});
