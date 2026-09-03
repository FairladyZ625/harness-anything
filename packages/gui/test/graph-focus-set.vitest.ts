// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { RelationEdge, TaskRow } from "../src/renderer/model/types.ts";
import { isTaskGraphFocusSeed } from "../src/renderer/model/taskFilters.ts";
import { selectGraphFocusSet, isInGraphFocusSet } from "../src/renderer/graph/focusSet.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

/**
 * 关系图「重点模式」的重点集(task_5ba031c2)。
 * 判定本体 isTaskGraphFocusSeed 在 model 层(与看板共用);一跳闭包在 graph 层。
 * 阴性对照是本任务验收硬项:未 pin 的冷任务在重点模式下必须被折叠。
 */

const NOW = "2026-08-30T00:00:00.000Z";

function task(taskId: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId,
    title: taskId,
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "gui",
    lastKnownAt: "2026-08-29T00:00:00.000Z",
    gates: [],
    docs: [],
    ...projectedTaskFields(overrides.coordinationStatus ?? "active", {
      archived: (overrides.packageDisposition ?? "active") !== "active",
    }),
    ...overrides,
  } as TaskRow;
}

describe("isTaskGraphFocusSeed(重点种子判定,与看板共用)", () => {
  it("pinned task 恒为种子 —— 即便已归档、已取消、冷了很久", () => {
    expect(isTaskGraphFocusSeed(task("t1", { pinned: true }), NOW)).toBe(true);
    expect(
      isTaskGraphFocusSeed(
        task("t1", {
          pinned: true,
          coordinationStatus: "cancelled",
          rawStatus: "cancelled",
          lastKnownAt: "2026-01-01T00:00:00.000Z",
        }),
        NOW,
      ),
    ).toBe(true);
    expect(
      isTaskGraphFocusSeed(
        task("t1", { pinned: true, packageDisposition: "archived", lastKnownAt: "2026-01-01T00:00:00.000Z" }),
        NOW,
      ),
    ).toBe(true);
  });

  it("非终态 task(planned/active/blocked/in_review/unknown)是种子", () => {
    for (const status of ["planned", "active", "blocked", "in_review", "unknown"] as const) {
      expect(isTaskGraphFocusSeed(task("t1", { coordinationStatus: status, rawStatus: status }), NOW)).toBe(true);
    }
  });

  it("最近变更窗口内的终态 task 是种子(刚收口的 done 要看得见)", () => {
    expect(
      isTaskGraphFocusSeed(
        task("t1", { coordinationStatus: "done", rawStatus: "done", lastKnownAt: "2026-08-20T00:00:00.000Z" }),
        NOW,
      ),
    ).toBe(true);
  });

  it("阴性对照:未 pin 的冷任务(终态 + 超窗 + 非归档噪音)不是种子", () => {
    expect(
      isTaskGraphFocusSeed(
        task("t1", { coordinationStatus: "done", rawStatus: "done", lastKnownAt: "2026-08-01T00:00:00.000Z" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("归档噪音(非 active disposition / cancelled)除 pinned 外不是种子", () => {
    expect(isTaskGraphFocusSeed(task("t1", { packageDisposition: "archived" }), NOW)).toBe(false);
    expect(isTaskGraphFocusSeed(task("t1", { coordinationStatus: "cancelled", rawStatus: "cancelled" }), NOW)).toBe(
      false,
    );
  });
});

describe("selectGraphFocusSet(种子 + 一跳非 task 邻域)", () => {
  const pinned = task("t_pin", { pinned: true, lastKnownAt: "2026-01-01T00:00:00.000Z" });
  const live = task("t_live");
  const cold = task("t_cold", {
    coordinationStatus: "done",
    rawStatus: "done",
    lastKnownAt: "2026-01-01T00:00:00.000Z",
  });
  const relations = [
    // 种子 task 的非 task 邻居:进重点集。
    { from: "decision/dec_seed", to: "task/t_live", kind: "derives", provenance: "local-document" },
    { from: "task/t_live", to: "fact/F-live", kind: "produces", provenance: "local-document" },
    { from: "agent/luna", to: "task/t_live", kind: "dispatches", provenance: "local-document" },
    { from: "schedule/sweep", to: "agent/luna", kind: "dispatches", provenance: "local-document" },
    // 冷 task 的邻居不进;task↔task 边(父子)刻意不扩 —— 扩了 PLT-Ontology 一跳就是整棵子树。
    { from: "task/t_live", to: "task/t_cold", kind: "depends-on", provenance: "local-document" },
    { from: "decision/dec_cold", to: "task/t_cold", kind: "derives", provenance: "local-document" },
  ] as RelationEdge[];

  it("种子 = pinned ∪ 非终态 ∪ 最近变更;不含冷任务", () => {
    const selection = selectGraphFocusSet({ tasks: [pinned, live, cold], relations, now: NOW });
    expect([...selection.taskIds].sort()).toEqual(["t_live", "t_pin"]);
    expect(selection.seedCount).toBe(2);
  });

  it("邻域 = 种子的一跳非 task 邻居(decision/fact/agent/schedule);冷任务的邻居不进", () => {
    const selection = selectGraphFocusSet({ tasks: [pinned, live, cold], relations, now: NOW });
    expect([...selection.neighborIds].sort()).toEqual(["agent/luna", "decision/dec_seed", "fact/F-live"]);
    expect(isInGraphFocusSet(selection, "task/t_live")).toBe(true);
    expect(isInGraphFocusSet(selection, "agent/luna")).toBe(true);
    expect(isInGraphFocusSet(selection, "task/t_cold")).toBe(false);
    expect(isInGraphFocusSet(selection, "decision/dec_cold")).toBe(false);
  });

  it("一跳邻域不沿 task↔task 边扩散(父子边只到第一个 task 为止)", () => {
    const selection = selectGraphFocusSet({ tasks: [live, cold], relations, now: NOW });
    expect(isInGraphFocusSet(selection, "task/t_cold")).toBe(false);
  });

  it("schedule 经它声明的 target agent 收进邻域(schedule↔task 没有直接边)", () => {
    const schedules = [
      { id: "schedule/sweep", name: "sweep", sub: "armed · 1h", targetAgentId: "luna" },
      { id: "schedule/idle", name: "idle", sub: "armed · 1d", targetAgentId: "nobody" },
    ];
    const selection = selectGraphFocusSet({ tasks: [live, cold], relations, now: NOW, schedules });
    expect(isInGraphFocusSet(selection, "schedule/sweep")).toBe(true);
    // target agent 不在邻域 → 该 schedule 不进重点集。
    expect(isInGraphFocusSet(selection, "schedule/idle")).toBe(false);
  });
});
