// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import {
  renderWorkPayload,
  workIndexFromProjection,
  workListFromProjection,
  workReceiptLine,
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
  // The stubbed statuses are what the kernel's presentation SQL emits in production: a root whose
  // members started presents active, so a planned root here would be a stale contract.
  task("declared", null, "active", "work"),
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
    read: (taskId: string) => ({ packagePath: `tasks/${taskId}` }),
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
    task("open", null, "active", "work"),
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
      { taskId: "open", status: "active", root: "declared" },
    ],
  );
  const index = workIndexFromProjection(projection);
  assert.deepEqual(Object.fromEntries(index.works.map(({ taskId, status }) => [taskId, status])), {
    "all-cancelled": "cancelled",
    "all-done": "done",
    childless: "planned",
    closed: "done",
    open: "active",
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
    read: (taskId: string) => ({ packagePath: `tasks/${taskId}` }),
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
  assert.match(rendered, /^work declared \[active\] declared title\ngoal: Ship release two\./u);
  assert.match(rendered, /- leaf-a \[active\] leaf-a title/u);
  assert.match(rendered, /next: ha task create --work declared --title <title> · ha agenda --work declared$/u);
  // The title sits beside the id: id, title, status, root, counts, activity.
  assert.match(
    renderWorkPayload(workListFromProjection(projection(), {}))!,
    /^works:\ndeclared\tdeclared title\tactive\tdeclared\t2 tasks/u,
  );
  assert.equal(renderWorkPayload({ schema: "other/v1" }), null);
});

// A create receipt must say where the task landed; a standalone create names the open work roots it
// could join, read from the same work-root rule `ha work list` uses. The rows are the kernel index
// shape, so this also pins that the receipt reads titles, not ids alone. `plans` maps a work root's
// task id to its task_plan.md body; a root without an entry has no readable plan.
function receiptProjection(rowsFor: typeof rows = rows, plans: Record<string, string> = {}) {
  const byId = new Map(rowsFor.map((row) => [row.taskId, row]));
  return {
    read: (taskId: string) =>
      byId.has(taskId)
        ? {
            packagePath: `tasks/${taskId}`,
            snapshot: { task: { ...byId.get(taskId), metadata: { parentTaskId: byId.get(taskId)!.parentTaskId } } },
          }
        : { packagePath: null, snapshot: { task: null } },
    readTaskIndex: (query: { workRootsOnly?: boolean; openOnly?: boolean } = {}) => ({
      status: "ready",
      rows: rowsFor.filter(
        (row) =>
          (!query.workRootsOnly ||
            row.taskClass === "work" ||
            (row.parentTaskId === null && rowsFor.some((candidate) => candidate.parentTaskId === row.taskId))) &&
          (!query.openOnly || (row.status !== "done" && row.status !== "cancelled")),
      ),
      watermark: 7,
      sourceRevision: 7,
      warnings: [],
    }),
    readDocument: (documentPath: string) => {
      const taskId = /^tasks\/([^/]+)\/task_plan\.md$/u.exec(documentPath)?.[1] ?? "";
      return { document: plans[taskId] === undefined ? null : { body: plans[taskId] } };
    },
  } as never;
}

test("a create receipt names the work it landed under by id and title", () => {
  assert.equal(
    workReceiptLine(receiptProjection(), {
      ...rows[1]!,
      title: "专用迁移修复",
      metadata: { parentTaskId: "declared" },
    } as never),
    "\nwork: declared declared title",
  );
  // A new work root names itself with its title, so the line is recognizable without a second read.
  assert.equal(
    workReceiptLine(receiptProjection(), { ...rows[0]!, metadata: { parentTaskId: null } } as never),
    "\nwork: declared declared title (new work root; add tasks with --work declared)",
  );
});

test("a standalone create receipt lists the open work roots it could join, newest first", () => {
  assert.equal(
    workReceiptLine(receiptProjection(), { ...rows[6]!, metadata: { parentTaskId: null } } as never),
    [
      "\nwork: none (standalone task)",
      "candidate works:",
      "- declared declared title: ha task move standalone --parent declared",
      "- derived derived title: ha task move standalone --parent derived",
      "next: ha work list",
    ].join("\n"),
  );
});

test("a landed receipt states the work's goal and offers move commands to closer works", () => {
  const line = workReceiptLine(
    receiptProjection(rows, {
      declared: "# Work\n\n## Goal\n\n- Ship release two.\n",
      derived: "# Work\n\n## Goal\n\n- Keep the release lanes green.\n",
    }),
    { ...rows[1]!, title: "keep release lanes green", metadata: { parentTaskId: "declared" } } as never,
  );
  assert.equal(
    line,
    [
      "\nwork: declared declared title",
      "goal: Ship release two.",
      "if this task does not belong to that work, move it now:",
      "- derived derived title: ha task move leaf-a --parent derived",
    ].join("\n"),
  );
});

test("receipt candidates rank works by title similarity and cap at three", () => {
  const candidate = (taskId: string, title: string, updatedAt: string) => ({
    ...task(taskId, null, "active", "work", updatedAt),
    title,
  });
  const rankedRows = [
    candidate("w_noise", "Unrelated storage rewrite", "2026-09-25T00:00:00.000Z"),
    candidate("w_close", "Receipt rendering pipeline", "2026-09-24T00:00:00.000Z"),
    candidate("w_closest", "Receipt candidate ranking", "2026-09-23T00:00:00.000Z"),
    candidate("w_mid", "Receipt deduplication", "2026-09-22T00:00:00.000Z"),
    candidate("w_also", "Receipt guidance text", "2026-09-21T00:00:00.000Z"),
  ];
  const line = workReceiptLine(receiptProjection(rankedRows), {
    ...rows[6]!,
    title: "receipt candidate ordering",
    metadata: { parentTaskId: null },
  } as never);
  assert.equal(
    line,
    [
      "\nwork: none (standalone task)",
      "candidate works:",
      "- w_closest Receipt candidate ranking: ha task move standalone --parent w_closest",
      "- w_close Receipt rendering pipeline: ha task move standalone --parent w_close",
      "- w_mid Receipt deduplication: ha task move standalone --parent w_mid",
      "next: ha work list",
    ].join("\n"),
  );
});

test("receipt candidates match CJK titles through character bigrams", () => {
  const cjkRows = [
    { ...task("w_cjk", null, "active", "work"), title: "编排器派工回退治理" },
    { ...task("w_other", null, "active", "work"), title: "storage rewrite" },
  ];
  const line = workReceiptLine(receiptProjection(cjkRows), {
    ...rows[6]!,
    title: "派工回退误拒修复",
    metadata: { parentTaskId: null },
  } as never);
  assert.match(
    line,
    /candidate works:\n- w_cjk 编排器派工回退治理: ha task move standalone --parent w_cjk\n- w_other storage rewrite: ha task move standalone --parent w_other/u,
  );
});
