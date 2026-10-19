// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { sessionWorkGroups, type SessionGroup } from "../src/renderer/sessions-model.ts";
import type { WorkIndex, WorkRef } from "../src/renderer/model/work-collections.ts";

/**
 * 会话页「工作 → 任务 → 会话」的纯派生(task_4b83acdd):
 * - 工作不是 daemon 的 groupBy:读面仍按 task 取组,前端只用常驻工作索引归桶;
 * - 无工作归属的任务组落「散件」桶,不是丢掉;
 * - Decision 评审组没有 taskId,单独成桶,不混进散件冒充任务。
 */

const taskGroup = (taskId: string, overrides: Partial<SessionGroup> = {}): SessionGroup => ({
  key: taskId,
  kind: "task",
  label: `Task ${taskId}`,
  taskId,
  latestStatus: "succeeded",
  latestActivityAt: "2026-10-18T10:00:00.000Z",
  runningCount: 0,
  sessionCount: 1,
  roundCount: 1,
  latestRound: null,
  ...overrides,
});

const decisionGroup: SessionGroup = {
  key: "dec_review",
  kind: "decision",
  label: "dec_review",
  decisionId: "dec_review",
  latestStatus: "running",
  latestActivityAt: "2026-10-19T12:00:00.000Z",
  runningCount: 1,
  sessionCount: 2,
  roundCount: 2,
  latestRound: null,
};

const workIndex = (entries: Readonly<Record<string, WorkRef>>, ready = true): WorkIndex => ({
  ready,
  hasWorks: Object.keys(entries).length > 0,
  isWorkRoot: (taskId) => Object.values(entries).some((work) => work.taskId === taskId),
  workOf: (taskId) => entries[taskId] ?? null,
});

const NO_WORK_INDEX: WorkIndex = {
  ready: false,
  hasWorks: false,
  isWorkRoot: () => false,
  workOf: () => null,
};

describe("会话页:工作层派生", () => {
  it("把任务组归到工作根下,按在跑优先、最新活动排序,并保留任务组原顺序", () => {
    const workA: WorkRef = { taskId: "task-work-a", title: "Work A" };
    const workB: WorkRef = { taskId: "task-work-b", title: "Work B" };
    const groups = [
      taskGroup("task-a1", {
        latestActivityAt: "2026-10-19T09:00:00.000Z",
        latestStatus: "running",
        runningCount: 1,
        sessionCount: 3,
        roundCount: 4,
      }),
      taskGroup("task-a2", { latestActivityAt: "2026-10-18T09:00:00.000Z", sessionCount: 2 }),
      taskGroup("task-b1", { latestActivityAt: "2026-10-19T10:00:00.000Z" }),
      taskGroup("task-loose", { latestActivityAt: "2026-10-17T10:00:00.000Z" }),
      decisionGroup,
    ];
    const buckets = sessionWorkGroups(groups, workIndex({ "task-a1": workA, "task-a2": workA, "task-b1": workB }));

    expect(buckets.map((bucket) => bucket.kind)).toEqual(["work", "work", "decision", "loose"]);
    expect(buckets.map((bucket) => bucket.key)).toEqual([
      "work:task-work-a",
      "work:task-work-b",
      "decision-review",
      "loose",
    ]);
    // 在跑的 Work A 排在活动更新的 Work B 前面。
    expect(buckets[0]!.label).toBe("Work A");
    expect(buckets[0]!.taskGroups.map((group) => group.key)).toEqual(["task-a1", "task-a2"]);
    expect(buckets[0]!.taskCount).toBe(2);
    expect(buckets[0]!.sessionCount).toBe(5);
    expect(buckets[0]!.roundCount).toBe(5);
    expect(buckets[0]!.runningCount).toBe(1);
    expect(buckets[0]!.latestStatus).toBe("running");
    expect(buckets[2]!.taskGroups.map((group) => group.key)).toEqual(["dec_review"]);
    expect(buckets[3]!.taskGroups.map((group) => group.key)).toEqual(["task-loose"]);
  });

  it("没有工作索引时任务组全部落散件,decision 组仍单独成桶", () => {
    const buckets = sessionWorkGroups([taskGroup("task-a"), taskGroup("task-b"), decisionGroup], NO_WORK_INDEX);
    expect(buckets.map((bucket) => bucket.kind)).toEqual(["decision", "loose"]);
    expect(buckets[1]!.taskGroups.map((group) => group.key)).toEqual(["task-a", "task-b"]);
    expect(buckets[1]!.workTaskId).toBeNull();
  });

  it("同一任务组只归一个桶:工作索引命中就不再进散件", () => {
    const work: WorkRef = { taskId: "task-work", title: "Work" };
    const buckets = sessionWorkGroups([taskGroup("task-a")], workIndex({ "task-a": work }));
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.kind).toBe("work");
    expect(buckets[0]!.workTaskId).toBe("task-work");
  });
});
