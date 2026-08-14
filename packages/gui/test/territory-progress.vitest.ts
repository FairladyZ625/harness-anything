// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import {
  clusterTasksByPrd,
  deriveZoneProgress,
  zoneRank,
} from "../src/renderer/graph/territoryProgress.ts";
import { partitionTasks } from "../src/renderer/graph/territory.ts";
import { UNPROJECTED_MODULE } from "../src/renderer/graph/moduleAssignment.ts";

/**
 * 领地找回「每个 PRD 任务的进度」+ 未投影降权。
 * 诚实边界同时受测:未投影只沉底,不隐藏、不冒充已投影。
 */

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_a", title: "Task A", projectId: "proj",
    coordinationStatus: "active", rawStatus: "active", freshness: "fresh",
    packageDisposition: "active", closeoutReadiness: "not_required",
    engine: "local", source: "local-document", module: "kernel",
    lastKnownAt: "2026-08-01T00:00:00.000Z", gates: [], docs: [],
    ...overrides,
  };
}

/** 一个 PRD 根 + 三个子任务(1 完成 / 1 进行 / 1 阻塞)。 */
function prdFixture(): TaskRow[] {
  return [
    task({ taskId: "root_1", title: "PRD 一", rootTaskId: "root_1", coordinationStatus: "active" }),
    task({ taskId: "c1", title: "子一", parentTaskId: "root_1", rootTaskId: "root_1", rootTitle: "PRD 一", coordinationStatus: "done" }),
    task({ taskId: "c2", title: "子二", parentTaskId: "root_1", rootTaskId: "root_1", rootTitle: "PRD 一", coordinationStatus: "active" }),
    task({ taskId: "c3", title: "子三", parentTaskId: "root_1", rootTaskId: "root_1", rootTitle: "PRD 一", coordinationStatus: "blocked" }),
  ];
}

describe("PRD 进度派生", () => {
  it("按状态分桶并算完成率", () => {
    const progress = deriveZoneProgress(prdFixture());
    expect(progress.total).toBe(4);
    expect(progress.done).toBe(1);
    expect(progress.active).toBe(2);
    expect(progress.blocked).toBe(1);
    expect(progress.doneRatio).toBeCloseTo(0.25);
  });

  it("空组不炸,完成率为 0", () => {
    expect(deriveZoneProgress([]).doneRatio).toBe(0);
  });

  it("cancelled / unknown 计入 other,不静默消失", () => {
    const progress = deriveZoneProgress([
      task({ taskId: "x", coordinationStatus: "cancelled" }),
      task({ taskId: "y", coordinationStatus: "unknown" }),
    ]);
    expect(progress.other).toBe(2);
    expect(progress.total).toBe(2);
  });
});

describe("PRD 聚簇", () => {
  it("同一 rootTaskId 的任务聚成一块,标题取 rootTitle", () => {
    const clusters = clusterTasksByPrd(prdFixture());
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.rootId).toBe("root_1");
    expect(clusters[0]!.title).toBe("PRD 一");
    expect(clusters[0]!.tasks).toHaveLength(4);
  });

  it("块内按重要性排序:阻塞在最前,完成沉底", () => {
    const [cluster] = clusterTasksByPrd(prdFixture());
    expect(cluster!.tasks[0]!.coordinationStatus).toBe("blocked");
    expect(cluster!.tasks.at(-1)!.coordinationStatus).toBe("done");
  });

  it("缺 root 且缺 module 的任务归入未投影块", () => {
    const clusters = clusterTasksByPrd([
      ...prdFixture(),
      task({ taskId: "orphan", title: "孤儿", parentTaskId: "ghost", module: "unassigned" }),
    ]);
    const unprojected = clusters.find((c) => c.rootId === UNPROJECTED_MODULE);
    expect(unprojected).toBeDefined();
    expect(unprojected!.progress.unprojected).toBe(true);
    expect(unprojected!.tasks.map((t) => t.taskId)).toEqual(["orphan"]);
  });

  it("未投影块恒排最后 —— 降权,但不隐藏", () => {
    const clusters = clusterTasksByPrd([
      task({ taskId: "orphan", title: "孤儿", parentTaskId: "ghost", module: "unassigned" }),
      ...prdFixture(),
    ]);
    expect(clusters.at(-1)!.rootId).toBe(UNPROJECTED_MODULE);
    // 仍然在结果里(未被过滤掉)。
    expect(clusters.some((c) => c.rootId === UNPROJECTED_MODULE)).toBe(true);
  });
});

describe("块排序权重", () => {
  it("有阻塞的块排最前,基本完工的沉后,未投影垫底", () => {
    const blocked = zoneRank(deriveZoneProgress([task({ coordinationStatus: "blocked" })]));
    const running = zoneRank(deriveZoneProgress([task({ coordinationStatus: "active" })]));
    const mostlyDone = zoneRank(deriveZoneProgress([task({ coordinationStatus: "done" })]));
    const unprojected = zoneRank(deriveZoneProgress([task()], true));
    expect(blocked).toBeLessThan(running);
    expect(running).toBeLessThan(mostlyDone);
    expect(mostlyDone).toBeLessThan(unprojected);
  });
});

describe("territory 分区接线", () => {
  it("task zone 带上进度信号", () => {
    const zones = partitionTasks(prdFixture());
    expect(zones).toHaveLength(1);
    expect(zones[0]!.progress?.total).toBe(4);
    expect(zones[0]!.progress?.blocked).toBe(1);
    expect(zones[0]!.chips).toHaveLength(4);
  });

  it("未投影 zone 的 moduleId 仍是显式哨兵(供计数与降权识别)", () => {
    const zones = partitionTasks([
      task({ taskId: "orphan", parentTaskId: "ghost", module: "unassigned" }),
    ]);
    expect(zones[0]!.moduleId).toBe(UNPROJECTED_MODULE);
    expect(zones[0]!.title).toBe("未投影");
  });
});
