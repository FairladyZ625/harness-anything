// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import {
  renderWorkPayload,
  workIndexFromProjection,
  workListFromProjection,
  workShowFromProjection,
} from "../src/work-read.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";

const task = (
  taskId: string,
  parentTaskId: string | null,
  status: "planned" | "active" | "blocked" | "done" | "cancelled",
  taskClass: "standard" | "work" = "standard",
  updatedAt = "2026-09-20T00:00:00.000Z",
  packageDisposition: "active" | "archived" = "active",
  supersededBy: string | null = null,
) => ({
  taskId,
  parentTaskId,
  status,
  taskClass,
  title: `${taskId} title`,
  pinned: false,
  workKind: null,
  riskTier: null,
  urgency: null,
  packageDisposition,
  supersededBy,
  packagePath: `tasks/${taskId}`,
  updatedAt,
});

const rows = [
  task("declared", null, "planned", "work"),
  task("leaf-a", "declared", "active", "standard", "2026-09-22T00:00:00.000Z"),
  task("leaf-b", "declared", "done"),
  task("derived", null, "active"),
  task("derived-leaf", "derived", "blocked", "standard", "2026-09-21T00:00:00.000Z"),
  task("closed", null, "done", "work"),
  task("standalone", null, "active"),
];

function projection(plan: string | null = "# Work\n\n## Mission\n\n- Ship release two.\n- Keep the lanes green.\n") {
  return {
    readTaskIndex: () => ({ status: "ready", rows, watermark: 7, sourceRevision: 7, warnings: [] }),
    read: (taskId: string) => {
      const row = rows.find((candidate) => candidate.taskId === taskId);
      return {
        packagePath: `tasks/${taskId}`,
        snapshot: { task: row ? { taskId, supersededBy: row.supersededBy } : null },
      };
    },
    readDocument: () => ({ document: plan === null ? null : { body: plan } }),
  } as never;
}

test("work list derives declared and parent-derived roots with leaf counts, newest activity first", () => {
  const open = workListFromProjection(projection(), {});
  assert.equal(open.schema, "work-list/v1");
  assert.deepEqual(
    open.rows.map(({ taskId, root, taskCount, lastActivityAt }) => ({ taskId, root, taskCount, lastActivityAt })),
    [
      { taskId: "declared", root: "declared", taskCount: 2, lastActivityAt: "2026-09-22T00:00:00.000Z" },
      { taskId: "derived", root: "derived", taskCount: 1, lastActivityAt: "2026-09-21T00:00:00.000Z" },
    ],
  );
  assert.deepEqual(open.rows[0]!.counts, { done: 1, executing: 1, pending: 0, blocked: 0, planned: 0, cancelled: 0 });
  assert.deepEqual(
    workListFromProjection(projection(), { all: true, limit: 2 }).rows.map(({ taskId }) => taskId),
    ["declared", "derived"],
  );
  assert.equal(workListFromProjection(projection(), { all: true }).count, 3);
});

test("work index assigns every task to the work root ha work list names; nested declared work owns its subtree", () => {
  const nested = [
    task("outer", null, "active"),
    task("group", "outer", "active"),
    task("group-leaf", "group", "planned"),
    task("inner", "group", "active", "work"),
    task("inner-leaf", "inner", "active"),
    task("inner-deep", "inner-leaf", "done"),
    task("lonely", null, "active"),
    task("orphan", "missing-parent", "active"),
    task("finished", null, "done", "work"),
  ];
  const index = workIndexFromProjection({
    readTaskIndex: () => ({ status: "ready", rows: nested, watermark: 3, sourceRevision: 3, warnings: [] }),
  } as never);
  assert.deepEqual(
    Object.fromEntries(index.works.map(({ taskId, root, memberTaskIds }) => [taskId, { root, memberTaskIds }])),
    {
      outer: { root: "derived", memberTaskIds: ["group", "group-leaf"] },
      inner: { root: "declared", memberTaskIds: ["inner-deep", "inner-leaf"] },
      finished: { root: "declared", memberTaskIds: [] },
    },
  );
  const listed = workListFromProjection(
    {
      readTaskIndex: () => ({ status: "ready", rows: nested, watermark: 3, sourceRevision: 3, warnings: [] }),
    } as never,
    { all: true },
  );
  assert.deepEqual(
    index.works.map(({ taskId }) => taskId),
    listed.rows.map(({ taskId }) => taskId),
  );
  assert.deepEqual(parseDaemonGuiReadResult("repo.works.index", index), index);
  assert.throws(
    () =>
      parseDaemonGuiReadResult("repo.works.index", { ...index, works: [{ ...index.works[0], memberTaskIds: [1] }] }),
    /work index/u,
  );
});

test("work reads consume the kernel's presented root status while open and childless roots stay open", () => {
  const rows = [
    task("all-done", null, "done", "work"),
    task("done-group", "all-done", "done"),
    task("done-leaf", "done-group", "done"),
    task("cancelled-leaf", "all-done", "cancelled"),
    task("all-cancelled", null, "cancelled"),
    task("cancelled-leaf-a", "all-cancelled", "cancelled"),
    task("cancelled-leaf-b", "all-cancelled", "cancelled"),
    task("open", null, "planned", "work"),
    task("open-leaf", "open", "active"),
    task("childless", null, "planned", "work"),
    task("closed", null, "done", "work"),
    task("closed-leaf", "closed", "cancelled"),
  ];
  const projection = {
    readTaskIndex: () => ({ status: "ready", rows, watermark: 4, sourceRevision: 4, warnings: [] }),
    read: (taskId: string) => ({ packagePath: `tasks/${taskId}` }),
    readDocument: () => ({ document: { body: "# Work\n\n## Mission\n\n- Ship.\n" } }),
  } as never;
  assert.deepEqual(
    workListFromProjection(projection, {}).rows.map(({ taskId }) => taskId),
    ["childless", "open"],
  );
  assert.deepEqual(
    workListFromProjection(projection, { all: true }).rows.map(({ taskId, status, root }) => ({
      taskId,
      status,
      root,
    })),
    [
      { taskId: "all-cancelled", status: "cancelled", root: "derived" },
      { taskId: "all-done", status: "done", root: "declared" },
      { taskId: "childless", status: "planned", root: "declared" },
      { taskId: "closed", status: "done", root: "declared" },
      { taskId: "open", status: "planned", root: "declared" },
    ],
  );
  const index = workIndexFromProjection(projection);
  assert.deepEqual(Object.fromEntries(index.works.map(({ taskId, status }) => [taskId, status])), {
    "all-cancelled": "cancelled",
    "all-done": "done",
    childless: "planned",
    closed: "done",
    open: "planned",
  });
  assert.deepEqual(parseDaemonGuiReadResult("repo.works.index", index), index);
  const shown = workShowFromProjection(projection, { taskId: "all-done" });
  assert.equal(shown.root.status, "done");
  assert.match(renderWorkPayload(shown)!, /^work all-done \[done\] all-done title/u);
});

test("work show drops superseded archived leaves from open tasks and pending counts", () => {
  const retired = [
    task("declared", null, "planned", "work"),
    task("leaf-live", "declared", "planned"),
    task("leaf-retired", "declared", "planned", "standard", "2026-09-20T00:00:00.000Z", "archived", "task_replacement"),
  ];
  const projection = {
    readTaskIndex: () => ({ status: "ready", rows: retired, watermark: 3, sourceRevision: 3, warnings: [] }),
    read: (taskId: string) => {
      const row = retired.find((candidate) => candidate.taskId === taskId);
      return {
        packagePath: `tasks/${taskId}`,
        snapshot: { task: row ? { taskId, supersededBy: row.supersededBy } : null },
      };
    },
    readDocument: () => ({ document: { body: "# Work\n\n## Mission\n\n- Ship.\n" } }),
  } as never;
  const shown = workShowFromProjection(projection, { taskId: "declared" });

  assert.deepEqual(
    shown.openTasks.map(({ taskId }) => taskId),
    ["leaf-live"],
  );
  assert.equal(shown.counts.planned, 1);
  assert.equal(shown.scope.descendantCount, 2);
  assert.equal(shown.scope.executableLeafCount, 1);
  assert.equal(shown.scope.archivedCount, 1);
  assert.doesNotMatch(renderWorkPayload(shown)!, /leaf-retired/u);
});

test("work show names the goal, subtree counts and open tasks, and the renderer points at the next commands", () => {
  const shown = workShowFromProjection(projection(), { taskId: "declared" });
  assert.equal(shown.goal, "Ship release two.");
  assert.deepEqual(
    shown.openTasks.map(({ taskId }) => taskId),
    ["leaf-a"],
  );
  assert.equal(workShowFromProjection(projection(null), { taskId: "declared" }).goal, null);
  const rendered = renderWorkPayload(shown)!;
  assert.match(rendered, /^work declared \[planned\] declared title\ngoal: Ship release two\./u);
  assert.match(rendered, /- leaf-a \[active\] leaf-a title/u);
  assert.match(rendered, /next: ha task create --work declared --title <title> · ha agenda --work declared$/u);
  assert.match(renderWorkPayload(workListFromProjection(projection(), {}))!, /^works:\ndeclared\tplanned\tdeclared/u);
  assert.equal(renderWorkPayload({ schema: "other/v1" }), null);
});
