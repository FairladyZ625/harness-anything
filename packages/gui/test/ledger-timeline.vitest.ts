// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { sortTasksByCreatedDesc, taskCreatedAt } from "../src/renderer/model/ledger-timeline.ts";

function task(taskId: string, createdAt: string | null, title = taskId): TaskRow {
  return {
    taskId, title, projectId: "repo-a", coordinationStatus: "active", rawStatus: "active",
    freshness: "fresh", packageDisposition: "active", closeoutReadiness: "not_required",
    engine: "local", source: "local-document", module: "unassigned",
    createdAt, lastKnownAt: "2026-08-01T00:00:00.000Z", gates: [], docs: [],
  };
}

describe("ledger task creation time", () => {
  it("uses the projected task_bootstrapped time for current hash ids", () => {
    expect(taskCreatedAt(task("task_5f7ed8bbe1620ebf6a5ec55d4a", "2026-08-21T15:04:56.406Z")))
      .toBe("2026-08-21T15:04:56.406Z");
  });

  it("keeps tasks without a reliable bootstrap event unknown, regardless of id shape", () => {
    expect(taskCreatedAt(task("task_01M0A39KE0ABCDEFGHJKMNPQRS", null))).toBeNull();
    expect(taskCreatedAt(task("replay-imported-task", null))).toBeNull();
  });
});

describe("sortTasksByCreatedDesc (overview task stream)", () => {
  it("matches the real task_bootstrapped order row by row", () => {
    const rows = [
      task("task_5f7ed8bbe1620ebf6a5ec55d4a", "2026-08-21T15:04:56.406Z"),
      task("task_250aee0da31944e6da4932e0bd", "2026-08-21T15:04:22.795Z"),
      task("task_42c429ed985402aff0b41cae53", "2026-08-21T15:21:58.302Z"),
      task("task_db818dfdbb2387c301c02397b6", "2026-08-21T15:34:20.148Z"),
    ];
    expect(sortTasksByCreatedDesc(rows).map((row) => row.taskId)).toEqual([
      "task_db818dfdbb2387c301c02397b6",
      "task_42c429ed985402aff0b41cae53",
      "task_5f7ed8bbe1620ebf6a5ec55d4a",
      "task_250aee0da31944e6da4932e0bd",
    ]);
  });

  it("sorts entities with unknown creation time to the tail, keeping determinism", () => {
    const rows = sortTasksByCreatedDesc([
      task("replay-imported-task", null),
      task("task_5f7ed8bbe1620ebf6a5ec55d4a", "2026-08-21T15:04:56.406Z"),
    ]);
    expect(rows.map((row) => row.taskId)).toEqual(["task_5f7ed8bbe1620ebf6a5ec55d4a", "replay-imported-task"]);
    expect(taskCreatedAt(rows[1]!)).toBeNull();
  });

  it("empty input yields an empty stream and never mutates the input array", () => {
    const input: TaskRow[] = [];
    expect(sortTasksByCreatedDesc(input)).toEqual([]);
    const original = [task("task_old", "2026-08-16T10:00:00.000Z"), task("task_new", "2026-08-18T09:30:00.000Z")];
    sortTasksByCreatedDesc(original);
    expect(original.map((row) => row.taskId)).toEqual(["task_old", "task_new"]);
  });
});
