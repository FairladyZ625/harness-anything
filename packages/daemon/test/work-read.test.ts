// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import { renderWorkPayload, workListFromProjection, workShowFromProjection } from "../src/work-read.ts";

const task = (
  taskId: string,
  parentTaskId: string | null,
  status: "planned" | "active" | "blocked" | "done" | "cancelled",
  taskClass: "standard" | "work" = "standard",
  updatedAt = "2026-09-20T00:00:00.000Z",
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
  packageDisposition: "active",
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
