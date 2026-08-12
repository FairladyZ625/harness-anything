import { describe, expect, it } from "vitest";
import { REPLAY_TASK_GRAPH } from "../../kernel/src/index.ts";
import type { TaskSnapshotProjectionRow } from "../src/api/renderer-dto.ts";
import { adaptProjectionRows, computeRootTaskId } from "../src/renderer/task-adapter.ts";

function row(overrides: Partial<TaskSnapshotProjectionRow> = {}): TaskSnapshotProjectionRow {
  const taskId = overrides.taskId ?? "task-x";
  return { taskId, workspaceRevision: 1, updatedAt: "2026-08-12T00:00:00.000Z", snapshot: { revision: 1,
    task: { schema: "task/v1", taskId, title: "X", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0,
      createdBy: { principal: { personId: "person-owner" }, executor: null }, completionGateIds: [] }, executions: [], reviews: [], edgesTaken: [], lease: null }, ...overrides };
}

describe("computeRootTaskId", () => {
  it("walks a parent chain and terminates cycles", () => {
    expect(computeRootTaskId("child", new Map([["child", "root"], ["root", undefined]]))).toBe("root");
    expect(computeRootTaskId("left", new Map([["left", "right"], ["right", "left"]]))).toBe("left");
  });
});

describe("adaptProjectionRows", () => {
  it("derives renderer state from the canonical lifecycle snapshot", () => {
    const [task] = adaptProjectionRows([row()]);
    expect(task).toMatchObject({ taskId: "task-x", title: "X", coordinationStatus: "planned", rawStatus: "planned/implementation",
      freshness: "fresh", rootTaskId: "task-x", rootTitle: "X" });
  });

  it("marks a pending projection stale but usable", () => {
    expect(adaptProjectionRows([row()], "pending")[0]?.freshness).toBe("stale-but-usable");
  });
});
