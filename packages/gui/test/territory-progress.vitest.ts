// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import {
  clusterTasksByWork,
  deriveZoneProgress,
  UNKNOWN_WORK,
  UNKNOWN_WORK_TITLE,
  workRootResolver,
  zoneRank,
} from "../src/renderer/graph/territoryProgress.ts";
import { partitionTasks } from "../src/renderer/graph/territory.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

/**
 * 领地找回「每个工作的进度」+ 工作未知降权。
 * 诚实边界同时受测:工作未知只沉底,不隐藏、不猜归属。
 */

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_a",
    title: "Task A",
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    lastKnownAt: "2026-08-01T00:00:00.000Z",
    gates: [],
    docs: [],
    ...projectedTaskFields(overrides.coordinationStatus ?? "active", {
      archived: (overrides.packageDisposition ?? "active") !== "active",
    }),
    ...overrides,
  };
}

/** 一个工作根 + 三个子任务(1 完成 / 1 进行 / 1 阻塞)。 */
function workFixture(): TaskRow[] {
  return [
    task({ taskId: "root_1", title: "工作一", rootTaskId: "root_1", coordinationStatus: "active" }),
    task({
      taskId: "c1",
      title: "子一",
      parentTaskId: "root_1",
      rootTaskId: "root_1",
      rootTitle: "工作一",
      coordinationStatus: "done",
    }),
    task({
      taskId: "c2",
      title: "子二",
      parentTaskId: "root_1",
      rootTaskId: "root_1",
      rootTitle: "工作一",
      coordinationStatus: "active",
    }),
    task({
      taskId: "c3",
      title: "子三",
      parentTaskId: "root_1",
      rootTaskId: "root_1",
      rootTitle: "工作一",
      coordinationStatus: "blocked",
    }),
  ];
}

describe("工作进度派生", () => {
  it("按投影的看板列分桶并算完成率", () => {
    const progress = deriveZoneProgress(workFixture());
    expect(progress.total).toBe(4);
    expect(progress.terminal).toBe(1);
    expect(progress.open).toBe(2);
    expect(progress.blocked).toBe(1);
    expect(progress.doneRatio).toBeCloseTo(0.25);
  });

  it("空组不炸,完成率为 0", () => {
    expect(deriveZoneProgress([]).doneRatio).toBe(0);
  });

  // cancelled 落 terminal 列(kernel `terminalDomainStatuses`),unknown 没有列 —— 两者都不静默消失。
  it("cancelled 计入 terminal,unknown 计入 unplaced", () => {
    const progress = deriveZoneProgress([
      task({ taskId: "x", coordinationStatus: "cancelled" }),
      task({ taskId: "y", coordinationStatus: "unknown" }),
    ]);
    expect(progress.terminal).toBe(1);
    expect(progress.unplaced).toBe(1);
    expect(progress.total).toBe(2);
  });
});

describe("工作聚簇", () => {
  it("同一 rootTaskId 的任务聚成一块,标题取 rootTitle", () => {
    const clusters = clusterTasksByWork(workFixture());
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.rootId).toBe("root_1");
    expect(clusters[0]!.title).toBe("工作一");
    expect(clusters[0]!.tasks).toHaveLength(4);
  });

  it("块内按重要性排序:阻塞在最前,完成沉底", () => {
    const [cluster] = clusterTasksByWork(workFixture());
    expect(cluster!.tasks[0]!.coordinationStatus).toBe("blocked");
    expect(cluster!.tasks.at(-1)!.coordinationStatus).toBe("done");
  });

  it("缺 rootTaskId 时沿可见父链上溯到根,归入该工作", () => {
    const clusters = clusterTasksByWork([
      task({ taskId: "root_2", title: "工作二" }),
      task({ taskId: "mid", title: "中间", parentTaskId: "root_2" }),
      task({ taskId: "leaf", title: "叶子", parentTaskId: "mid" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.rootId).toBe("root_2");
    expect(clusters[0]!.title).toBe("工作二");
    expect(clusters[0]!.tasks.map((t) => t.taskId).sort()).toEqual(["leaf", "mid", "root_2"]);
  });

  it("父任务不在可见集合的任务归入工作未知块,不猜归属", () => {
    const clusters = clusterTasksByWork([
      ...workFixture(),
      task({ taskId: "orphan", title: "孤儿", parentTaskId: "ghost" }),
    ]);
    const unknown = clusters.find((c) => c.rootId === UNKNOWN_WORK);
    expect(unknown).toBeDefined();
    expect(unknown!.title).toBe(UNKNOWN_WORK_TITLE);
    expect(unknown!.progress.unknownWork).toBe(true);
    expect(unknown!.tasks.map((t) => t.taskId)).toEqual(["orphan"]);
  });

  it("父链成环的任务同样归入工作未知块", () => {
    const clusters = clusterTasksByWork([
      task({ taskId: "loop_a", parentTaskId: "loop_b" }),
      task({ taskId: "loop_b", parentTaskId: "loop_a" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.rootId).toBe(UNKNOWN_WORK);
    expect(clusters[0]!.tasks).toHaveLength(2);
  });

  it("工作未知块恒排最后 —— 降权,但不隐藏", () => {
    const clusters = clusterTasksByWork([
      task({ taskId: "orphan", title: "孤儿", parentTaskId: "ghost" }),
      ...workFixture(),
    ]);
    expect(clusters.at(-1)!.rootId).toBe(UNKNOWN_WORK);
    // 仍然在结果里(未被过滤掉)。
    expect(clusters.some((c) => c.rootId === UNKNOWN_WORK)).toBe(true);
  });
});

describe("工作根判定(task 与 fact 分区共用)", () => {
  it("rootTaskId 优先;缺失时上溯;task 不在集合 → undefined", () => {
    const rootOf = workRootResolver([
      task({ taskId: "r", title: "根" }),
      task({ taskId: "c", parentTaskId: "r" }),
      task({ taskId: "hidden_parent_child", parentTaskId: "gone", rootTaskId: "gone" }),
    ]);
    expect(rootOf("r")).toBe("r");
    expect(rootOf("c")).toBe("r");
    // adapter 在全量切面上算好的 rootTaskId 即使根不可见也照用:这是投影事实,不是猜。
    expect(rootOf("hidden_parent_child")).toBe("gone");
    expect(rootOf("missing")).toBeUndefined();
  });
});

describe("块排序权重", () => {
  it("有阻塞的块排最前,基本完工的沉后,工作未知垫底", () => {
    const blocked = zoneRank(deriveZoneProgress([task({ coordinationStatus: "blocked" })]));
    const running = zoneRank(deriveZoneProgress([task({ coordinationStatus: "active" })]));
    const mostlyDone = zoneRank(deriveZoneProgress([task({ coordinationStatus: "done" })]));
    const unknownWork = zoneRank(deriveZoneProgress([task()], true));
    expect(blocked).toBeLessThan(running);
    expect(running).toBeLessThan(mostlyDone);
    expect(mostlyDone).toBeLessThan(unknownWork);
  });
});

describe("territory 分区接线", () => {
  it("task zone 带上进度信号", () => {
    const zones = partitionTasks(workFixture());
    expect(zones).toHaveLength(1);
    expect(zones[0]!.progress?.total).toBe(4);
    expect(zones[0]!.progress?.blocked).toBe(1);
    expect(zones[0]!.chips).toHaveLength(4);
  });

  it("工作未知 zone 的 groupId 是显式哨兵(供计数与降权识别)", () => {
    const zones = partitionTasks([task({ taskId: "orphan", parentTaskId: "ghost" })]);
    expect(zones[0]!.groupId).toBe(UNKNOWN_WORK);
    expect(zones[0]!.title).toBe(UNKNOWN_WORK_TITLE);
  });
});
