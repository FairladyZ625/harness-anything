// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  noAgentRunning,
  relativeAgo,
  workDayGroups,
  workspaceGoalLine,
  workSubgroups,
} from "../src/renderer/model/workspace-narrative.ts";
import type { CadenceFeedEvent } from "../src/renderer/model/cadence.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";

/**
 * 工作页概况的纯派生(原型 v2 概况叙事):「没有 agent 在跑」的判据、按天收束的
 * 进展、子组归属、task_plan 的 Brief 目标行、人读相对时长。全部只消费已取投影,
 * 不做 IO、不新增读面。
 */

const task = (patch: Partial<TaskRow> = {}): TaskRow =>
  ({
    taskId: "task_a",
    title: "任务甲",
    projectId: "p",
    coordinationStatus: "active",
    lastKnownAt: "2026-09-30T10:00:00.000Z",
    gates: [],
    docs: [],
    ...patch,
  }) as TaskRow;

describe("noAgentRunning", () => {
  it("marks active tasks without a lease or active execution", () => {
    expect(noAgentRunning(task())).toBe(true);
  });

  it("keeps leased or executing tasks out of the anomaly", () => {
    expect(noAgentRunning(task({ leaseHolder: "person_x" }))).toBe(false);
    expect(
      noAgentRunning(
        task({
          executions: [{ schema: "execution/v1", executionId: "e1", state: "active" }] as never,
        }),
      ),
    ).toBe(false);
    expect(noAgentRunning(task({ coordinationStatus: "submitted" }))).toBe(false);
    expect(noAgentRunning(task({ coordinationStatus: "done" }))).toBe(false);
  });
});

const event = (patch: Partial<CadenceFeedEvent>): CadenceFeedEvent => ({
  key: `${patch.type}:${patch.taskId}:${patch.at}`,
  type: "execution_started",
  at: "2026-09-30T08:00:00.000Z",
  revision: 1,
  taskId: "task_a",
  factId: null,
  decisionId: null,
  executorId: null,
  touchedPaths: [],
  gateId: null,
  gateResult: null,
  reviewVerdict: null,
  summary: null,
  ...patch,
});

describe("workDayGroups", () => {
  const titles = new Map([
    ["task/task_a", "任务甲"],
    ["task/task_b", "任务乙"],
  ]);

  it("collapses each day into per-task paths with curated steps, newest day first", () => {
    const groups = workDayGroups({
      events: [
        event({ type: "execution_started", at: "2026-09-30T02:05:00.000Z", taskId: "task_a" }),
        event({ type: "execution_submitted", at: "2026-09-30T03:00:00.000Z", taskId: "task_a" }),
        event({ type: "fact_recorded", at: "2026-09-30T03:30:00.000Z", taskId: "task_b" }),
        event({ type: "fact_recorded", at: "2026-09-30T03:40:00.000Z", taskId: "task_b" }),
        event({ type: "review_recorded", at: "2026-09-29T09:00:00.000Z", taskId: "task_b", reviewVerdict: "approved" }),
        event({ type: "task_completed", at: "2026-09-29T10:00:00.000Z", taskId: "task_b" }),
      ],
      titles,
      dateKeyOf: (iso) => iso.slice(0, 10),
    });
    expect(groups.map(({ dateKey }) => dateKey)).toEqual(["2026-09-30", "2026-09-29"]);
    const today = groups[0]!;
    expect(today.paths.map(({ taskId }) => taskId)).toEqual(["task_a", "task_b"]);
    expect(today.paths[0]?.steps).toEqual(["start", "submit"]);
    expect(today.paths[0]?.title).toBe("任务甲");
    // 连续同类事件收成一步:两条事实只留一个「事实」步。
    expect(today.paths[1]?.steps).toEqual(["fact"]);
    expect(today.counts).toEqual({ completed: 0, submitted: 1, rejected: 0, returned: 0 });
    const yesterday = groups[1]!;
    expect(yesterday.paths[0]?.steps).toEqual(["approved", "completed"]);
    expect(yesterday.counts.completed).toBe(1);
  });

  it("counts friction and drops events without a member task or a curated step", () => {
    const groups = workDayGroups({
      events: [
        event({ type: "submission_returned", at: "2026-09-30T01:00:00.000Z", taskId: "task_a" }),
        event({
          type: "review_recorded",
          at: "2026-09-30T01:30:00.000Z",
          taskId: "task_a",
          reviewVerdict: "changes_requested",
        }),
        event({ type: "vertical_thing_happened", at: "2026-09-30T02:00:00.000Z", taskId: "task_a" }),
        event({ type: "task_completed", at: "2026-09-30T02:30:00.000Z", taskId: null as never }),
      ],
      titles,
      dateKeyOf: (iso) => iso.slice(0, 10),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.paths[0]?.steps).toEqual(["returned", "rejected"]);
    expect(groups[0]!.counts).toEqual({ completed: 0, submitted: 0, rejected: 1, returned: 1 });
  });

  it("maps dispatch, gate and reopen events into steps", () => {
    const groups = workDayGroups({
      events: [
        event({ type: "runtime_session_started", at: "2026-09-30T01:00:00.000Z", taskId: "task_a" }),
        event({
          type: "completion_gate_verified",
          at: "2026-09-30T01:10:00.000Z",
          taskId: "task_a",
          gateResult: "fail",
        }),
        event({ type: "task_reopened", at: "2026-09-30T01:20:00.000Z", taskId: "task_a" }),
      ],
      titles,
      dateKeyOf: (iso) => iso.slice(0, 10),
    });
    expect(groups[0]!.paths[0]?.steps).toEqual(["dispatch", "gateFail", "reopened"]);
  });
});

describe("workSubgroups", () => {
  it("files each leaf under its nearest subgroup below the root, loose leaves first", () => {
    const subgroups = workSubgroups({
      rootTaskId: "root",
      groups: [
        { taskId: "g1", parentTaskId: "root", title: "子组一" },
        { taskId: "g2", parentTaskId: "g1", title: "孙组二" },
      ],
      leaves: [
        { taskId: "loose", parentTaskId: "root", status: "planned" },
        { taskId: "a1", parentTaskId: "g1", status: "active" },
        { taskId: "a2", parentTaskId: "g1", status: "done" },
        { taskId: "b1", parentTaskId: "g2", status: "submitted" },
      ],
    });
    expect(subgroups.map(({ key }) => key)).toEqual(["_loose", "g1", "g2"]);
    const [loose, g1, g2] = subgroups;
    expect(loose?.loose).toBe(true);
    expect(loose?.memberTaskIds).toEqual(["loose"]);
    expect(g1?.depth).toBe(0);
    expect(g1?.counts).toEqual({ active: 1, done: 1 });
    expect(g1?.inFlight).toBe(1);
    expect(g2?.depth).toBe(1);
    expect(g2?.counts).toEqual({ submitted: 1 });
  });

  it("orders subgroups with unfinished work before finished ones", () => {
    const subgroups = workSubgroups({
      rootTaskId: "root",
      groups: [
        { taskId: "gDone", parentTaskId: "root", title: "全部完成" },
        { taskId: "gLive", parentTaskId: "root", title: "还有未完成" },
      ],
      leaves: [
        { taskId: "d1", parentTaskId: "gDone", status: "done" },
        { taskId: "d2", parentTaskId: "gDone", status: "done" },
        { taskId: "l1", parentTaskId: "gLive", status: "active" },
      ],
    });
    expect(subgroups.map(({ key }) => key)).toEqual(["gLive", "gDone"]);
  });
});

describe("workspaceGoalLine", () => {
  it("takes the Brief section of the task plan", () => {
    const body = "# 标题\n\n## Brief\n\n按原型 v2 重做工作页。\n\n范围包括顶部与标签栏。\n\n## Goal\n\n别的内容。\n";
    expect(workspaceGoalLine(body)).toBe("按原型 v2 重做工作页。\n\n范围包括顶部与标签栏。");
  });

  it("returns null without a Brief section or with an empty one", () => {
    expect(workspaceGoalLine("# 标题\n\n## Goal\n\n没有 Brief。\n")).toBeNull();
    expect(workspaceGoalLine("## Brief\n\n## Goal\n\n空的。\n")).toBeNull();
    expect(workspaceGoalLine("")).toBeNull();
  });
});

describe("relativeAgo", () => {
  const now = "2026-09-30T12:00:00.000Z";
  it("uses minutes under an hour, hours under two days, then days", () => {
    expect(relativeAgo("2026-09-30T11:40:00.000Z", now)).toEqual({ count: 20, unit: "minute" });
    expect(relativeAgo("2026-09-30T11:59:40.000Z", now)).toEqual({ count: 1, unit: "minute" });
    expect(relativeAgo("2026-09-30T09:00:00.000Z", now)).toEqual({ count: 3, unit: "hour" });
    expect(relativeAgo("2026-09-27T12:00:00.000Z", now)).toEqual({ count: 3, unit: "day" });
  });
});
