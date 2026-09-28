// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import {
  clusterTasksByWork,
  deriveZoneProgress,
  NO_WORK,
  NO_WORK_TITLE,
  zoneRank,
} from "../src/renderer/graph/territoryProgress.ts";
import { partitionTasks } from "../src/renderer/graph/territory.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

/**
 * 领地找回「每个工作的进度」+ 独立任务降权。
 * 所属工作只读 daemon 工作索引盖在行上的 workId:独立任务只沉底,不隐藏,renderer 不沿父链猜归属。
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
    task({ taskId: "root_1", title: "工作一", workId: "root_1", coordinationStatus: "active" }),
    task({
      taskId: "c1",
      title: "子一",
      parentTaskId: "root_1",
      workId: "root_1",
      workTitle: "工作一",
      coordinationStatus: "done",
    }),
    task({
      taskId: "c2",
      title: "子二",
      parentTaskId: "root_1",
      workId: "root_1",
      workTitle: "工作一",
      coordinationStatus: "active",
    }),
    task({
      taskId: "c3",
      title: "子三",
      parentTaskId: "root_1",
      workId: "root_1",
      workTitle: "工作一",
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
  it("同一 workId 的任务聚成一块,标题取 workTitle", () => {
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

  it("嵌套的声明工作按 daemon 给的 workId 自成一块,不并进外层工作", () => {
    const clusters = clusterTasksByWork([
      task({ taskId: "outer", title: "外层", workId: "outer", workTitle: "外层" }),
      task({ taskId: "group", parentTaskId: "outer", workId: "outer", workTitle: "外层" }),
      task({ taskId: "inner", title: "内层", parentTaskId: "group", workId: "inner", workTitle: "内层" }),
      task({ taskId: "inner_leaf", parentTaskId: "inner", workId: "inner", workTitle: "内层" }),
    ]);
    expect(Object.fromEntries(clusters.map((c) => [c.rootId, c.tasks.map((t) => t.taskId).sort()]))).toEqual({
      outer: ["group", "outer"],
      inner: ["inner", "inner_leaf"],
    });
  });

  it("没有 workId 的任务归入独立任务块;父链可见也不自己上溯", () => {
    const clusters = clusterTasksByWork([
      ...workFixture(),
      task({ taskId: "solo", title: "独立" }),
      task({ taskId: "under_solo", parentTaskId: "root_1" }),
    ]);
    const standalone = clusters.find((c) => c.rootId === NO_WORK);
    expect(standalone).toBeDefined();
    expect(standalone!.title).toBe(NO_WORK_TITLE);
    expect(standalone!.progress.noWork).toBe(true);
    expect(standalone!.tasks.map((t) => t.taskId).sort()).toEqual(["solo", "under_solo"]);
  });

  it("独立任务块恒排最后 —— 降权,但不隐藏", () => {
    const clusters = clusterTasksByWork([task({ taskId: "solo", title: "独立" }), ...workFixture()]);
    expect(clusters.at(-1)!.rootId).toBe(NO_WORK);
  });
});

describe("块排序权重", () => {
  it("有阻塞的块排最前,基本完工的沉后,独立任务垫底", () => {
    const blocked = zoneRank(deriveZoneProgress([task({ coordinationStatus: "blocked" })]));
    const running = zoneRank(deriveZoneProgress([task({ coordinationStatus: "active" })]));
    const mostlyDone = zoneRank(deriveZoneProgress([task({ coordinationStatus: "done" })]));
    const noWork = zoneRank(deriveZoneProgress([task()], true));
    expect(blocked).toBeLessThan(running);
    expect(running).toBeLessThan(mostlyDone);
    expect(mostlyDone).toBeLessThan(noWork);
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

  it("独立任务 zone 的 groupId 是显式哨兵(供计数与降权识别)", () => {
    const zones = partitionTasks([task({ taskId: "solo" })]);
    expect(zones[0]!.groupId).toBe(NO_WORK);
    expect(zones[0]!.title).toBe(NO_WORK_TITLE);
  });
});
