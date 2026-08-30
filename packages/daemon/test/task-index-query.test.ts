// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskIndexProjectionRow } from "../../kernel/src/index.ts";
import { renderTaskIndexPayload, selectTaskIndex } from "../src/task-index-query.ts";

test("task index expands bounded and full-depth subtrees with search context and pins", () => {
  const rows = [
      row("task_alpha", "Alpha", "root"),
      row("task_beta", "Beta needle", "root", true),
      row("task_match", "Deep match", "task_alpha"),
      row("task_hidden", "Hidden", "task_match"),
    ],
    shallow = selectTaskIndex(rows, { parentTaskId: "root", depth: 1 }),
    deepSearch = selectTaskIndex(rows, {
      parentTaskId: "root",
      depth: "all",
      filters: { search: "task_ma" },
    });
  assert.equal(shallow.mode, "tree");
  assert.deepEqual(
    shallow.rows.map(({ taskId, pinned, children }) => ({ taskId, pinned, children: children.length })),
    [
      { taskId: "task_alpha", pinned: false, children: 0 },
      { taskId: "task_beta", pinned: true, children: 0 },
    ],
  );
  assert.equal(deepSearch.mode, "tree");
  assert.deepEqual(deepSearch.rows, [
    {
      taskId: "task_alpha",
      title: "Alpha",
      status: "planned",
      pinned: false,
      children: [
        {
          taskId: "task_match",
          title: "Deep match",
          status: "planned",
          pinned: false,
          children: [],
        },
      ],
    },
  ]);
  assert.match(
    renderTaskIndexPayload({
      schema: "task-list/v2",
      mode: "tree",
      rows: shallow.rows,
      count: shallow.count,
      status: "ready",
      watermark: 4,
      sourceRevision: 4,
    })!,
    /📌 task_beta \[planned\] Beta needle/u,
  );
});

test("filtered task index pagination is keyset-equivalent", () => {
  const rows = [row("task_alpha", "Needle one", "root"), row("task_beta", "Needle two", "root")],
    first = selectTaskIndex(rows, {
      parentTaskId: "root",
      filters: { search: "needle" },
      limit: 1,
    });
  assert.equal(first.mode, "flat");
  assert.deepEqual(
    first.rows.map(({ taskId }) => taskId),
    ["task_alpha"],
  );
  assert.ok(first.page?.nextCursor);
  const second = selectTaskIndex(rows, {
    parentTaskId: "root",
    filters: { search: "needle" },
    limit: 1,
    cursor: first.page!.nextCursor!,
  });
  assert.deepEqual(
    second.rows.map(({ taskId }) => taskId),
    ["task_beta"],
  );
  assert.equal(second.page?.nextCursor, null);
});

test("a 200-node projection iterable is consumed once and all-depth expansion stays iterative", () => {
  const rows = Array.from({ length: 200 }, (_, index) =>
    row(
      `task_${String(index).padStart(3, "0")}`,
      `Node ${index}`,
      index === 0 ? "root" : `task_${String(index - 1).padStart(3, "0")}`,
    ),
  );
  let reads = 0;
  const source: Iterable<TaskIndexProjectionRow> = {
      *[Symbol.iterator]() {
        for (const value of rows) {
          reads += 1;
          yield value;
        }
      },
    },
    selected = selectTaskIndex(source, { parentTaskId: "root", depth: "all" });
  assert.equal(reads, 200);
  assert.equal(selected.mode, "tree");
  assert.equal(selected.count, 200);
});

function row(taskId: string, title: string, parentTaskId: string | null, pinned = false): TaskIndexProjectionRow {
  return {
    taskId,
    title,
    status: "planned",
    pinned,
    parentTaskId,
    moduleKey: null,
    workKind: "feat",
    riskTier: "medium",
    urgency: null,
    taskClass: "standard",
    packageDisposition: "active",
    packagePath: `tasks/${taskId}`,
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}
