// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { archiveTasks } from "../src/repo-cell-task-maintenance.ts";
import type { RepoTaskAction } from "../src/repo-cell-types.ts";

const binding = { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" } as const,
  cellCodedError = (code: string, message: string) => Object.assign(new Error(message), { code }),
  /** Minimal cell for the selection phase only: `read` throws with the task id
   * so the selected ids surface through the error, and any attempt to run the
   * wide query-read assembly would miss the method entirely. */
  selectionCell = (indexQueries: unknown[], rows: readonly { taskId: string; updatedAt: string }[]) => ({
    cellCodedError,
    projection: {
      readTaskIndex: (query: unknown = {}) => {
        indexQueries.push(query);
        return { rows };
      },
      read: (taskId: string) => {
        throw new Error(`SURFACE-READ:${taskId}`);
      },
    },
  }),
  archive = (cell: ReturnType<typeof selectionCell>, action: Partial<RepoTaskAction>) =>
    archiveTasks(
      cell as never,
      { kind: "task-archive", reason: "Retire", ...action } as RepoTaskAction,
      binding as never,
    );

test("archive selection pushes the status filter into one task index scan", () => {
  const indexQueries: unknown[] = [],
    cell = selectionCell(indexQueries, [
      { taskId: "task_recent", updatedAt: "2026-09-10T00:00:00.000Z" },
      { taskId: "task_old", updatedAt: "2026-08-01T00:00:00.000Z" },
    ]);

  assert.throws(
    () => archive(cell, { filter: "state:done", before: "2026-09-01T00:00:00.000Z" }),
    /SURFACE-READ:task_old/u,
  );
  assert.deepEqual(indexQueries, [{ status: "done" }]);
});

test("archive selection scans unfiltered when no state filter is given", () => {
  const indexQueries: unknown[] = [],
    cell = selectionCell(indexQueries, [{ taskId: "task_any", updatedAt: "2026-08-01T00:00:00.000Z" }]);

  assert.throws(() => archive(cell, {}), /SURFACE-READ:task_any/u);
  assert.deepEqual(indexQueries, [{}]);
});

test("archive selection keeps rejecting non-ISO before bounds", () => {
  const indexQueries: unknown[] = [],
    cell = selectionCell(indexQueries, []);

  assert.throws(() => archive(cell, { filter: "state:done", before: "not-a-date" }), /ISO-compatible/u);
  assert.deepEqual(indexQueries, []);
});
