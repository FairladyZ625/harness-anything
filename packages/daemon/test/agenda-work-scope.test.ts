// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskProjection, TaskProjectionListQuery } from "@harness-anything/kernel";
import { canonicalRoot } from "../src/protocol/daemon-protocol.contract.ts";
import { makeTaskQueryReadModel } from "../src/task-query-read.ts";
import { encodeAgendaCursor } from "../src/agenda-summary.ts";

/**
 * The --work scope contract: membership reaches the projection query, so a small limit
 * returns that work's rows. The stub's list() mirrors the SQL contract (predicates apply
 * before the limit; order is pinned desc then task id asc), including the composite
 * `[pinned, taskId]` cursor used by the real SQLite/PG list ports.
 */
const cut = { status: "ready", watermark: 7, sourceRevision: 7 } as const;

interface FixtureRow {
  readonly taskId: string;
  readonly snapshot: {
    readonly task: {
      readonly taskId: string;
      readonly title: string;
      readonly taskClass: "standard" | "work";
      readonly status: string;
      readonly pinned: boolean;
      readonly metadata?: { readonly parentTaskId: string | null };
      readonly presetSnapshotDigest: null;
    };
    readonly executions: readonly unknown[];
    readonly lease: { readonly executionId: string; readonly phase?: string } | null;
  };
}

function taskRow(
  taskId: string,
  patch: {
    readonly status?: string;
    readonly taskClass?: "standard" | "work";
    readonly parentTaskId?: string | null;
    readonly leased?: boolean;
    readonly pinned?: boolean;
  } = {},
): FixtureRow {
  return {
    taskId,
    snapshot: {
      task: {
        taskId,
        title: taskId,
        taskClass: patch.taskClass ?? "standard",
        status: patch.status ?? "planned",
        pinned: patch.pinned ?? false,
        metadata: { parentTaskId: patch.parentTaskId ?? null },
        presetSnapshotDigest: null,
      },
      executions: [],
      lease: patch.leased ? { executionId: `exe_${taskId}`, phase: "held" } : null,
    },
  };
}

function scopeProjection(taskRows: readonly FixtureRow[], listCalls?: TaskProjectionListQuery[]): TaskProjection {
  return {
    listEntities: () => [],
    readTaskIndex: (query: TaskProjectionListQuery = {}) => {
      const selected = taskRows
          .filter((row) => query.taskIds === undefined || query.taskIds.includes(row.taskId))
          .filter((row) => query.status === undefined || row.snapshot.task.status === query.status)
          .filter((row) => query.cursor === undefined || row.taskId > query.cursor)
          .sort((left, right) => left.taskId.localeCompare(right.taskId)),
        limit = query.limit,
        visible = limit === undefined ? selected : selected.slice(0, limit),
        last = visible.at(-1);
      return {
        ...cut,
        page:
          limit === undefined
            ? null
            : {
                limit,
                cursor: query.cursor ?? null,
                nextCursor: selected.length > limit && last ? last.taskId : null,
              },
        warnings: [],
        rows: visible.map((row) => ({
          taskId: row.taskId,
          title: row.snapshot.task.title,
          status: row.snapshot.task.status,
          taskClass: row.snapshot.task.taskClass,
          parentTaskId: row.snapshot.task.metadata?.parentTaskId ?? null,
          pinned: row.snapshot.task.pinned,
          packageDisposition: "active",
          packagePath: null,
          updatedAt: "2026-10-08T00:00:00.000Z",
        })),
      };
    },
    list: (query: TaskProjectionListQuery = {}) => {
      listCalls?.push(query);
      const pinned = (row: FixtureRow) => Number(row.snapshot.task.pinned),
        selected = taskRows
          .filter((row) => query.status === undefined || row.snapshot.task.status === query.status)
          .filter((row) => query.taskIds === undefined || query.taskIds.includes(row.taskId))
          .sort((left, right) => pinned(right) - pinned(left) || left.taskId.localeCompare(right.taskId)),
        cursorParts = query.cursor === undefined ? null : decodeListCursor(query.cursor),
        afterCursor =
          cursorParts === null
            ? selected
            : selected.filter(
                (row) =>
                  pinned(row) < cursorParts.pinned ||
                  (pinned(row) === cursorParts.pinned && row.taskId > cursorParts.taskId),
              );
      if (query.limit === undefined && query.cursor === undefined) return { ...cut, rows: afterCursor, warnings: [] };
      const limit = query.limit ?? 100,
        visible = afterCursor.slice(0, limit),
        last = visible.at(-1);
      return {
        ...cut,
        rows: visible,
        warnings: [],
        page: {
          limit,
          cursor: query.cursor ?? null,
          nextCursor:
            afterCursor.length > limit && last
              ? Buffer.from(JSON.stringify([String(last.snapshot.task.pinned ? 1 : 0), last.taskId]), "utf8").toString(
                  "base64url",
                )
              : null,
        },
      };
    },
    read: (taskId: string) => ({
      ...cut,
      packagePath: null,
      snapshot: taskRows.find((row) => row.taskId === taskId)?.snapshot ?? { task: null },
    }),
    readTaskDependencyClosure: () => ({ ...cut, rows: [] }),
    readTaskRelationsByTargets: () => ({ ...cut, rows: [] }),
    readTaskRelationsBySources: () => ({ ...cut, rows: [] }),
    readTaskStatuses: (taskIds: readonly string[]) => ({
      ...cut,
      rows: taskRows
        .filter((row) => taskIds.includes(row.taskId))
        .map((row) => ({ taskId: row.taskId, status: row.snapshot.task.status })),
    }),
    listDecisionAgendaPage: (query: { readonly limit: number }) => ({
      ...cut,
      decisions: [],
      page: { limit: query.limit, cursor: null, nextCursor: null },
    }),
  } as unknown as TaskProjection;
}

function decodeListCursor(value: string): { readonly pinned: number; readonly taskId: string } {
  const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  assert.ok(Array.isArray(parsed) && parsed.length === 2);
  assert.ok(parsed[0] === "0" || parsed[0] === "1");
  assert.equal(typeof parsed[1], "string");
  return { pinned: Number(parsed[0]), taskId: parsed[1] as string };
}

function scopeReadModel(taskRows: readonly FixtureRow[], listCalls?: TaskProjectionListQuery[]) {
  return makeTaskQueryReadModel({
    rootDir: canonicalRoot(process.cwd()),
    projection: scopeProjection(taskRows, listCalls),
    readPinnedEntities: () => [],
    judgments: {
      closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
      blocking: (() => []) as never,
    },
  });
}

test("agenda preserves pinned-first ordering when the task index is task-id ordered", () => {
  const rows = [
    taskRow("task_a_unpinned", { status: "active", leased: true }),
    taskRow("task_z_pinned", { status: "active", pinned: true, leased: true }),
  ];
  const read = scopeReadModel(rows),
    page = read.agenda({ limit: 1 });
  assert.deepEqual(
    page.inFlight.map(({ taskId }) => taskId),
    ["task_z_pinned"],
  );
  assert.notEqual(page.page.nextCursor, null);
  const next = read.agenda({ limit: 1, cursor: page.page.nextCursor! });
  assert.deepEqual(
    next.inFlight.map(({ taskId }) => taskId),
    ["task_a_unpinned"],
  );
  assert.equal(next.page.nextCursor, null);
});

test("a work-scoped agenda page serves the work's in-flight rows when other works fill the first page", () => {
  const listCalls: TaskProjectionListQuery[] = [],
    // Sorted by task id the other work's two active lanes precede everything in the release work,
    // so the repository's first active page of 2 holds no release member at all.
    rows = [
      taskRow("task_a_other_lane", { status: "active", parentTaskId: "task_other_root", leased: true }),
      taskRow("task_b_other_lane", { status: "active", parentTaskId: "task_other_root", leased: true }),
      taskRow("task_other_root", { taskClass: "work" }),
      taskRow("task_release_root", { taskClass: "work" }),
      taskRow("task_z_release_lane", { status: "active", parentTaskId: "task_release_root", leased: true }),
    ],
    scoped = scopeReadModel(rows, listCalls).agenda({ work: "task_release_root", limit: 2 });

  assert.deepEqual(
    scoped.inFlight.map(({ taskId }) => taskId),
    ["task_z_release_lane"],
  );
  // The scope must reach the projection query itself: every lifecycle page narrows to the
  // work subtree instead of taking the repository's page and filtering it afterwards.
  assert.ok(listCalls.length >= 1);
  assert.ok(
    listCalls.every(
      ({ taskIds }) =>
        taskIds === undefined ||
        taskIds.every((taskId) => ["task_release_root", "task_z_release_lane"].includes(taskId)),
    ),
  );
});

test("work-scoped cursor pagination walks the whole subtree with no gaps, duplicates, or foreign rows", () => {
  const rows = [
      taskRow("task_a_other_lane", { status: "active", parentTaskId: "task_other_root", leased: true }),
      taskRow("task_b_release_lane", { status: "active", parentTaskId: "task_release_root", leased: true }),
      taskRow("task_c_other_lane", { status: "active", parentTaskId: "task_other_root", leased: true }),
      taskRow("task_d_release_lane", { status: "active", parentTaskId: "task_release_root", leased: true }),
      taskRow("task_e_other_lane", { status: "active", parentTaskId: "task_other_root", leased: true }),
      taskRow("task_f_release_lane", { status: "active", parentTaskId: "task_release_root", leased: true }),
      taskRow("task_other_root", { taskClass: "work" }),
      taskRow("task_release_root", { taskClass: "work" }),
    ],
    read = scopeReadModel(rows),
    // Termination signal is the agenda's nextCursor going null, never a non-null cursor value.
    collected: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = read.agenda({ work: "task_release_root", limit: 1, cursor });
    collected.push(...page.inFlight.map(({ taskId }) => taskId));
    if (page.page.nextCursor === null) break;
    cursor = page.page.nextCursor!;
  }
  assert.deepEqual(collected, ["task_b_release_lane", "task_d_release_lane", "task_f_release_lane"]);
  // Drive one read past the last member: the terminal active cursor is the final member's
  // task id with every other page already closed, and the next page must be empty and done.
  const pastLast = read.agenda({
    work: "task_release_root",
    limit: 1,
    cursor: encodeAgendaCursor({
      active: Buffer.from(JSON.stringify(["0", "task_f_release_lane"]), "utf8").toString("base64url"),
      blocked: null,
      planned: null,
      submitted: null,
      inReview: null,
      decisions: null,
      awaitingYou: null,
      answeredForYou: null,
    }),
  });
  assert.deepEqual(pastLast.inFlight, []);
  assert.equal(pastLast.page.nextCursor, null);
});

test("an unscoped agenda keeps the repository-wide page and passes no membership filter", () => {
  const listCalls: TaskProjectionListQuery[] = [],
    rows = [
      taskRow("task_a_other_lane", { status: "active", parentTaskId: "task_other_root", leased: true }),
      taskRow("task_b_other_lane", { status: "active", parentTaskId: "task_other_root", leased: true }),
      taskRow("task_other_root", { taskClass: "work" }),
      taskRow("task_release_root", { taskClass: "work" }),
      taskRow("task_z_release_lane", { status: "active", parentTaskId: "task_release_root", leased: true }),
    ],
    unscoped = scopeReadModel(rows, listCalls).agenda({ limit: 2 });

  assert.deepEqual(
    unscoped.inFlight.map(({ taskId }) => taskId),
    ["task_a_other_lane", "task_b_other_lane"],
  );
  // The pinned list port owns repository-wide ordering. An unscoped agenda must not
  // fabricate a membership filter while selecting its bounded page.
  assert.ok(listCalls.every(({ taskIds }) => taskIds === undefined));
});
