// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import { workspaceScopeFromProjection } from "../src/workspace-scope-read.ts";

const task = (
  taskId: string,
  parentTaskId: string | null,
  status: "planned" | "active" | "blocked" | "done" | "cancelled",
  taskClass: "standard" | "work" = "standard",
  packageDisposition: "active" | "archived" = "active",
) => ({
  taskId,
  parentTaskId,
  status,
  taskClass,
  title: taskId,
  pinned: taskId === "root",
  workKind: null,
  riskTier: null,
  urgency: null,
  packageDisposition,
  packagePath: `harness/tasks/${taskId}`,
  updatedAt: "2026-09-20T00:00:00.000Z",
});

const projection = (rows: readonly ReturnType<typeof task>[], events: readonly Record<string, unknown>[] = []) =>
  ({
    readTaskIndex: () => ({ status: "ready", rows, watermark: 12, sourceRevision: 12, warnings: [] }),
    readCanonicalEvents: (afterRevision: number, limit: number) => ({
      status: "ready",
      events: events.filter((event) => Number(event.workspaceRevision) > afterRevision).slice(0, limit),
      watermark: events.at(-1)?.workspaceRevision ?? 0,
      sourceRevision: events.at(-1)?.workspaceRevision ?? 0,
    }),
  }) as never;

test("workspace scope counts only executable leaves and keeps cancellation separate", () => {
  const rows = [
    task("root", null, "active", "work"),
    task("group", "root", "active", "work"),
    task("doing", "group", "active"),
    task("done", "root", "done"),
    task("cancelled", "root", "cancelled", "standard", "archived"),
    task("outside", null, "done"),
  ];
  const result = workspaceScopeFromProjection(projection(rows), { rootTaskId: "root", limit: 2 });

  assert.deepEqual(result.counts, { done: 1, executing: 1, pending: 0, blocked: 0, planned: 0, cancelled: 1 });
  assert.equal(result.scope.descendantCount, 4);
  assert.equal(result.scope.executableLeafCount, 3);
  assert.equal(result.scope.archivedCount, 1);
  assert.deepEqual(
    result.groups.map(({ taskId }) => taskId),
    ["group"],
  );
  assert.deepEqual(
    result.tasks.map(({ taskId }) => taskId),
    ["cancelled", "doing"],
  );
  assert.equal(result.page.nextCursor, "doing");
  assert.deepEqual(result.memberTaskIds, ["cancelled", "doing", "done", "group"]);
});

test("workspace scope reports a missing ancestor instead of inventing a breadcrumb", () => {
  const result = workspaceScopeFromProjection(
    {
      readTaskIndex: () => ({
        status: "pending",
        rows: [task("root", "missing", "planned", "work")],
        watermark: 8,
        sourceRevision: 9,
        warnings: ["projection_missing"],
      }),
      readCanonicalEvents: () => ({ status: "pending", events: [], watermark: 0, sourceRevision: 0 }),
    } as never,
    { rootTaskId: "root" },
  );
  assert.deepEqual(result.incompleteParentRefs, ["missing"]);
  assert.equal(result.status, "pending");
  assert.deepEqual(result.ancestors, []);
});

test("workspace scope cursor drains mixed-case task ids in sort order", () => {
  const rows = [
    task("root", null, "active", "work"),
    task("task_A", "root", "planned"),
    task("task_a", "root", "planned"),
  ];
  const source = projection(rows);
  const taskIds: string[] = [];
  let cursor: string | undefined;

  do {
    const page = workspaceScopeFromProjection(source, {
      rootTaskId: "root",
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    taskIds.push(...page.tasks.map(({ taskId }) => taskId));
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  assert.deepEqual(taskIds, ["task_a", "task_A"]);
});

test("workspace scope returns only bounded summaries and drops large event payload fields", () => {
  const rows = [task("root", null, "active", "work"), task("member", "root", "active")],
    largeTests = Array.from({ length: 2_407 }, (_, index) => ({ name: `test-${index}`, output: "x".repeat(200) })),
    events = [
      {
        eventId: "outside",
        schema: "ci-run-observation-event/v3",
        type: "ci_run_observed",
        occurredAt: "2026-09-20T00:00:00.000Z",
        workspaceRevision: 1,
        taskId: "outside",
        payload: { title: "outside", tests: largeTests },
      },
      {
        eventId: "inside",
        schema: "ci-run-observation-event/v3",
        type: "ci_run_observed",
        occurredAt: "2026-09-20T00:01:00.000Z",
        workspaceRevision: 2,
        taskId: "member",
        payload: { title: "inside", tests: largeTests },
      },
    ];
  const result = workspaceScopeFromProjection(projection(rows, events), { rootTaskId: "root" });

  assert.equal(result.eventSummaries.length, 1);
  assert.equal(result.eventSummaries[0]?.eventId, "inside");
  assert.equal(JSON.stringify(result.eventSummaries).includes("test-2406"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result.eventSummaries)) < 2_000);
});
