import { describe, expect, it } from "vitest";
import type { TaskProjectionRow } from "../src/api/renderer-dto.ts";
import {
  adaptProjectionRows,
  computeRootTaskId,
} from "../src/renderer/task-adapter.ts";

function row(overrides: Partial<TaskProjectionRow>): TaskProjectionRow {
  return {
    schema: "sqlite-task-row/v1",
    taskId: "task-x",
    title: "X",
    canonicalStatus: "planned",
    coordinationStatus: "open",
    rawStatus: "planned",
    packageDisposition: "active",
    closeoutReadiness: "not-ready",
    lifecycleEngine: "local",
    freshness: "fresh",
    updatedAt: "2026-07-09T00:00:00.000Z",
    source: "local-document",
    sourcePath: "harness/tasks/task-x/INDEX.md",
    attribution: { originator: null, latestActor: null, trailCount: 0, completeness: "unresolved" },
    ...overrides,
  };
}

describe("computeRootTaskId", () => {
  it("returns self when task has no parent", () => {
    const parentById = new Map([
      ["t1", undefined],
    ]);
    expect(computeRootTaskId("t1", parentById)).toBe("t1");
  });

  it("walks up single-edge chain", () => {
    const parentById = new Map([
      ["t1", "t2"],
      ["t2", "t3"],
      ["t3", undefined],
    ]);
    expect(computeRootTaskId("t1", parentById)).toBe("t3");
  });

  it("handles self-referencing chain defensively (returns start)", () => {
    const parentById = new Map([
      ["t1", "t2"],
      ["t2", "t1"],
    ]);
    expect(computeRootTaskId("t1", parentById)).toBe("t1");
  });

  it("treats dangling parent pointer as root boundary", () => {
    const parentById = new Map([
      ["t1", "tGhost"],
    ]);
    expect(computeRootTaskId("t1", parentById)).toBe("t1");
  });
});

describe("adaptProjectionRows root computation", () => {
  it("sets rootTaskId/rootTitle from parent chain", () => {
    const rows = [
      row({ taskId: "root1", title: "Root One" }),
      row({ taskId: "child1a", title: "Child A", parentTaskId: "root1" }),
      row({ taskId: "child1b", title: "Child B", parentTaskId: "child1a" }),
      row({ taskId: "root2", title: "Root Two" }),
      row({ taskId: "child2", title: "Child C", parentTaskId: "root2" }),
    ];

    const adapted = adaptProjectionRows(rows);
    const byId = new Map(adapted.map((t) => [t.taskId, t]));

    expect(byId.get("root1")?.rootTaskId).toBe("root1");
    expect(byId.get("root1")?.rootTitle).toBe("Root One");
    expect(byId.get("child1a")?.rootTaskId).toBe("root1");
    expect(byId.get("child1a")?.rootTitle).toBe("Root One");
    expect(byId.get("child1b")?.rootTaskId).toBe("root1");
    expect(byId.get("child1b")?.rootTitle).toBe("Root One");
    expect(byId.get("child2")?.rootTaskId).toBe("root2");
    expect(byId.get("child2")?.rootTitle).toBe("Root Two");
    expect(byId.get("child2")?.attribution.completeness).toBe("unresolved");
  });

  it("treats standalone tasks (no parent) as their own root", () => {
    const adapted = adaptProjectionRows([
      row({ taskId: "solo", title: "Solo" }),
    ]);
    expect(adapted[0].rootTaskId).toBe("solo");
    expect(adapted[0].rootTitle).toBe("Solo");
  });

  it("preserves parentTaskId on adapted row", () => {
    const adapted = adaptProjectionRows([
      row({ taskId: "child", parentTaskId: "parent" }),
      row({ taskId: "parent" }),
    ]);
    const child = adapted.find((t) => t.taskId === "child");
    expect(child?.parentTaskId).toBe("parent");
  });
});
