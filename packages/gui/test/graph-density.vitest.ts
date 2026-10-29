// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { FactRef, TaskRow } from "../src/renderer/model/types.ts";
import { applyTerritoryDensity, partitionForSkel } from "../src/renderer/graph/territory.ts";
import { selectGraphFocusSet } from "../src/renderer/graph/focusSet.ts";
import { graphDensityForLens, graphFocusAppliesToLens } from "../src/renderer/graph/useGraphDensity.ts";
import {
  graphDensityPreferenceStorage,
  readGraphDensityFocusMode,
  writeGraphDensityFocusMode,
} from "../src/renderer/graph-density-preferences.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

/**
 * 密度分层(task_5ba031c2):重点集落进领地 = 每块只留重点 chip,其余折叠成
 * 「重点外 N 项」徽章;pinned 永不折叠;坏偏好值回落默认(开)。
 */

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
    lastKnownAt: "2026-08-29T00:00:00.000Z",
    gates: [],
    docs: [],
    ...projectedTaskFields(overrides.coordinationStatus ?? "active", {
      archived: (overrides.packageDisposition ?? "active") !== "active",
    }),
    ...overrides,
  } as TaskRow;
}

const memory = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
};

describe("重点模式偏好(localStorage,坏值回落默认开)", () => {
  it("未设 / 坏 JSON / 非布尔值都回落默认(开);只有显式 false 才关", () => {
    const storage = memory();
    expect(readGraphDensityFocusMode(storage)).toBe(true);
    storage.setItem("harness:gui:graph-density-focus-mode", "{not json");
    expect(readGraphDensityFocusMode(storage)).toBe(true);
    storage.setItem("harness:gui:graph-density-focus-mode", JSON.stringify("yes"));
    expect(readGraphDensityFocusMode(storage)).toBe(true);
    storage.setItem("harness:gui:graph-density-focus-mode", JSON.stringify(false));
    expect(readGraphDensityFocusMode(storage)).toBe(false);
  });

  it("无存储(非 DOM 环境)与写失败都不挡视图", () => {
    expect(readGraphDensityFocusMode(null)).toBe(true);
    expect(() => writeGraphDensityFocusMode(null, false)).not.toThrow();
    expect(() => writeGraphDensityFocusMode(graphDensityPreferenceStorage(), false)).not.toThrow();
  });
});

describe("重点模式只作用于任务/全域镜头(事实/决策全量显示)", () => {
  it("事实/决策镜头恒为全量;任务/全域跟随持久化偏好", () => {
    for (const lens of ["fact", "decision"] as const) {
      expect(graphFocusAppliesToLens(lens)).toBe(false);
      expect(graphDensityForLens(lens, "focus")).toBe("all");
      expect(graphDensityForLens(lens, "all")).toBe("all");
    }
    for (const lens of ["task", "unified"] as const) {
      expect(graphFocusAppliesToLens(lens)).toBe(true);
      expect(graphDensityForLens(lens, "focus")).toBe("focus");
      expect(graphDensityForLens(lens, "all")).toBe("all");
    }
  });

  it("事实镜头整块可见:老的、未置顶 fact 也不会被折进重点外", () => {
    const fact = (factId: string, at: string): FactRef => ({
      anchor: `fact/${factId}`,
      category: "finding",
      text: factId,
      at,
      confidence: "high",
    });
    const old = fact("F-old", "2026-07-01T00:00:00.000Z");
    const recent = fact("F-recent", "2026-08-20T00:00:00.000Z");
    const partition = partitionForSkel("fact", [], [], [old, recent], [], []);
    const applied = applyTerritoryDensity(partition, null, new Set());
    const refs = applied.zones.flatMap((zone) => zone.chips.map((chip) => chip.navRef));
    expect(refs).toContain("fact/F-old");
    expect(refs).toContain("fact/F-recent");
    expect(applied.deferredCount).toBeUndefined();
  });
});

describe("applyTerritoryDensity(重点集 → 领地块)", () => {
  const NOW = "2026-08-30T00:00:00.000Z";
  const pinned = task("t_pin", {
    pinned: true,
    coordinationStatus: "done",
    rawStatus: "done",
    lastKnownAt: "2026-01-01T00:00:00.000Z",
  });
  const cold = task("t_cold", {
    coordinationStatus: "done",
    rawStatus: "done",
    lastKnownAt: "2026-01-01T00:00:00.000Z",
  });
  const live = task("t_live");

  function focusOf(tasks: readonly TaskRow[]) {
    return selectGraphFocusSet({ tasks, relations: [], now: NOW });
  }

  it("阴性对照:未 pin 的冷任务被折叠;pinned 与在飞 task 保留", () => {
    const tasks = [pinned, cold, live];
    const partition = partitionForSkel("task", tasks);
    const applied = applyTerritoryDensity(partition, focusOf(tasks), new Set());
    const refs = applied.zones.flatMap((zone) => zone.chips.map((chip) => chip.navRef));
    expect(refs).toContain("task/t_pin");
    expect(refs).toContain("task/t_live");
    expect(refs).not.toContain("task/t_cold");
    expect(applied.deferredCount).toBe(1);
  });

  it("pinned 永不被折叠 —— 即便它是唯一的冷任务", () => {
    const tasks = [pinned, cold];
    const applied = applyTerritoryDensity(partitionForSkel("task", tasks), focusOf(tasks), new Set());
    const refs = applied.zones.flatMap((zone) => zone.chips.map((chip) => chip.navRef));
    expect(refs).toContain("task/t_pin");
    expect(applied.deferredCount).toBe(1);
  });

  it("点击徽章(该块进 revealedZones)后回到全量;focus=null 时原样返回", () => {
    const tasks = [cold, live];
    const partition = partitionForSkel("task", tasks);
    const deferred = applyTerritoryDensity(partition, focusOf(tasks), new Set());
    expect(deferred.deferredCount).toBe(1);
    const revealed = applyTerritoryDensity(
      partition,
      focusOf(tasks),
      new Set(deferred.zones.map((zone) => zone.zoneId)),
    );
    expect(revealed.deferredCount).toBe(0);
    expect(revealed.zones.flatMap((zone) => zone.chips.map((chip) => chip.navRef))).toContain("task/t_cold");
    // 未开重点模式:不做任何隐藏。
    expect(applyTerritoryDensity(partition, null, new Set())).toEqual(partition);
  });
});
